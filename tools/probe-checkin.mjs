/**
 * Probe WorkBuddy billing / check-in endpoints.
 *
 *   node tools/probe-checkin.mjs
 */
import { resolveSession, discoverSession } from '../src/upstream/session.js'

const CN_BILLING_BASE = 'https://www.codebuddy.cn'

const { session, source } = await resolveSession()
console.log(`source: ${source?.path}`)
console.log(
  `domain=${session.domain} uid=${session.uid} nickname=${session.nickname} enterpriseId=${session.enterpriseId}`,
)

const discovered = discoverSession()
for (const candidate of discovered.candidates) {
  console.log(
    `  candidate ${candidate.source.id}: uid=${candidate.session.uid} domain=${candidate.session.domain}`,
  )
}

function headers() {
  const base = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${session.accessToken}`,
    'User-Agent': 'WorkBuddy/5.11.3',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Origin: CN_BILLING_BASE,
    Referer: `${CN_BILLING_BASE}/`,
  }
  if (session.uid) base['X-User-Id'] = session.uid
  if (session.enterpriseId) {
    base['X-Enterprise-Id'] = session.enterpriseId
    base['X-Tenant-Id'] = session.enterpriseId
  }
  if (session.domain) base['X-Domain'] = session.domain
  return base
}

const READS = [
  ['POST', '/v2/billing/meter/checkin-activity-status'],
  ['POST', '/billing/meter/checkin-activity-status'],
  ['POST', '/billing/meter/compensation-status'],
  ['POST', '/billing/meter/check-gift-claimed'],
  ['GET', '/v2/activity/growth/heatmap'],
  ['GET', '/activity/growth/heatmap'],
  ['GET', '/activity/growth/streak'],
]

for (const [method, path] of READS) {
  const url = `${CN_BILLING_BASE}${path}`
  console.log(`\n===== ${method} ${url} =====`)
  try {
    const response = await fetch(url, {
      method,
      headers: headers(),
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(25_000),
    })
    const text = await response.text()
    console.log(`status: ${response.status}`)
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2).slice(0, 2500))
    } catch {
      console.log(text.slice(0, 800))
    }
  } catch (error) {
    console.log(`ERROR ${error.message}`)
  }
}
