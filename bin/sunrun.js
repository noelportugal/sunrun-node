#!/usr/bin/env node
'use strict'

/**
 * sunrun — CLI for the unofficial mySunrun production API.
 *
 *   sunrun auth request [--phone +1512...]   text yourself a 6-digit code
 *   sunrun auth verify <code>                exchange the code for a token
 *   sunrun status                            show cached auth state
 *   sunrun production [--json]               cumulative daily production
 *   sunrun briefing [factors...]             friendly today/30d/all-time summary
 *
 * Token state lives at ~/.sunrun-node/state.json (override with SUNRUN_STATE).
 */

const SunRun = require('../src/index.js')

function makeClient() {
  return new SunRun({
    phone: process.env.SUNRUN_PHONE || undefined,
    statePath: process.env.SUNRUN_STATE || undefined,
  })
}

function arg(flag) {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function main() {
  const [cmd, sub, ...rest] = process.argv.slice(2)
  const client = makeClient()

  if (cmd === 'auth' && sub === 'request') {
    const phone = arg('--phone')
    const ok = await client.requestPasswordless(phone)
    if (!ok) throw new Error('request failed (no token returned)')
    console.log(`✓ Code sent to ${client.phone}. Run: sunrun auth verify <code>`)
    return
  }

  if (cmd === 'auth' && sub === 'verify') {
    const code = rest[0]
    if (!code) throw new Error('usage: sunrun auth verify <code>')
    const { prospectId, ptoDate } = await client.verifyCode(code)
    console.log(`✓ Authorized. prospectId=${prospectId}, PTO date=${ptoDate || '?'}`)
    return
  }

  if (cmd === 'status') {
    console.log(JSON.stringify({
      phone: client.store.get('phone'),
      authorized: client.isAuthorized(),
      prospectId: client.store.get('prospectId'),
      startDate: client.store.get('startDate'),
    }, null, 2))
    return
  }

  if (cmd === 'production') {
    if (sub === '--json') {
      console.log(JSON.stringify(await client.getCumulativeProduction(), null, 2))
    } else {
      console.log(JSON.stringify(await client.getProductionSummary(), null, 2))
    }
    return
  }

  if (cmd === 'briefing') {
    const factors = [sub, ...rest].filter(Boolean)
    console.log(await client.getDailyBriefing(factors.length ? factors : undefined))
    return
  }

  if (cmd === 'energy') {
    const scale = sub && !sub.startsWith('--') ? sub : 'daily'
    if (process.argv.includes('--flow')) {
      console.log(JSON.stringify(await client.getEnergyFlow(scale), null, 2))
    } else {
      console.log(JSON.stringify(await client.getEnergySummary(), null, 2))
    }
    return
  }

  if (cmd === 'battery') {
    if (sub === 'history') {
      console.log(JSON.stringify(await client.getBattery(), null, 2))
    } else {
      console.log(JSON.stringify(await client.getBatteryStatus(), null, 2))
    }
    return
  }

  if (cmd === 'system') {
    console.log(JSON.stringify(await client.getSystemInfo(), null, 2))
    return
  }

  console.error(
    'usage: sunrun auth request [--phone +1..] | auth verify <code> | status | ' +
    'production [--json] | briefing [factors...] | energy [scale] [--flow] | ' +
    'battery [history] | system')
  process.exit(2)
}

main().catch((e) => { console.error('error: ' + e.message); process.exit(1) })
