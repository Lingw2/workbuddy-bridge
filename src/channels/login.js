/**
 * Automatic sign-in for the third-party services.
 *
 * The user asked for a fully automatic flow: the tool opens the service's own
 * login page in the browser, waits for the service to hand the token back and
 * stores the account by itself — no copy-and-paste of access tokens.
 *
 * Every service uses its own shape:
 *
 *   - a local callback server (LobsterAI, TRAE, Gemini),
 *   - a device-code flow that is polled (Qoder, MiniMax, Cline),
 *   - a flow that hands out a link to follow (ZCode).
 *
 * A flow that cannot be automated opens the login page and says so, so the
 * user is never left without a way in.
 */
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { openInBrowser } from '../config/browser.js'

/** How long a flow waits before it gives up. */
const FLOW_TIMEOUT_MS = 5 * 60 * 1000

/** How often a polling flow asks the upstream. */
const POLL_INTERVAL_MS = 2500

/** A random string, URL-safe. */
function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/** The base64url SHA-256 of a string. */
function sha256Base64Url(text) {
  return createHash('sha256').update(text).digest('base64url')
}

/** Wait for a while. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A one-shot HTTP server on a random loopback port.
 *
 * The service redirects the browser here once the user signed in, and the
 * query string carries the token.
 *
 * @param {string} pathname the path to listen on
 */
function startCallbackServer(pathname) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    if (url.pathname !== pathname) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><meta charset="utf-8"><title>登录完成</title>' +
        '<body style="font:15px/1.7 system-ui;padding:40px;background:#0d0f0e;color:#e7ebe8">' +
        '<h2>登录完成</h2><p>可以关闭这个窗口，回到 WorkBuddy Bridge 继续。</p></body>',
    )
    server.close()
    const params = Object.fromEntries(url.searchParams.entries())
    server.emit('callback', params)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      const waiters = []
      server.on('callback', (params) => {
        for (const waiter of waiters.splice(0)) waiter(params)
      })
      resolve({
        url: `http://127.0.0.1:${port}${pathname}`,
        /** Wait for the browser to come back with the token. */
        wait(timeoutMs = FLOW_TIMEOUT_MS) {
          return new Promise((done, fail) => {
            const timer = setTimeout(() => {
              const index = waiters.findIndex((entry) => entry.timer === timer)
              if (index !== -1) waiters.splice(index, 1)
              fail(new Error('登录超时，请重试'))
            }, timeoutMs)
            waiters.push({ timer, done: (params) => { clearTimeout(timer); done(params) } })
          })
        },
        close() {
          server.close()
        },
      })
    })
  })
}

/** A request that answers with `{ok, body, status, message}`. */
async function request(url, { method = 'GET', headers = {}, body, timeout = 30_000 } = {}) {
  let response
  try {
    response = await fetch(url, {
      method,
      headers,
      ...body === undefined ? {} : { body },
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    return { ok: false, status: 0, body: null, message: error.message }
  }
  const text = await response.text()
  let parsed = null
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {}
  } catch {
    return { ok: false, status: response.status, body: null, message: text.trim().slice(0, 160) }
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    message: response.ok ? '' : `HTTP ${response.status}: ${text.trim().slice(0, 160)}`,
  }
}

/* ------------------------------------------------------------------ */
/* The flows                                                            */
/* ------------------------------------------------------------------ */

const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'
const LOBSTERAI_PORTAL_BASE = 'https://lobsterai.youdao.com'

/** LobsterAI: a local callback that hands over a one-time code. */
async function lobsteraiFlow() {
  const callback = await startCallbackServer('/auth/callback')
  const state = randomToken(16)
  const uuid = randomUUID()
  const firstKeyfrom = Date.now()
  const loginUrl =
    `${LOBSTERAI_PORTAL_BASE}/portal#/login?source=electron` +
    `&redirect_uri=${encodeURIComponent(callback.url)}&state=${state}`

  openInBrowser(loginUrl)

  const params = await callback.wait()
  callback.close()

  if (params.state && params.state !== state) throw new Error('登录状态校验失败，请重试')
  const code = params.code ?? params.authCode
  if (!code) throw new Error('没有拿到登录凭据，请重试')

  const result = await request(`${LOBSTERAI_API_BASE}/api/auth/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      authCode: code,
      firstKeyfrom,
      latestKeyfrom: Date.now(),
      uuid,
      version: '2026.9.4',
    }),
  })
  if (!result.ok) throw new Error(result.message || '交换登录凭据失败')

  const data = result.body?.data ?? result.body
  if (!data?.access_token) throw new Error('上游没有返回 access token')

  return {
    credential: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
      uid: data.uid,
      user_id: data.user_id,
      nickname: data.nickname,
      uuid,
      first_keyfrom: firstKeyfrom,
      latest_keyfrom: Date.now(),
    },
    nickname: data.nickname ?? data.uid ?? 'LobsterAI',
  }
}

const QODER = {
  qoder: {
    id: 'qoder',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  },
  qodercn: {
    id: 'qodercn',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
  },
}

/** Qoder: a PKCE device flow that is polled. */
async function qoderFlow(providerId) {
  const product = QODER[providerId]
  const verifier = randomToken(48)
  const challenge = sha256Base64Url(verifier)
  const nonce = randomToken(16)
  const machineId = randomToken(16)

  const loginUrl =
    `${product.authBase}/device/selectAccounts?challenge=${encodeURIComponent(challenge)}` +
    `&challenge_method=S256&nonce=${encodeURIComponent(nonce)}` +
    `&machine_id=${encodeURIComponent(machineId)}&client_id=${encodeURIComponent(product.clientId)}`

  openInBrowser(loginUrl)

  const deadline = Date.now() + FLOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    const query = new URLSearchParams({
      challenge,
      nonce,
      machine_id: machineId,
      client_id: product.clientId,
      code_verifier: verifier,
    })
    const result = await request(`${product.openApiBase}/api/v1/deviceToken/poll?${query}`, {
      headers: { Accept: 'application/json' },
    })
    if (result.ok) {
      const data = result.body?.data ?? result.body
      const token = data?.accessToken ?? data?.access_token ?? data?.token
      if (token) {
        return {
          credential: {
            access_token: token,
            security_oauth_token: data?.securityOauthToken ?? data?.security_oauth_token ?? token,
            refresh_token: data?.refreshToken ?? data?.refresh_token,
            expire_time: data?.expireTime ?? data?.expire_time,
            uid: data?.uid ?? data?.userId,
          },
          nickname: data?.nickname ?? data?.name ?? 'Qoder',
        }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('登录超时，请重试')
}

const MINIMAX_ACCOUNT_HOST = 'https://account.minimax.cn'

/** MiniMax: a device code that is polled. */
async function minimaxFlow() {
  const verifier = randomToken(48)
  const challenge = sha256Base64Url(verifier)
  const form = new URLSearchParams({
    client_id: 'mcode-public',
    scope: 'agent.default',
    audience: 'agent-backend',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  })

  const start = await request(`${MINIMAX_ACCOUNT_HOST}/oauth2/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  })
  if (!start.ok) throw new Error(start.message || '无法发起登录')

  const data = start.body?.data ?? start.body
  const deviceCode = data?.device_code
  if (!deviceCode) throw new Error('上游没有返回 device code')

  openInBrowser(data.verification_uri_complete ?? data.verification_uri)

  const deadline = Date.now() + FLOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    const poll = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: 'mcode-public',
      code_verifier: verifier,
    })
    const result = await request(`${MINIMAX_ACCOUNT_HOST}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: poll.toString(),
    })
    if (result.ok) {
      const body = result.body?.data ?? result.body
      if (body?.access_token) {
        return {
          credential: {
            access_token: body.access_token,
            refresh_token: body.refresh_token,
            expires_at: body.expires_in ? Date.now() + body.expires_in * 1000 : undefined,
            scope: body.scope,
          },
          nickname: 'MiniMax',
        }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('登录超时，请重试')
}

const TRAE_CONSOLE_HOST = 'https://www.trae.cn'
const TRAE_OAUTH_HOST = 'https://api.trae.com.cn'

/** TRAE: a local callback that hands over a one-time code. */
async function traeFlow() {
  const callback = await startCallbackServer('/authorize')
  const machineId = randomToken(16)
  const deviceId = randomToken(16)
  const loginUrl =
    `${TRAE_CONSOLE_HOST}/authorization?login_version=1&auth_from=solo&login_channel=native_ide` +
    `&plugin_version=2.3.62834&auth_type=local&client_id=en1oxy7wnw8j9n&redirect=0` +
    `&login_trace_id=${randomUUID()}&auth_callback_url=${encodeURIComponent(callback.url)}` +
    `&machine_id=${encodeURIComponent(machineId)}&device_id=${encodeURIComponent(deviceId)}` +
    `&x_device_id=${encodeURIComponent(deviceId)}&x_machine_id=${encodeURIComponent(machineId)}` +
    `&x_device_brand=PC&x_device_type=PC&x_os_version=1.0&x_app_version=0.1.52&x_app_type=stable`

  openInBrowser(loginUrl)

  const params = await callback.wait()
  callback.close()

  const code = params.code ?? params.authCode ?? params.token
  if (!code) throw new Error('没有拿到登录凭据，请重试')

  const result = await request(`${TRAE_OAUTH_HOST}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, machine_id: machineId, device_id: deviceId }),
  })
  if (!result.ok) throw new Error(result.message || '交换登录凭据失败')

  const data = result.body?.data ?? result.body
  const token = data?.access_token ?? data?.accessToken
  if (!token) throw new Error('上游没有返回 access token')

  return {
    credential: {
      access_token: token,
      refresh_token: data?.refresh_token ?? data?.refreshToken,
      uid: data?.uid ?? data?.user_id,
      machine_id: machineId,
      device_id: deviceId,
    },
    nickname: data?.nickname ?? 'TRAE',
  }
}

const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** ZCode: a flow that hands out a link to follow. */
async function zcodeFlow() {
  const flowSecret = randomToken(24)
  const init = await request(`${ZCODE_ORIGIN}/api/v1/oauth/cli/init`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${flowSecret}`,
    },
    body: JSON.stringify({ provider: 'bigmodel' }),
  })
  if (!init.ok) throw new Error(init.message || '无法发起登录')

  const data = init.body?.data ?? init.body
  const flowId = data?.flow_id
  if (!flowId) throw new Error('上游没有返回 flow id')

  openInBrowser(data.authorize_url)

  const deadline = Date.now() + FLOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await request(`${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${flowSecret}` },
    })
    if (result.ok) {
      const poll = result.body?.data ?? result.body
      if (poll?.status === 'failed') throw new Error(poll?.message ?? '登录失败')
      if (poll?.status === 'ready') {
        const jwt = poll?.token ?? poll?.zcode_jwt
        if (!jwt) throw new Error('上游没有返回登录凭据')
        return {
          credential: {
            zcode_jwt: jwt,
            access_token: poll?.bigmodel?.access_token ?? poll?.zai?.access_token,
            refresh_token: poll?.refresh_token,
            uid: poll?.user?.user_id,
          },
          nickname: poll?.user?.nickname ?? 'ZCode',
        }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('登录超时，请重试')
}

const CLINE_WORKOS_BASE = 'https://api.workos.com'
const CLINE_WORKOS_CLIENT_ID = 'client_01K3A541FN8TA3EPPHTD2325AR'
const CLINE_API_BASE = 'https://api.cline.bot'

/** Cline: a device authorization that is polled. */
async function clineFlow() {
  const start = await request(`${CLINE_WORKOS_BASE}/user_management/authorize/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: CLINE_WORKOS_CLIENT_ID }).toString(),
  })
  if (!start.ok) throw new Error(start.message || '无法发起登录')

  const data = start.body?.data ?? start.body
  const deviceCode = data?.device_code
  if (!deviceCode) throw new Error('上游没有返回 device code')

  openInBrowser(data.verification_uri_complete ?? data.verification_uri)

  const deadline = Date.now() + FLOW_TIMEOUT_MS
  while (Date.now() < deadline) {
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: CLINE_WORKOS_CLIENT_ID,
    })
    const result = await request(`${CLINE_WORKOS_BASE}/user_management/authenticate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: form.toString(),
    })
    if (result.ok) {
      const body = result.body?.data ?? result.body
      const token = body?.accessToken ?? body?.access_token
      if (token) {
        const register = await request(`${CLINE_API_BASE}/api/v1/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            accessToken: token,
            refreshToken: body?.refreshToken ?? body?.refresh_token,
          }),
        })
        const registered = register.body?.data ?? register.body ?? {}
        return {
          credential: {
            access_token: registered.accessToken ?? token,
            refresh_token: registered.refreshToken ?? body?.refreshToken,
            expires_at: registered.expiresAt ?? body?.expiresAt,
            account_id: registered.accountId ?? body?.accountId,
            email: registered.email ?? body?.email,
          },
          nickname: registered.displayName ?? registered.email ?? 'Cline',
        }
      }
    }
    await sleep(POLL_INTERVAL_MS)
  }
  throw new Error('登录超时，请重试')
}

const GEMINI_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GEMINI_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GEMINI_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
// The Gemini desktop app ships its own OAuth client. Those values are not
// ours to publish, so they are read from the environment:
//   WORKBUDDY_BRIDGE_GEMINI_CLIENT_ID
//   WORKBUDDY_BRIDGE_GEMINI_CLIENT_SECRET
const GEMINI_CLIENT_ID = process.env.WORKBUDDY_BRIDGE_GEMINI_CLIENT_ID ?? ''
const GEMINI_CLIENT_SECRET = process.env.WORKBUDDY_BRIDGE_GEMINI_CLIENT_SECRET ?? ''

/** Gemini: a local callback that hands over a code. */
async function geminiFlow() {
  if (!GEMINI_CLIENT_ID || !GEMINI_CLIENT_SECRET) {
    throw new Error(
      '缺少 Gemini 的 OAuth 凭据：请设置 WORKBUDDY_BRIDGE_GEMINI_CLIENT_ID 与 WORKBUDDY_BRIDGE_GEMINI_CLIENT_SECRET 环境变量',
    )
  }
  const callback = await startCallbackServer('/oauth-callback')
  const state = randomToken(16)
  const loginUrl =
    `${GEMINI_AUTH_ENDPOINT}?client_id=${encodeURIComponent(GEMINI_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(callback.url)}&response_type=code` +
    `&scope=${encodeURIComponent('https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email')}` +
    `&state=${state}&access_type=offline&prompt=consent`

  openInBrowser(loginUrl)

  const params = await callback.wait()
  callback.close()

  if (params.state && params.state !== state) throw new Error('登录状态校验失败，请重试')
  const code = params.code
  if (!code) throw new Error('没有拿到登录凭据，请重试')

  const token = await request(GEMINI_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: GEMINI_CLIENT_ID,
      client_secret: GEMINI_CLIENT_SECRET,
      redirect_uri: callback.url,
      grant_type: 'authorization_code',
    }).toString(),
  })
  if (!token.ok) throw new Error(token.message || '交换登录凭据失败')

  const data = token.body?.data ?? token.body
  if (!data?.access_token) throw new Error('上游没有返回 access token')

  let nickname = 'Gemini'
  try {
    const info = await request(GEMINI_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    })
    if (info.ok) {
      const user = info.body?.data ?? info.body
      nickname = user?.email ?? user?.name ?? nickname
    }
  } catch {
    /* the nickname is a nice-to-have */
  }

  return {
    credential: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined,
      scope: data.scope,
    },
    nickname,
  }
}

/**
 * The flows we know, keyed by provider id.
 *
 * A provider that is not in here opens its login page and tells the user that
 * the token has to be pasted.
 */
export const LOGIN_FLOWS = {
  lobsterai: lobsteraiFlow,
  qoder: () => qoderFlow('qoder'),
  qodercn: () => qoderFlow('qodercn'),
  minimax: minimaxFlow,
  trae: traeFlow,
  zcode: zcodeFlow,
  cline: clineFlow,
  gemini: geminiFlow,
}

/* ------------------------------------------------------------------ */
/* The running flows                                                    */
/* ------------------------------------------------------------------ */

/** The flows that are running right now, keyed by provider id. */
const RUNNING = new Map()

/** The flows that finished, newest first. */
const FINISHED = []

/**
 * Start the automatic sign-in of one provider.
 *
 * @param {string} providerId
 * @returns {{ok: boolean, state: string, message?: string}}
 */
export function startLogin(providerId) {
  const flow = LOGIN_FLOWS[providerId]
  if (!flow) {
    return { ok: false, state: 'manual', message: '该服务的登录需要手动复制令牌' }
  }
  if (RUNNING.has(providerId)) {
    return { ok: true, state: 'waiting', message: '登录已经在进行中' }
  }

  const entry = { providerId, state: 'waiting', startedAt: Date.now(), message: '请在浏览器里完成登录' }
  RUNNING.set(providerId, entry)

  flow()
    .then((result) => {
      entry.state = 'done'
      entry.result = result
      entry.message = '登录成功'
    })
    .catch((error) => {
      entry.state = 'failed'
      entry.message = error.message
    })
    .finally(() => {
      RUNNING.delete(providerId)
      FINISHED.unshift({
        providerId,
        at: Date.now(),
        state: entry.state,
        message: entry.message,
        credential: entry.result?.credential,
        nickname: entry.result?.nickname,
      })
      if (FINISHED.length > 20) FINISHED.length = 20
    })

  return { ok: true, state: 'waiting', message: '已在浏览器中打开登录页' }
}

/**
 * The state of the sign-in flows.
 *
 * @returns {{running: object[], finished: object[]}}
 */
export function loginStatus() {
  const running = [...RUNNING.values()].map((entry) => ({
    providerId: entry.providerId,
    state: entry.state,
    startedAt: entry.startedAt,
    message: entry.message,
  }))
  const finished = FINISHED.map((entry) => ({
    providerId: entry.providerId,
    at: entry.at,
    state: entry.state,
    message: entry.message,
    nickname: entry.nickname,
  }))
  return { running, finished }
}

/**
 * The credential of a flow that finished, if it succeeded.
 *
 * @param {string} providerId
 */
export function takeLoginResult(providerId) {
  const index = FINISHED.findIndex(
    (entry) => entry.providerId === providerId && entry.state === 'done' && !entry.taken,
  )
  if (index === -1) return null
  const entry = FINISHED[index]
  entry.taken = true
  return { credential: entry.credential, nickname: entry.nickname }
}
