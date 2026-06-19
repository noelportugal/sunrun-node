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

// --- energy flow / battery / system (pure normalizers) ---------------------

test('normalizeFlow names fields and flips export sign', () => {
  const rows = [
    { timestamp: '2026-06-12', solar: 27.2, pvSolar: 26.5, systemProduction: 26.5,
      consumption: 27.4, importReading: 3.4, exportReading: -2.59, selfConsumption: 23.9, batterySolar: 27.2 },
    { timestamp: '2026-06-13', solar: 35.8, pvSolar: 34.9, consumption: 34.1,
      importReading: 1.3, exportReading: -2.17, selfConsumption: 32.8, batterySolar: 35.8 },
  ]
  const out = SunRun.normalizeFlow(rows)
  assert.equal(out.length, 2)
  assert.equal(out[0].timestamp, '2026-06-12') // sorted ascending
  assert.equal(out[1].gridExportKwh, 2.17)     // abs of negative
  assert.equal(out[1].gridImportKwh, 1.3)
  assert.equal(out[1].pvKwh, 34.9)
})

test('normalizeFlow tolerates junk and missing fields', () => {
  const out = SunRun.normalizeFlow([null, { timestamp: '2026-06-01' }, { solar: 5 }])
  assert.equal(out.length, 1)                   // dropped null + the row without timestamp
  assert.equal(out[0].solarKwh, 0)             // missing → 0, not NaN
})

test('summarizeFlow totals today/yesterday/last30', () => {
  const today = new Date().toISOString().slice(0, 10)
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
  const rows = SunRun.normalizeFlow([
    { timestamp: yday, solar: 28, consumption: 34, importReading: 7, exportReading: -1, selfConsumption: 27 },
    { timestamp: today, solar: 25, consumption: 31, importReading: 8, exportReading: -0.5, selfConsumption: 24 },
  ])
  const s = SunRun.summarizeFlow(rows)
  assert.equal(s.today.solarKwh, 25)
  assert.equal(s.yesterday.consumptionKwh, 34)
  assert.equal(s.last30.solarKwh, 53)          // both within 30d
  assert.equal(s.asOf, today)
})

test('summarizeFlow returns null on empty', () => {
  assert.equal(SunRun.summarizeFlow([]), null)
})

test('normalizeBatteryDaily splits per-unit vs aggregate', () => {
  const groups = [
    { name: 'Battery 1.4', manufacturer: 'LG', model: 'M1', serialNumber: 'S1',
      performanceData: [{ timestamp: '2026-06-18', maxBatteryPercentageState: 93.8, minBatteryPercentageState: 33, batteryCharge: 0, batteryDischarge: 0 }] },
    { name: 'Battery 1.3', manufacturer: 'LG', model: 'M2', serialNumber: 'S2',
      performanceData: [{ timestamp: '2026-06-18', maxBatteryPercentageState: 100, minBatteryPercentageState: 30, batteryCharge: 1.2, batteryDischarge: 2.3 }] },
    { performanceData: [{ timestamp: '2026-06-18', maxBatteryPercentageState: 96, minBatteryPercentageState: 19.8 }] }, // unnamed = aggregate
  ]
  const out = SunRun.normalizeBatteryDaily(groups)
  assert.equal(out.batteries.length, 2)
  assert.equal(out.batteries[0].name, 'Battery 1.4')
  assert.equal(out.batteries[0].daily[0].maxSoc, 93.8)
  assert.equal(out.batteries[1].daily[0].dischargeKwh, 2.3)
  assert.ok(out.aggregate)
  assert.equal(out.aggregate.daily[0].minSoc, 19.8)
})

test('latestBatterySoc averages units and reports lag', () => {
  const old = new Date(Date.now() - 3 * 3600000).toISOString()
  const groups = [
    { name: 'B1', performanceData: [
      { timestamp: new Date(Date.now() - 6 * 3600000).toISOString(), averageBatteryPercentageState: 50 },
      { timestamp: old, averageBatteryPercentageState: 40 }] },
    { name: 'B2', performanceData: [
      { timestamp: old, averageBatteryPercentageState: 20 },
      { timestamp: old, averageBatteryPercentageState: null }] }, // null ignored
  ]
  const s = SunRun.latestBatterySoc(groups)
  assert.equal(s.soc, 30)                       // (40 + 20) / 2
  assert.equal(s.perBattery.length, 2)
  assert.ok(s.lagHours >= 2.9 && s.lagHours <= 3.2)
})

test('normalizeSystemInfo merges offerings + overview', () => {
  const offerings = { system_size: 5.76, system_azimuth: '182.9', ptoDate: '2021-08-18',
    hasSolar: true, hasStorage: true, hasConsumption: true, brightBox: true, lat: '21.6', lon: '-157.9' }
  const overview = [{ data: { site: {
    systemSizeDC: '5.76',
    systemsCharacteristics: { edges: [{ node: { panelMfg: 'Jinko', panelModel: 'JKM320', numPanels: '6' } }] },
    inverter: { edges: [{ node: { name: 'Inverter 1', model: 'SE3800H', serialNumber: '74-50', manufacturer: 'SolarEdge' } }] },
    battery: { edges: [{ node: { name: 'Battery 1.3', model: 'EH153', serialNumber: 'X', manufacturer: 'LG', vendorName: 'SolarEdge' } }] },
  } } }]
  const info = SunRun.normalizeSystemInfo(offerings, overview)
  assert.equal(info.systemSizeKwDc, 5.76)
  assert.equal(info.capabilities.storage, true)
  assert.equal(info.panels[0].count, 6)
  assert.equal(info.inverters[0].manufacturer, 'SolarEdge')
  assert.equal(info.batteries[0].vendor, 'SolarEdge')
  assert.equal(info.location.lat, 21.6)
})

test('normalizeSystemInfo survives a missing overview', () => {
  const info = SunRun.normalizeSystemInfo({ system_size: 5, hasSolar: true }, null)
  assert.equal(info.systemSizeKwDc, 5)
  assert.deepEqual(info.panels, [])
  assert.deepEqual(info.batteries, [])
})
