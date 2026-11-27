/**
 * Prove the automatic daily claim really fires.
 *
 * Runs the real CreditService against a local mock of the WorkBuddy
 * billing endpoints, points the scheduler at "one minute from now", and
 * waits for the tick that is supposed to claim the daily credit.
 *
 *   node tools/verify-auto-claim.mjs
 */
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync, readFileSync } from 'node:fs'

const requests = []
let claimed = false

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    requests.push(`${req.method} ${req.url}`)
    res.setHeader('content-type', 'application/json')

    if (req.url.endsWith('/daily-checkin')) {
      if (claimed) {
        res.statusCode = 400
        res.end(JSON.stringify({ code: 10001, msg: '今天已签到，请明天再来' }))
        return
      }
      claimed = true
      res.end(JSON.stringify({ credit: 100, streak_days: 1, is_streak_day: false }))
      return
    }
    if (req.url.endsWith('/checkin-activity-status')) {
      res.end(
        JSON.stringify({
          active: true,
          today_checked_in: claimed,
          streak_days: claimed ? 1 : 0,
          daily_credit: 100,
          today_credit: claimed ? 100 : 0,
          is_streak_day: false,
          streak_bonus_days: 0,
          streak_bonus_credit: 0,
          claim_button_text: '立即领取',
        }),
      )
      return
    }
    res.end(JSON.stringify({}))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
process.env.WORKBUDDY_BILLING_BASE = `http://127.0.0.1:${port}`

const { CreditService, localDayKey, minutesSinceMidnight } = await import('../src/credit/service.js')

const dir = mkdtempSync(path.join(os.tmpdir(), 'wbb-verify-'))
const stateFile = path.join(dir, 'credit-state.json')

// Fire in one minute so the scheduler has to wait for its own tick.
const target = new Date(Date.now() + 60_000)
const clock = `${String(target.getHours()).padStart(2, '0')}:${String(target.getMinutes()).padStart(2, '0')}`

const service = new CreditService(
  { credit: { enabled: true, time: clock, autoBenefits: false } },
  { log: (line) => console.log(`  log: ${line}`), info: () => {}, error: () => {} },
  {
    stateFile,
    resolveSession: () => ({
      session: {
        domain: 'www.workbuddy.cn',
        uid: 'test-uid',
        accessToken: 'test-token',
        refreshToken: 'test-refresh',
        nickname: 'test',
        enterpriseId: '',
        expiresAt: Date.now() + 3600_000,
      },
      source: null,
      refreshed: false,
    }),
  },
)

console.log(`scheduled for ${clock} (now ${minutesSinceMidnight(new Date())} minutes past midnight)`)
service.start()

// The tick runs every minute; give it a bit of slack past the target.
const deadline = Date.now() + 150_000
while (Date.now() < deadline && !claimed) {
  await new Promise((resolve) => setTimeout(resolve, 1000))
}
service.stop()
server.close()

const state = JSON.parse(readFileSync(stateFile, 'utf8'))
console.log('\n--- requests the upstream saw ---')
for (const line of requests) console.log(' ', line)
console.log('\n--- state file ---')
console.log(JSON.stringify(state, null, 2))
console.log(`\nday: ${localDayKey(new Date())}`)

if (!claimed) {
  console.error('\nFAIL: the scheduler never claimed the daily credit')
  process.exit(1)
}
if (!requests.some((line) => line.includes('/daily-checkin'))) {
  console.error('\nFAIL: the daily check-in endpoint was never called')
  process.exit(1)
}
console.log('\nPASS: the scheduler claimed the daily credit on its own')
