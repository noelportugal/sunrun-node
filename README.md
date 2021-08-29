// TODO


```
const SunRun = require('sunrun-node')

const options = {
  phone: process.env.phone,
}
const sunRun = new SunRun(options)

;(async () => {
  // const data = await sunRun.requestPasswordless()
  // console.log(data)
  // const data = await sunRun.respondPasswordless(process.env.code)
  // console.log(data)
  // const data = await sunRun.cumulativeProduction()
  // console.log(data)
  const data = await sunRun.getDailyBriefing()
  console.log(data)
})()
```