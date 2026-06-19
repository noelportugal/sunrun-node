'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const fs = require('fs')
const path = require('path')
const SunRun = require('../src/index.js')

// An in-memory token store so tests never touch disk.
function memStore(seed = {}) {
  const data = { ...seed }
  return { get: (k) => (k in data ? data[k] : null), set: (k, v) => { data[k] = v }, _data: data }
}

// Swap global.fetch for a queue of canned responses; returns captured calls.
function withFetch(responses, fn) {
  const calls = []
  const orig = global.fetch
  let i = 0
  global.fetch = async (url, opts) => {
    calls.push({ url, opts })
    const r = responses[Math.min(i++, responses.length - 1)]
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      statusText: r.statusText || 'OK',
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null)),
    }
  }
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = orig })
}

// --- pure helpers ----------------------------------------------------------

const SERIES = {
  a: { timestamp: '2026-05-01', deliveredKwh: 30, cumulativeKwh: 1000 },
  b: { timestamp: '2026-06-17', deliveredKwh: 41.4, cumulativeKwh: 1971 },
  c: { timestamp: '2026-06-18', deliveredKwh: 32.6, cumulativeKwh: 2003 },
}

test('summarize picks today/yesterday and computes totals + CO2', () => {
  const s = SunRun.summarize(SERIES)
  assert.equal(s.todayKwh, 32.6)
  assert.equal(s.yesterdayKwh, 41.4)
  assert.equal(s.allTimeKwh, 2003)
  // 2003 kWh * 0.709 kg/kWh ≈ 1420 kg ≈ 1.4 t
  assert.equal(s.co2AvoidedKg, 1420)
  assert.equal(s.co2AvoidedTons, 1.4)
  assert.equal(s.asOf, '2026-06-18')
})

test('summarize returns null for empty data', () => {
  assert.equal(SunRun.summarize({}), null)
  assert.equal(SunRun.summarize(null), null)
})

test('summarize sorts unordered input by timestamp', () => {
  const s = SunRun.summarize({ c: SERIES.c, a: SERIES.a, b: SERIES.b })
  assert.equal(s.todayKwh, 32.6)        // c is latest regardless of key order
  assert.equal(s.yesterdayKwh, 41.4)    // b is second-latest
})

test('equivalents renders selected factors with an Oxford "and"', () => {
  const text = SunRun.equivalents(8887, ['gallons_gas', 'miles_driven'])
  assert.match(text, /1,000 gallons of gasoline and [\d,]+ miles not driven/)
})

test('equivalents ignores unknown factors', () => {
  assert.equal(SunRun.equivalents(1000, ['bogus']), '')
})

// --- auth + production over a mocked API ------------------------------------

test('requestPasswordless stores the request token', async () => {
  const store = memStore()
  const sr = new SunRun({ phone: '+15551234567', tokenStore: store })
  await withFetch([{ body: { token: 'REQ123' } }], async (calls) => {
    const ok = await sr.requestPasswordless()
    assert.equal(ok, true)
    assert.equal(store.get('requestToken'), 'REQ123')
    assert.equal(store.get('phone'), '+15551234567')
    assert.match(calls[0].url, /\/portal-auth\/request-passwordless$/)
  })
})

test('requestPasswordless throws without a phone', async () => {
  const sr = new SunRun({ tokenStore: memStore() })
  await assert.rejects(() => sr.requestPasswordless(), /phone is required/)
})

test('verifyCode caches accessToken + prospectId + ptoDate', async () => {
  const store = memStore({ requestToken: 'REQ123', phone: '+15551234567' })
  const sr = new SunRun({ tokenStore: store })
  const resp = {
    body: {
      data: { accessToken: 'ACCESS999' },
      opportunitiesWithContracts: [{ prospect_id: 'P42', contract: { ptoDate: '2019-03-15' } }],
    },
  }
  await withFetch([resp], async (calls) => {
    const out = await sr.verifyCode('654321')
    assert.deepEqual(out, { prospectId: 'P42', ptoDate: '2019-03-15' })
    assert.equal(store.get('accessToken'), 'ACCESS999')
    assert.equal(store.get('prospectId'), 'P42')
    assert.equal(store.get('startDate'), '2019-03-15')
    assert.equal(calls[0].opts.headers.Authorization, 'REQ123')
  })
})

test('verifyCode without a pending request throws', async () => {
  const sr = new SunRun({ tokenStore: memStore() })
  await assert.rejects(() => sr.verifyCode('111'), /no pending request/)
})

test('getCumulativeProduction requires authorization', async () => {
  const sr = new SunRun({ tokenStore: memStore() })
  await assert.rejects(() => sr.getCumulativeProduction(), /not authorized/)
})

test('getCumulativeProduction sends the access token and returns data', async () => {
  const store = memStore({ accessToken: 'ACCESS999', prospectId: 'P42', startDate: '2019-03-15' })
  const sr = new SunRun({ tokenStore: store })
  await withFetch([{ body: SERIES }], async (calls) => {
    const data = await sr.getCumulativeProduction()
    assert.equal(Object.keys(data).length, 3)
    assert.match(calls[0].url, /cumulative-production\/daily\/P42\?/)
    assert.equal(calls[0].opts.headers.Authorization, 'ACCESS999')
  })
})

test('a 401 surfaces a clear re-auth message', async () => {
  const store = memStore({ accessToken: 'STALE', prospectId: 'P42' })
  const sr = new SunRun({ tokenStore: store })
  await withFetch([{ ok: false, status: 401, body: { message: 'Unauthorized' } }], async () => {
    await assert.rejects(() => sr.getCumulativeProduction(), /access token expired\/invalid/)
  })
})

test('getDailyBriefing produces a friendly sentence', async () => {
  const store = memStore({ accessToken: 'ACCESS999', prospectId: 'P42' })
  const sr = new SunRun({ tokenStore: store })
  await withFetch([{ body: SERIES }], async () => {
    const text = await sr.getDailyBriefing(['gallons_gas'])
    assert.match(text, /32\.6 kWh today/)
    assert.match(text, /2,003 kWh all-time/)
    assert.match(text, /gallons of gasoline/)
  })
})

// --- FileTokenStore --------------------------------------------------------

test('FileTokenStore round-trips through a real file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sunrun-'))
  const file = path.join(dir, 'nested', 'state.json')
  const store = new SunRun.FileTokenStore(file)
  assert.equal(store.get('missing'), null)
  store.set('accessToken', 'X')
  // fresh instance reads what the first wrote
  const reopened = new SunRun.FileTokenStore(file)
  assert.equal(reopened.get('accessToken'), 'X')
  fs.rmSync(dir, { recursive: true, force: true })
})
