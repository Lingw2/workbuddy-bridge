/**
 * Probe the WorkBuddy credit endpoints against the live account.
 *
 *   node tools/probe-credit.mjs [path ...]
 */
import { resolveSession } from '../src/upstream/session.js'
import { USER_AGENTS } from '../src/config/paths.js'

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'

const PATHS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '/v2/activity/growth/buddy/info',
      '/v2/activity/ambassador/status',
      '/v2/msg-center/message?limit=20',
      '/v2/activity/growth/buddy/travel/claim',
      '/v2/activity/workbuddy/invitation/v2/my-code',
    ]

const { session } = await resolveSession()
console.log(`account: ${session.domain} uid=${session.uid}`)

function headers(extra = {}) {
  const base = {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
    'User-Agent': USER_AGENTS.cli,
    'X-Product': 'SaaS',
    Authorization: `Bearer ${session.accessToken}`,
  }
  if (session.uid) base['X-User-Id'] = session.uid
  else base['X-No-User-Id'] = '1'
  if (session.enterpriseId) {
    base['X-Enterprise-Id'] = session.enterpriseId
    base['X-Tenant-Id'] = session.enterpriseId
  } else {
    base['X-No-Enterprise-Id'] = '1'
  }
  return { ...base, ...extra }
}

for (const path of PATHS) {
  const method = path.includes('/claim') ? 'POST' : 'GET'
  const base = path.includes('msg-center') || path.includes('activity')
    ? CN_BILLING_BASE
    : CN_CHAT_BASE
  const url = path.startsWith('/v2/chat') || path.includes('/plugin/')
    ? `${CN_CHAT_BASE}${path}`
    : `${base}${path}`
  console.log(`\n===== ${method} ${url} =====`)
  try {
    const response = await fetch(url, {
      method,
      headers: headers(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      body: method === 'POST' ? JSON.stringify({}) : undefined,
      signal: AbortSignal.timeout(25_000),
    })
    const text = await response.text()
    console.log(`status: ${response.status}`)
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 3000))
    } catch {
      console.log(text.slice(0, 1500))
    }
  } catch (error) {
    console.log(`ERROR ${error.message}`)
  }
}
