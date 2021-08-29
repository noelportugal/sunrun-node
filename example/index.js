const SunRun = require('../src/index.js')

const options = {
  phone: process.env.phone,
}
const sunRun = new SunRun(options)

;(async () => {
  // const data = await sunRun.respondPasswordless(process.env.code)
  const factors = ['gasoline','diesel','miles','therm','oil','tanker','leds','homes_kwh','homes','trees','forest','forest_preserved','propane','coal_rail','coal','recycling','garbage_trucks','trash_bags','coal_power','wind','phones']
  let randomFactors = []
  for (var i = 0; i < 3; ++i) {
      randomFactors[i] = factors[Math.floor(Math.random()*factors.length)];
  }
  const data = await sunRun.getDailyBriefing(randomFactors)
  console.log(data)
})()
