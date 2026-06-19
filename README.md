# sunrun-node

Unofficial Node client for the **mySunrun** solar production API — the same
`gateway.sunrun.com` backend the mySunrun web portal and mobile app use.

- 🔐 **Passwordless SMS auth** — request a code, verify once, token is cached.
- 📦 **Zero runtime dependencies** — native `fetch` + `Date` (Node ≥ 18).
- 🧮 **Structured output** — today / yesterday / 30-day / all-time kWh + CO₂ avoided.
- 🖥️ **CLI included** — `sunrun briefing`, `sunrun production`, etc.

> ⚠️ Unofficial. Sunrun has no public API; this talks to private endpoints that
> can change without notice. Production data refreshes roughly **once per day**,
> so there's no point polling more frequently.

## Install

```bash
npm install sunrun-node
```

## Quick start (library)

```js
const SunRun = require('sunrun-node')
const sunrun = new SunRun({ phone: '+15551234567' })

// 1. One-time auth — texts a 6-digit code to your phone.
await sunrun.requestPasswordless()
// 2. Verify it (token + prospectId are cached to ~/.sunrun-node/state.json).
await sunrun.verifyCode('123456')

// 3. From now on, just read production.
console.log(await sunrun.getDailyBriefing())
// → "So far your system has generated 32.6 kWh today, 41.4 kWh yesterday,
//    980 kWh in the last 30 days, and 2,003 kWh all-time. That's roughly
//    1.4 metric tons of CO₂ avoided — about 160 gallons of gasoline …"

console.log(await sunrun.getProductionSummary())
// → { todayKwh: 32.6, yesterdayKwh: 41.4, last30Kwh: 980, allTimeKwh: 2003,
//     co2AvoidedKg: 1420, co2AvoidedTons: 1.4, asOf: '2026-06-18' }
```

## Quick start (CLI)

```bash
sunrun auth request --phone +15551234567   # texts you a code
sunrun auth verify 123456                  # caches the token
sunrun status                              # show auth state
sunrun briefing                            # friendly summary
sunrun production --json                   # raw daily series
```

The CLI honors `SUNRUN_PHONE` and `SUNRUN_STATE` (token-file path) env vars.

## API

| Method | Returns | Notes |
| --- | --- | --- |
| `new SunRun({ phone, statePath?, tokenStore? })` | — | `statePath` defaults to `~/.sunrun-node/state.json` |
| `requestPasswordless(phone?)` | `boolean` | Sends the SMS code |
| `verifyCode(code)` | `{ prospectId, ptoDate }` | Caches access token; alias: `respondPasswordless` |
| `isAuthorized()` | `boolean` | Have a usable token? |
| `getCumulativeProduction()` | `object` | Raw daily series |
| `getProductionSummary()` | `object \| null` | Aggregated kWh + CO₂ |
| `getDailyBriefing(factors?)` | `string` | Friendly sentence with CO₂ equivalents |

**Equivalent factors** for `getDailyBriefing`: `gallons_gas`, `miles_driven`,
`tree_seedlings_10yr`, `acres_forest_1yr`, `homes_electricity_1yr`.

### Custom token storage

Pass any object with `get(key)` / `set(key, value)` as `tokenStore` (e.g. to keep
tokens in a database or secrets manager instead of a file):

```js
const sunrun = new SunRun({ phone, tokenStore: myStore })
```

## How auth works

1. `POST /portal-auth/request-passwordless` → returns a short-lived request token
   and texts you a code.
2. `POST /portal-auth/respond-passwordless` (with the code) → returns a long-lived
   access token, your `prospectId`, and the system's PTO (permission-to-operate)
   date, which bounds the production query.
3. `GET /performance-api/v1/cumulative-production/daily/{prospectId}` → the data.

The access token is reused until it stops working; on a `401/403` the client tells
you to re-run the two auth steps.

## License

MIT © Noel Portugal
