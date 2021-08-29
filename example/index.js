const SunRun = require('../src/index.js')

const options = {
  phone: process.env.phone,
}
const sunRun = new SunRun(options)

;(async () => {
  // const data = await sunRun.respondPasswordless(process.env.code)
  const data = await sunRun.getDailyBriefing()
  console.log(data)
})()
