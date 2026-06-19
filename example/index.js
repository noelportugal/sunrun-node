'use strict'
// Example: one-time auth, then a daily briefing.
//
//   phone=+15551234567 node example/index.js            # step 1: request code
//   phone=+15551234567 code=123456 node example/index.js # step 2: verify + read
//
// After verifying once, you can drop `code` — the cached token is reused.

const SunRun = require('../src/index.js')

const sunrun = new SunRun({ phone: process.env.phone })

;(async () => {
  if (!sunrun.isAuthorized() && !process.env.code) {
    await sunrun.requestPasswordless()
    console.log('Code sent. Re-run with code=<the 6-digit code> to finish.')
    return
  }
  if (process.env.code) {
    await sunrun.verifyCode(process.env.code)
    console.log('Authorized.')
  }
  console.log(await sunrun.getDailyBriefing())
})().catch((e) => { console.error('error:', e.message); process.exit(1) })
