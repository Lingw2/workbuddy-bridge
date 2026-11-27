/**
 * Probe the remaining WorkBuddy credit channels.
 *
 *   node tools/probe-credit2.mjs
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

const CALLS = [
  ['GET', '/activity/growth/streak', undefined],
  ['GET', '/v2/msg-center/message/list?limit=50', undefined],
  ['POST', '/v2/billing/meter/get-user-resource-free-packages', {}],
  ['POST', '/billing/meter/get-user-resource-free-packages', {}],
  ['POST', '/v2/billing/meter/get-user-resource', {
    PageNumber: 1,
    PageSize: 20,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
  }],
  ['GET', '/v2/activity/growth/buddy/info', undefined],
]

for (const [method, path, body] of CALLS) {
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
      console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 4000))
    } catch {
      console.log(text.slice(0, 800))
    }
  } catch (error) {
    console.log(`ERROR ${error.message}`)
  }
}
