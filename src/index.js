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
   * setReponse
   * @returns {data}
   */
  async setReponse(status, message, data, additionalData={}) {
    return {
      status,
      message,
      data,
      additionalData,
    }
  }

  /**
   * requestPasswordless
   * @returns {bool}
   */
  async requestPasswordless() {
    let success
    try {
      const reqData = {
        email: null,
        phone: this.phone,
        prospectId: null,
      }
      const result = await axios.post(`${this.baseUrl}/portal-auth/request-passwordless`, reqData)
      this.setToken(result.data.token)
      success = true
    } catch (e) {
      success = false
    }
    return success
  }

  /**
   * respondPasswordless
   * @returns {bool}
   */
  async respondPasswordless(code) {
    let status, message,  data
    try {
      await this.getToken()
      if (!this.token) {
        await this.requestPasswordless()
      }

      const reqData = {
        email: null,
        phone: this.phone,
        code: code,
      }

      let options = {
        headers: {
          Authorization: this.token,
        },
      }
      const result = await axios.post(`${this.baseUrl}/portal-auth/respond-passwordless`, reqData, options)
      this.setAccessTokens(result.data.data.accessToken)
      this.setProspectId(result.data.opportunitiesWithContracts[0]['prospect_id'])
      localStorage.setItem('start_date', result.data.opportunitiesWithContracts[0].contract.ptoDate)
      status  = 'success'
      message = 'success'
      data = 'The code has been received.'
    } catch (e) {
      status = 'error'
      message = e.message
      data = `Code '${code}' is invalid.`
    }
    return this.setReponse(status, message, data)
  }

  /**
   * getCumulativeProduction
   * @returns {bool}
   */
  async getCumulativeProduction() {
    let status, message,  data
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
          endDate: `${moment().add(1, 'days').format('YYYY-MM-DD')}T23:59:59.999-10:00`,
        },
      }

      const result = await axios.get(
        `${this.baseUrl}/performance-api/v1/cumulative-production/daily/${this.prospectId}`,
        config
      )
      status  = 'success'
      message = 'success'
      data = result.data
    } catch (e) {
      status = 'error'
      message = e.message
      data = null
    }

    const localResponse = await this.setReponse(status, message, data)
    localStorage.setItem('cumulative_production', JSON.stringify(localResponse))
    return localResponse
  }

  /**
   * getDailyBriefing
   * @returns {data}
   */
  async getDailyBriefing(ggList=['coal', 'propane', 'gasoline']) {
    let status, message,  data, ggData
    try {
      const cumulativeProduction = await this.getCumulativeProduction()
      // const cumulativeProduction = await JSON.parse(localStorage.getItem('cumulative_production'))

      if (cumulativeProduction.status === 'error') {
        status = 'error'
        message = 'auth'
        data = 'Please send your SunRun verification code using SMS and try again.'
        return this.setReponse(status, message, data)
      }

      const todayData = Object.values(cumulativeProduction.data)
      const today = todayData[todayData.length - 1]
      const yesterday = Object.values(cumulativeProduction.data).filter(
        (item) => item.timestamp === moment().subtract(1, 'days').format('YYYY-MM-DD')
      )[0]
      const lastThirtyDays = moment().subtract(30, 'days').valueOf()
      const month = Object.values(cumulativeProduction.data)
        .filter((element) => new Date(element.timestamp).getTime() > lastThirtyDays)
        .map((element) => element.deliveredKwh)
        .reduce((a, b) => a + b)
      const allTime = Math.round(today.cumulativeKwh)
      const greenhouseData = GG.calculateEquivalency(allTime, { keyList: ggList })
      let greenhouseArray = []
      greenhouseData.forEach((element) => {
        if (Math.floor(element.value) === 0){
          greenhouseArray.push(`${element.value.toFixed(3)} ${element.description}`)
        }else{
          greenhouseArray.push(`${Math.floor(element.value)} ${element.description}`)
        }
      })
      const greenhouseVerbose = greenhouseArray.join(', ').replace(/,(?!.*,)/gmi, ' and')
      status = 'success'
      message = 'success'
      data = `So far your system has generated ${Math.ceil(today.deliveredKwh)} kilowatt hours today, ${Math.floor(
        yesterday.deliveredKwh
      )} kilowatt hours yesterday, ${Math.floor(
        month
      )} kilowatt hours in the last 30 days and an all time total of ${allTime} kilowatt hours. This means you’ve already prevented CO₂ emissions equivalent to roughly ${greenhouseVerbose}. Congratulations!`
      ggData = greenhouseData
    } catch (e) {
      status = 'error'
      message = e.message
      data = 'Sorry something went wrong.'
    }

    const  result = this.setReponse(status, message, data, ggData)

    return result
  }
}

module.exports = SunRun
