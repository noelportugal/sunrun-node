'use strict'

/**
 * sunrun-node — unofficial client for the mySunrun production API.
 *
 * Talks to the same gateway.sunrun.com backend the mySunrun portal/app uses.
 * Auth is passwordless: request a one-time code by SMS, verify it once, and the
 * access token + prospectId are cached so later calls just work. Sunrun refreshes
 * production data about once a day, so there's no value in polling more often.
 *
 * v2: zero runtime dependencies (native fetch + Date), a configurable on-disk
 * token store (no more relative ./scratch), and structured production output.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')

const BASE_URL = 'https://gateway.sunrun.com'

// EPA Greenhouse Gas Equivalencies (avoided-emissions constants). Used to turn
// lifetime kWh into friendly, recognizable equivalents without a dependency.
// Source: EPA GHG Equivalencies Calculator.
const KG_CO2_PER_KWH = 0.709        // US national avoided emissions (eGRID)
const EQUIV = {
  // kg CO2 represented by one unit of each
  gallons_gas: 8.887,               // kg CO2 per gallon of gasoline burned
  miles_driven: 0.4031,             // kg CO2 per mile (avg passenger vehicle)
  tree_seedlings_10yr: 60.5,        // kg CO2 sequestered by 1 seedling over 10y
  acres_forest_1yr: 845.5,          // kg CO2 sequestered per acre of forest/year
  homes_electricity_1yr: 5023,      // kg CO2 per home's annual electricity use
}

/** Minimal file-backed key/value store (one JSON file). */
class FileTokenStore {
  constructor(filePath) {
    this.file = filePath
    this._cache = null
  }
  _read() {
    if (this._cache) return this._cache
    try {
      this._cache = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    } catch {
      this._cache = {}
    }
    return this._cache
  }
  get(key) {
    return this._read()[key] ?? null
  }
  set(key, value) {
    const data = this._read()
    data[key] = value
    this._cache = data
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2))
    try { fs.chmodSync(this.file, 0o600) } catch { /* best effort */ }
  }
}

class SunRun {
  /**
   * @param {object} options
   * @param {string} [options.phone]      Phone on file with Sunrun, e.g. "+15551234567".
   * @param {string} [options.statePath]  Token-store file path. Default:
   *                                       ~/.sunrun-node/state.json
   * @param {object} [options.tokenStore] Custom store with get(key)/set(key,val).
   */
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || BASE_URL
    this.phone = options.phone || null
    // The portal stamps date ranges in the site's local offset. Defaults to
    // Hawaii (-10:00) to match the original repo; override for other sites.
    this.tzOffset = options.tzOffset || '-10:00'
    this.store = options.tokenStore ||
      new FileTokenStore(options.statePath ||
        path.join(os.homedir(), '.sunrun-node', 'state.json'))
  }

  // --- low-level HTTP -------------------------------------------------------

  async _fetch(method, endpoint, { auth, body, params } = {}) {
    let url = this.baseUrl + endpoint
    if (params) url += '?' + new URLSearchParams(params).toString()
    const headers = { 'Content-Type': 'application/json' }
    if (auth) headers.Authorization = auth
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    let data = null
    if (text) {
      try { data = JSON.parse(text) } catch { data = text }
    }
    if (!res.ok) {
      const msg = (data && data.message) || res.statusText
      const err = new Error(`${res.status} ${msg}`)
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }

  // --- auth -----------------------------------------------------------------

  /**
   * Request a one-time passwordless code by SMS. Returns true on success.
   * @param {string} [phone] Override the phone set on the constructor.
   */
  async requestPasswordless(phone = this.phone) {
    if (!phone) throw new Error('phone is required (pass it to requestPasswordless or the constructor)')
    this.phone = phone
    const result = await this._fetch('POST', '/portal-auth/request-passwordless', {
      body: { email: null, phone, prospectId: null },
    })
    if (!result || !result.token) return false
    this.store.set('phone', phone)
    this.store.set('requestToken', result.token)
    return true
  }

  /**
   * Verify the SMS code and cache the access token + prospectId.
   * @param {string} code The 6-digit code texted to the phone.
   * @returns {{prospectId: string, ptoDate: string|null}}
   */
  async verifyCode(code) {
    if (!code) throw new Error('code is required')
    const requestToken = this.store.get('requestToken')
    if (!requestToken) throw new Error('no pending request — call requestPasswordless() first')
    const phone = this.phone || this.store.get('phone')

    const result = await this._fetch('POST', '/portal-auth/respond-passwordless', {
      auth: requestToken,
      body: { email: null, phone, code },
    })
    const accessToken = result?.data?.accessToken
    const contract = result?.opportunitiesWithContracts?.[0]
    if (!accessToken || !contract) {
      const err = new Error('verification response missing accessToken/contract')
      err.data = result
      throw err
    }
    this.store.set('accessToken', accessToken)
    this.store.set('prospectId', contract.prospect_id)
    this.store.set('startDate', contract.contract?.ptoDate || null)
    return { prospectId: contract.prospect_id, ptoDate: contract.contract?.ptoDate || null }
  }

  /** Back-compat alias for v1's respondPasswordless(code). */
  async respondPasswordless(code) {
    return this.verifyCode(code)
  }

  /** True once we hold an access token + prospectId. */
  isAuthorized() {
    return Boolean(this.store.get('accessToken') && this.store.get('prospectId'))
  }

  // --- production -----------------------------------------------------------

  /**
   * Fetch the raw cumulative daily production series (PTO date → tomorrow).
   * @returns {object} Map/array of { timestamp, deliveredKwh, cumulativeKwh }.
   */
  async getCumulativeProduction() {
    const accessToken = this.store.get('accessToken')
    const prospectId = this.store.get('prospectId')
    if (!accessToken || !prospectId) {
      throw new Error('not authorized — call requestPasswordless() then verifyCode(code)')
    }
    const startDate = this.store.get('startDate') || '2018-01-01'
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    const ymd = (d) => d.toISOString().slice(0, 10)

    try {
      return await this._fetch(
        'GET',
        `/performance-api/v1/cumulative-production/daily/${prospectId}`,
        {
          auth: accessToken,
          params: {
            startDate: `${startDate}T00:00:00.000-10:00`,
            endDate: `${ymd(tomorrow)}T23:59:59.999-10:00`,
          },
        }
      )
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        throw new Error('access token expired/invalid — re-auth with requestPasswordless() + verifyCode()')
      }
      throw e
    }
  }

  /**
   * Structured summary of production: today / yesterday / last 30 days /
   * all-time kWh, plus avoided CO₂.
   * @returns {object|null}
   */
  async getProductionSummary() {
    const data = await this.getCumulativeProduction()
    return SunRun.summarize(data)
  }

  /** Pure helper: turn a raw production series into a summary. */
  static summarize(data) {
    const rows = Object.values(data || {}).filter((r) => r && r.timestamp)
    if (!rows.length) return null
    rows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    const today = rows[rows.length - 1]
    const yesterday = rows[rows.length - 2] || null
    const cutoff = Date.now() - 30 * 86400000
    const last30 = rows
      .filter((r) => new Date(r.timestamp).getTime() > cutoff)
      .reduce((sum, r) => sum + (r.deliveredKwh || 0), 0)
    const allTimeKwh = Math.round(today.cumulativeKwh || 0)
    const co2Kg = allTimeKwh * KG_CO2_PER_KWH
    return {
      todayKwh: round1(today.deliveredKwh || 0),
      yesterdayKwh: yesterday ? round1(yesterday.deliveredKwh || 0) : null,
      last30Kwh: Math.round(last30),
      allTimeKwh,
      co2AvoidedKg: Math.round(co2Kg),
      co2AvoidedTons: round1(co2Kg / 1000),
      asOf: today.timestamp,
    }
  }

  // --- shared helpers -------------------------------------------------------

  /** Authorized GET against gateway, with friendly auth errors. */
  async _authedGet(endpoint, params) {
    const auth = this.store.get('accessToken')
    const prospectId = this.store.get('prospectId')
    if (!auth || !prospectId) {
      throw new Error('not authorized — call requestPasswordless() then verifyCode(code)')
    }
    try {
      return await this._fetch('GET', endpoint, params ? { auth, params } : { auth })
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        throw new Error('access token expired/invalid — re-auth with requestPasswordless() + verifyCode()')
      }
      throw e
    }
  }

  /** Build a {startDate,endDate} param pair in the site's local offset. */
  _range(start, end) {
    const ymd = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10))
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
    const startD = start || (() => { const d = new Date(); d.setDate(d.getDate() - 30); return d })()
    return {
      startDate: `${ymd(startD)}T00:00:00.000${this.tzOffset}`,
      endDate: `${ymd(end || tomorrow)}T23:59:59.999${this.tzOffset}`,
    }
  }

  // --- energy flow (solar + consumption + grid + battery) -------------------

  /**
   * Normalized energy-flow series at the given resolution. Unlike production,
   * each point includes consumption and grid import/export — the whole picture.
   * @param {'minute'|'daily'|'monthly'|'yearly'} [scale='daily']
   * @param {{start?: Date|string, end?: Date|string}} [range]
   * @returns {Array<object>} normalized rows (see normalizeFlow)
   */
  async getEnergyFlow(scale = 'daily', { start, end } = {}) {
    const prospectId = this.store.get('prospectId')
    const ep = `/performance-api/v1/site-production-${scale}/${prospectId}`
    const rows = await this._authedGet(ep, this._range(start, end))
    return SunRun.normalizeFlow(rows)
  }

  /**
   * Whole-home energy summary: today / yesterday / last-30-day totals across
   * solar, consumption and grid import/export.
   * @returns {object|null}
   */
  async getEnergySummary() {
    const rows = await this.getEnergyFlow('daily')
    return SunRun.summarizeFlow(rows)
  }

  /** Pure: map raw site-production rows to a stable, named shape. */
  static normalizeFlow(rows) {
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r && r.timestamp)
      .map((r) => ({
        timestamp: r.timestamp,
        solarKwh: num(r.solar),
        pvKwh: num(r.pvSolar ?? r.systemProduction),
        consumptionKwh: num(r.consumption),
        gridImportKwh: num(r.importReading),
        gridExportKwh: Math.abs(num(r.exportReading)), // raw is negative
        selfConsumptionKwh: num(r.selfConsumption),
        batteryChargeKwh: num(r.batterySolar),
      }))
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
  }

  /** Pure: today/yesterday/last-30 totals from a normalized flow series. */
  static summarizeFlow(rows) {
    if (!rows || !rows.length) return null
    const today = rows[rows.length - 1]
    const yesterday = rows[rows.length - 2] || null
    const cutoff = Date.now() - 30 * 86400000
    const recent = rows.filter((r) => new Date(r.timestamp).getTime() > cutoff)
    const sum = (k) => round1(recent.reduce((s, r) => s + (r[k] || 0), 0))
    const pick = (r) => r && ({
      solarKwh: round1(r.solarKwh), consumptionKwh: round1(r.consumptionKwh),
      gridImportKwh: round1(r.gridImportKwh), gridExportKwh: round1(r.gridExportKwh),
      selfConsumptionKwh: round1(r.selfConsumptionKwh),
    })
    return {
      today: pick(today),
      yesterday: pick(yesterday),
      last30: {
        solarKwh: sum('solarKwh'), consumptionKwh: sum('consumptionKwh'),
        gridImportKwh: sum('gridImportKwh'), gridExportKwh: sum('gridExportKwh'),
        selfConsumptionKwh: sum('selfConsumptionKwh'),
      },
      asOf: today.timestamp,
    }
  }

  // --- battery --------------------------------------------------------------

  /**
   * Battery history: per-unit and combined daily state-of-charge range plus
   * charge/discharge. Sunrun returns one group per physical battery plus a
   * combined pack aggregate (the unnamed group).
   * @param {{start?: Date|string, end?: Date|string}} [range]
   */
  async getBattery({ start, end } = {}) {
    const prospectId = this.store.get('prospectId')
    const groups = await this._authedGet(
      `/performance-api/v1/battery-daily-aggregated/${prospectId}`, this._range(start, end))
    return SunRun.normalizeBatteryDaily(groups)
  }

  /**
   * Latest pack state-of-charge (and per-unit), from the 30-min feed.
   * Sunrun's data lags a few hours, so `lagHours` is reported for honesty.
   * @returns {{soc: number|null, asOf: string|null, lagHours: number|null, perBattery: object[]}}
   */
  async getBatteryStatus() {
    const prospectId = this.store.get('prospectId')
    const d = new Date(); d.setDate(d.getDate() - 2)
    const groups = await this._authedGet(
      `/performance-api/v1/battery-minute/${prospectId}`, this._range(d))
    return SunRun.latestBatterySoc(groups)
  }

  /** Pure: split battery-daily-aggregated groups into per-unit + aggregate. */
  static normalizeBatteryDaily(groups) {
    const g = Array.isArray(groups) ? groups : []
    const mapDaily = (pd) => (pd || []).map((p) => ({
      date: String(p.timestamp).slice(0, 10),
      maxSoc: round1(num(p.maxBatteryPercentageState)),
      minSoc: round1(num(p.minBatteryPercentageState)),
      chargeKwh: round1(num(p.batteryCharge)),
      dischargeKwh: round1(num(p.batteryDischarge)),
    })).sort((a, b) => new Date(a.date) - new Date(b.date))
    const named = g.filter((x) => x.name)
    const agg = g.find((x) => !x.name) || null
    return {
      batteries: named.map((x) => ({
        name: x.name, manufacturer: x.manufacturer || null,
        model: x.model || null, serialNumber: x.serialNumber || null,
        daily: mapDaily(x.performanceData),
      })),
      aggregate: agg ? { daily: mapDaily(agg.performanceData) } : null,
    }
  }

  /** Pure: latest non-null SOC across battery-minute groups → pack average. */
  static latestBatterySoc(groups) {
    const g = Array.isArray(groups) ? groups : []
    const perBattery = []
    let asOf = null
    for (const grp of g) {
      const pts = (grp.performanceData || [])
        .filter((p) => p.averageBatteryPercentageState != null)
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      const last = pts[pts.length - 1]
      if (!last) continue
      perBattery.push({ name: grp.name || null, soc: round1(last.averageBatteryPercentageState) })
      if (!asOf || new Date(last.timestamp) > new Date(asOf)) asOf = last.timestamp
    }
    const soc = perBattery.length
      ? round1(perBattery.reduce((s, b) => s + b.soc, 0) / perBattery.length)
      : null
    const lagHours = asOf ? Math.round(((Date.now() - new Date(asOf)) / 3600000) * 10) / 10 : null
    return { soc, asOf, lagHours, perBattery }
  }

  // --- system / capabilities ------------------------------------------------

  /**
   * System configuration: capabilities (solar/storage/consumption) and
   * hardware inventory (panels, inverters, batteries).
   */
  async getSystemInfo() {
    const prospectId = this.store.get('prospectId')
    const auth = this.store.get('accessToken')
    if (!auth || !prospectId) {
      throw new Error('not authorized — call requestPasswordless() then verifyCode(code)')
    }
    const [offerings, overview] = await Promise.all([
      this._authedGet(`/performance-api/v1/product-offerings/${prospectId}`),
      this._fetch('POST', '/portal-user/system-overview', { auth, body: { prospectId } })
        .catch(() => null),
    ])
    return SunRun.normalizeSystemInfo(offerings, overview)
  }

  /** Pure: merge product-offerings + system-overview into a clean profile. */
  static normalizeSystemInfo(offerings = {}, overview = null) {
    const site = Array.isArray(overview) ? overview[0]?.data?.site : overview?.data?.site
    const edges = (x) => (x?.edges || []).map((e) => e.node).filter(Boolean)
    const chars = edges(site?.systemsCharacteristics)
    const panels = []
    for (const c of chars) {
      panels.push({ manufacturer: c.panelMfg, model: c.panelModel, count: Number(c.numPanels) || 0 })
    }
    return {
      systemSizeKwDc: Number(offerings.system_size) || (site ? Number(site.systemSizeDC) : null),
      azimuth: offerings.system_azimuth != null ? Number(offerings.system_azimuth) : null,
      ptoDate: offerings.ptoDate || null,
      capabilities: {
        solar: !!offerings.hasSolar,
        storage: !!offerings.hasStorage,
        consumption: !!offerings.hasConsumption,
        brightBox: !!offerings.brightBox,
      },
      location: offerings.lat && offerings.lon
        ? { lat: Number(offerings.lat), lon: Number(offerings.lon) }
        : (site?.address ? { lat: Number(site.address.lat), lon: Number(site.address.lon) } : null),
      panels,
      inverters: edges(site?.inverter).map((n) => ({
        name: n.name, model: n.model, serialNumber: n.serialNumber, manufacturer: n.manufacturer,
      })),
      batteries: edges(site?.battery).map((n) => ({
        name: n.name, model: n.model, serialNumber: n.serialNumber,
        manufacturer: n.manufacturer, vendor: n.vendorName,
      })),
    }
  }

  /**
   * Friendly one-paragraph briefing string, with a couple of CO₂ equivalents.
   * @param {string[]} [factors] Which equivalents to include. Any of:
   *   gallons_gas, miles_driven, tree_seedlings_10yr, acres_forest_1yr,
   *   homes_electricity_1yr.
   */
  async getDailyBriefing(factors = ['gallons_gas', 'tree_seedlings_10yr', 'miles_driven']) {
    const s = await this.getProductionSummary()
    if (!s) return 'No production data is available yet.'
    const equivText = SunRun.equivalents(s.co2AvoidedKg, factors)
    const yesterday = s.yesterdayKwh != null ? `, ${s.yesterdayKwh} kWh yesterday` : ''
    return (
      `So far your system has generated ${s.todayKwh} kWh today${yesterday}, ` +
      `${s.last30Kwh} kWh in the last 30 days, and ${s.allTimeKwh.toLocaleString()} kWh ` +
      `all-time. That's roughly ${s.co2AvoidedTons} metric tons of CO₂ avoided` +
      (equivText ? ` — about ${equivText}` : '') + '. Nice work! ☀️'
    )
  }

  /** Human-readable equivalents for a quantity of avoided CO₂ (kg). */
  static equivalents(co2Kg, factors = []) {
    const labels = {
      gallons_gas: (n) => `${fmt(n)} gallons of gasoline`,
      miles_driven: (n) => `${fmt(n)} miles not driven`,
      tree_seedlings_10yr: (n) => `${fmt(n)} tree seedlings grown for 10 years`,
      acres_forest_1yr: (n) => `${fmt(n)} acres of forest for a year`,
      homes_electricity_1yr: (n) => `${fmt(n)} homes' electricity for a year`,
    }
    const parts = []
    for (const f of factors) {
      if (!EQUIV[f] || !labels[f]) continue
      parts.push(labels[f](co2Kg / EQUIV[f]))
    }
    if (parts.length <= 1) return parts.join('')
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
  }
}

function round1(n) { return Math.round(n * 10) / 10 }
function num(n) { return typeof n === 'number' && isFinite(n) ? n : 0 }
function fmt(n) {
  return n >= 1 ? Math.round(n).toLocaleString() : Number(n.toFixed(2)).toString()
}

module.exports = SunRun
module.exports.SunRun = SunRun
module.exports.FileTokenStore = FileTokenStore
