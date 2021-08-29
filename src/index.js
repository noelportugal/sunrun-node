'use strict'
const axios = require('axios')
const GG = require('greenhouse-gas')
const moment = require('moment')
const LocalStorage = require('node-localstorage').LocalStorage
const localStorage = new LocalStorage('./scratch')

class SunRun {
  /**
   * @param {object} options
   * @constructor
   */
  constructor(options) {
    this.baseUrl = 'https://gateway.sunrun.com'
    this.phone = options.phone
    this.startDate = ''
    this.prospectId = ''
    this.token = ''
    this.accessToken = ''
  }

  /**
   * get token
   */
  async getToken() {
    this.token = localStorage.getItem('token')
  }

  /**
   * set token
   */
  async setToken(token) {
    localStorage.setItem('token', token)
    this.token = token
  }

  /**
   * get access tokens
   */
  async getAcccessTokens() {
    this.accessToken = localStorage.getItem('access_token')
  }

  /**
   * set access tokens
   */
  async setAccessTokens(accessToken) {
    localStorage.setItem('access_token', accessToken)
    this.accessToken = accessToken
  }

  /**
   * set prospectId
   */
  async setProspectId(prospectId) {
    localStorage.setItem('prospect_id', prospectId)
    this.prospectId = prospectId
  }

  /**
   * get prospectId
   */
  async getProspectId() {
    this.prospectId = localStorage.getItem('prospect_id')
  }

  /**
   * requestPasswordless
   * @returns {data}
   */
  async requestPasswordless() {
    let result
    try {
      const data = {
        email: null,
        phone: this.phone,
        prospectId: null,
      }
      result = await axios.post(`${this.baseUrl}/portal-auth/request-passwordless`, data)
      this.setToken(result.data.token)
    } catch (e) {
      throw e
    }
    return result
  }

  /**
   * respondPasswordless
   * @returns {data}
   */
  async respondPasswordless(code) {
    let result
    try {
      await this.getToken()
      if (!this.token) {
        await this.requestPasswordless()
      }

      const data = {
        email: null,
        phone: this.phone,
        code: code,
      }

      let options = {
        headers: {
          Authorization: this.token,
        },
      }
      result = await axios.post(`${this.baseUrl}/portal-auth/respond-passwordless`, data, options)
      this.setAccessTokens(result.data.data.accessToken)
      this.setProspectId(result.data.opportunitiesWithContracts[0]['prospect_id'])
      localStorage.setItem('start_date', result.data.opportunitiesWithContracts[0].contract.ptoDate)
    } catch (e) {
      console.log(e)
      throw e
    }
    return result
  }

  /**
   * cumulativeProduction
   * @returns {data}
   */
  async cumulativeProduction() {
    let result
    try {
      await this.getAcccessTokens()
      await this.getProspectId()
      if (!this.accessToken) {
        await this.requestPasswordless()
      }

      let config = {
        headers: {
          Authorization: this.accessToken,
        },
        params: {
          startDate: `${localStorage.getItem('start_date')}T00:00:00.000-10:00`,
          endDate: `${moment(new Date()).add(1, 'days').format('YYYY-MM-DD')}T23:59:59.999-10:00`,
        },
      }

      result = await axios.get(
        `${this.baseUrl}/performance-api/v1/cumulative-production/daily/${this.prospectId}`,
        config
      )
      // localStorage.setItem('cumulative_production', JSON.stringify(result.data))
    } catch (e) {
      throw e
    }
    return result.data
  }

  async getDailyBriefing() {
    let result
    try {
      // result = JSON.parse(localStorage.getItem('cumulative_production'))
      const cumulativeProduction = await this.cumulativeProduction()
      let output = ''
      const today = Object.values(cumulativeProduction).filter(
        (item) => item.timestamp === moment(new Date()).format('YYYY-MM-DD')
      )[0]
      const yesterday = Object.values(cumulativeProduction).filter(
        (item) => item.timestamp === moment(new Date()).subtract(1, 'days').format('YYYY-MM-DD')
      )[0]
      const lastThirtyDays = moment(new Date()).subtract(30, 'days').valueOf()
      const month = Object.values(cumulativeProduction)
        .filter((element) => new Date(element.timestamp).getTime() > lastThirtyDays)
        .map((element) => element.deliveredKwh)
        .reduce((a, b) => a + b)

      const allTime = Math.round(today.cumulativeKwh)
      const greenhouseData = GG.calculateEquivalency(allTime, { keyList: ['coal', 'propane', 'gasoline'] })
      let greenhouseVerbose = ''
      greenhouseData.forEach((element) => {
        greenhouseVerbose += `${Math.floor(element.value)} ${element.description},`
      })
      result = `So far today your system has generated ${Math.floor(today.deliveredKwh)} Kwh, yesterday ${Math.floor(
        yesterday.deliveredKwh
      )} Kwh, ${Math.floor(
        month
      )} Kwh in the last 30 days and an all time of ${allTime} Kwh. This means you’ve already prevented CO₂ emissions equivalent to roughly ${greenhouseVerbose} congrats!`
    } catch (e) {
      throw e
    }

    return result
  }
}

module.exports = SunRun
