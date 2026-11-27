/**
 * Try the real claim writes: daily check-in, benefits, streak redeem.
 *
 *   node tools/probe-claim.mjs
 */
import { resolveSession } from '../src/upstream/session.js'

const BASE = 'https://www.codebuddy.cn'
const { session } = await resolveSession()

function headers() {
  const base = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    'User-Agent': 'WorkBuddy/5.11.3',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Origin: BASE,
    Referer: `${BASE}/`,
  }
  if (session.uid) base['X-User-Id'] = session.uid
  if (session.enterpriseId) {
    base['X-Enterprise-Id'] = session.enterpriseId
    base['X-Tenant-Id'] = session.enterpriseId
  }
  if (session.domain) base['X-Domain'] = session.domain
  return base
}

async function call(method, path, body) {
  const url = `${BASE}${path}`
  console.log(`\n===== ${method} ${url} =====`)
  try {
    const response = await fetch(url, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(25_000),
    })
    const text = await response.text()
    console.log(`status: ${response.status}`)
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 2000))
    } catch {
      console.log(text.slice(0, 600))
    }
    return { status: response.status, text }
  } catch (error) {
    console.log(`ERROR ${error.message}`)
    return { status: 0, text: error.message }
  }
}

// The daily check-in. Upstream is idempotent: claiming twice must not pay twice.
await call('POST', '/v2/billing/meter/daily-checkin', {})
await call('POST', '/v2/billing/meter/checkin-activity-status', {})
await call('POST', '/billing/meter/claim-compensation', {})
await call('POST', '/billing/meter/claim-gift', {})
await call('POST', '/activity/growth/redeem', { tier: '7d' })
await call('POST', '/v2/activity/growth/buddy/travel/claim', {})
