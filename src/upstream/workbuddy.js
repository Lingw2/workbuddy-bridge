/**
 * The WorkBuddy upstream client.
 *
 * Speaks the same wire protocol the WorkBuddy app and CLI speak, so a session
 * that is already signed in to WorkBuddy can be reused without asking for an
 * extra API key.
 *
 * Two calls matter:
 *   GET  /v3/config                       -> the model directory
 *   POST /v2/chat/completions             -> the chat stream
 * plus one maintenance call:
 *   POST /v2/plugin/auth/token/refresh    -> renew the access token
 */
import { USER_AGENTS } from '../config/paths.js'

const CN_CHAT_BASE = 'https://copilot.tencent.com'
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'
const GLOBAL_CONFIG_PATH = '/v3/config'
const LEGACY_CATALOG_PATH = '/v2/enterprises/personal/models'
const CHAT_PATH = '/v2/chat/completions'
const REFRESH_PATH = '/v2/plugin/auth/token/refresh'

const JSON_TIMEOUT_MS = 20_000
const STREAM_TIMEOUT_MS = 300_000

/** Which region a domain belongs to. */
export function regionOf(domain) {
  const value = String(domain ?? '').toLowerCase()
  if (value.includes('workbuddy.ai') || value.includes('codebuddy.ai')) return 'global'
  return 'cn'
}

/** The chat host for a region. */
export function chatBase(domain) {
  return regionOf(domain) === 'global' ? GLOBAL_BASE : CN_CHAT_BASE
}

/** The host the product-config document lives on. */
export function configBase(domain) {
  if (regionOf(domain) !== 'global') return CN_BILLING_BASE
  return String(domain ?? '').toLowerCase().includes('codebuddy.ai')
    ? 'https://www.codebuddy.ai'
    : GLOBAL_BASE
}

/** The Origin/Referer the upstream expects. */
function originReferer(domain) {
  return regionOf(domain) === 'global' ? configBase(domain) : CN_BILLING_BASE
}

/**
 * Read a WorkBuddy session from disk.
 *
 * Two shapes exist in the wild: the desktop extension's `workbuddy-desktop.info`
 * and the CLI plugin's vault entry. Both carry the same fields.
 */
export function parseSessionFile(raw, sourcePath) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const auth = parsed?.auth ?? parsed
  const account = parsed?.account ?? parsed?.accounts?.[0] ?? parsed?.allAccounts?.[0] ?? {}

  const accessToken = typeof auth?.accessToken === 'string' ? auth.accessToken : ''
  if (!accessToken) return null

  const refreshToken = typeof auth?.refreshToken === 'string' ? auth.refreshToken : ''
  const domain = typeof auth?.domain === 'string' && auth.domain ? auth.domain : 'www.workbuddy.cn'
  const expiresAt = Number(auth?.expiresAt ?? 0)
  const refreshExpiresAt = Number(auth?.refreshExpiresAt ?? 0)

  return {
    accessToken,
    refreshToken,
    domain,
    uid: typeof account?.uid === 'string' ? account.uid : '',
    uin: typeof account?.uin === 'string' ? account.uin : '',
    nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    enterpriseId: typeof parsed?.enterpriseId === 'string' ? parsed.enterpriseId : '',
    expiresAt,
    refreshExpiresAt,
    sourcePath,
  }
}

/** Base headers the upstream expects on every request. */
function baseHeaders(session) {
  return {
    Accept: 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Origin: originReferer(session.domain),
    Referer: `${originReferer(session.domain)}/`,
    'User-Agent': USER_AGENTS.cli,
  }
}

/** Account identity headers. Enterprise accounts need all three or none. */
function identityHeaders(session) {
  const headers = {}
  if (session.uid) headers['X-User-Id'] = session.uid
  else headers['X-No-User-Id'] = '1'
  if (session.enterpriseId) {
    headers['X-Enterprise-Id'] = session.enterpriseId
    headers['X-Tenant-Id'] = session.enterpriseId
  } else {
    headers['X-No-Enterprise-Id'] = '1'
  }
  return headers
}

/** Headers for a chat request. */
export function chatHeaders(session) {
  return {
    ...baseHeaders(session),
    ...identityHeaders(session),
    'Content-Type': 'application/json',
    'X-Product': 'SaaS',
    Authorization: `Bearer ${session.accessToken}`,
  }
}

/** Headers for a token refresh. */
export function refreshHeaders(session) {
  const headers = {
    ...baseHeaders(session),
    'X-Refresh-Token': session.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
    Authorization: `Bearer ${session.accessToken}`,
  }
  if (session.enterpriseId) headers['X-Enterprise-Id'] = session.enterpriseId
  return headers
}

/** Headers for the product-config document. */
function configHeaders(session) {
  return {
    ...baseHeaders(session),
    ...identityHeaders(session),
    'X-Product': 'SaaS',
    'User-Agent': USER_AGENTS.app,
    Authorization: `Bearer ${session.accessToken}`,
  }
}

/** Unwrap the `{code, data}` envelope the upstream uses. */
async function readEnvelope(response) {
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`upstream returned non-JSON (${response.status}): ${text.slice(0, 200)}`)
  }
  if (!response.ok) {
    const message = body?.msg ?? body?.message ?? body?.error?.message ?? response.statusText
    throw new Error(`upstream ${response.status}: ${message}`)
  }
  if (typeof body?.code === 'number' && body.code !== 0) {
    throw new Error(`upstream error ${body.code}: ${body.msg ?? 'unknown'}`)
  }
  return body?.data ?? body
}

/** Models the CLI agent can use. */
function selectCliModels(rawModels, agents) {
  const byId = new Map()
  for (const model of Array.isArray(rawModels) ? rawModels : []) {
    if (model && typeof model.id === 'string') byId.set(model.id, model)
  }

  let cliIds
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (agent && agent.name === 'cli' && Array.isArray(agent.models)) {
      cliIds = agent.models.filter((id) => typeof id === 'string')
      break
    }
  }

  const ids = cliIds && cliIds.length > 0 ? cliIds : [...byId.keys()]
  const models = ids.map((id) => byId.get(id)).filter(Boolean)
  if (models.length === 0) throw new Error('upstream model directory resolved to an empty list')
  return models
}

/**
 * Read the model directory.
 *
 * @param {object} session
 * @returns {Promise<object[]>} raw model objects
 */
export async function fetchModels(session) {
  const timeout = AbortSignal.timeout(JSON_TIMEOUT_MS)
  const base = configBase(session.domain)

  const read = async (path) => {
    const response = await fetch(`${base}${path}`, {
      headers: configHeaders(session),
      signal: timeout,
    })
    const data = await readEnvelope(response)
    return selectCliModels(data?.models, data?.agents)
  }

  try {
    return await read(GLOBAL_CONFIG_PATH)
  } catch (error) {
    try {
      return await read(LEGACY_CATALOG_PATH)
    } catch {
      throw error
    }
  }
}

/**
 * Renew the access token.
 *
 * @param {object} session
 * @returns {Promise<{accessToken: string, refreshToken?: string, domain?: string}>}
 */
export async function refreshToken(session) {
  const response = await fetch(`${chatBase(session.domain)}${REFRESH_PATH}`, {
    method: 'POST',
    headers: refreshHeaders(session),
    signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
  })
  const data = await readEnvelope(response)
  const accessToken = typeof data?.accessToken === 'string' ? data.accessToken : ''
  if (!accessToken) throw new Error('token refresh returned no accessToken; sign in to WorkBuddy again')
  const out = { accessToken }
  if (typeof data?.refreshToken === 'string' && data.refreshToken) out.refreshToken = data.refreshToken
  if (typeof data?.domain === 'string' && data.domain) out.domain = data.domain
  return out
}

/**
 * Start a chat completion.
 *
 * @param {object} session
 * @param {object} body OpenAI chat body (the caller sets `stream: true`)
 * @returns {Promise<Response>} the raw SSE response
 */
export async function chatCompletion(session, body) {
  const response = await fetch(`${chatBase(session.domain)}${CHAT_PATH}`, {
    method: 'POST',
    headers: chatHeaders(session),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text()
    let message = text.slice(0, 400)
    try {
      const parsed = JSON.parse(text)
      message = parsed?.msg ?? parsed?.message ?? parsed?.error?.message ?? message
    } catch {
      /* keep the raw text */
    }
    const error = new Error(`upstream ${response.status}: ${message}`)
    error.status = response.status
    throw error
  }
  return response
}

/**
 * Parse an upstream SSE body into ordered `data:` payloads.
 *
 * @param {Response} response
 */
export async function* readSse(response) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '')
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        yield JSON.parse(data)
      } catch {
        /* ignore keepalives */
      }
    }
  }
  const tail = buffer.trim()
  if (tail.startsWith('data:')) {
    const data = tail.slice(5).trim()
    if (data && data !== '[DONE]') {
      try {
        yield JSON.parse(data)
      } catch {
        /* ignore */
      }
    }
  }
}
