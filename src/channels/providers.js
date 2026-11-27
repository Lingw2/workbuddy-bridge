/**
 * The free third-party providers.
 *
 * Each provider is a service that hands out a daily allowance of model
 * credits when you check in. The endpoints below were read out of the "Our
 * Free Model" plugin's channel pack, which speaks to the same upstreams.
 *
 * Every provider is optional: the user can switch a provider off, and the
 * auto-claim never touches a provider that is switched off.
 */

/** Shared request helpers. */
import { createHash, randomUUID } from 'node:crypto'

const TIMEOUT_MS = 30_000

/** Read a number out of a record, whatever type it arrives as. */
function num(record, key) {
  if (!record || typeof record !== 'object') return undefined
  const value = record[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Read a string out of a record. */
function str(record, key) {
  if (!record || typeof record !== 'object') return ''
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/** A small deterministic byte stream, used to derive per-account device ids. */
function seededStream(seed, salt, byteCount) {
  const prefix = `${salt}:${seed}`
  const out = []
  let counter = 0
  while (out.length < byteCount) {
    const counterBuf = Buffer.alloc(4)
    counterBuf.writeInt32BE(counter, 0)
    const digest = createHash('sha256').update(prefix, 'utf8').update(counterBuf).digest()
    for (const byte of digest) {
      out.push(byte)
      if (out.length >= byteCount) break
    }
    counter++
  }
  return out.slice(0, byteCount)
}

/** A stable per-account device id. */
function seededDigits(count, seed, salt) {
  return seededStream(seed, salt, count)
    .map((byte) => String(byte % 10))
    .join('')
}

/** A stable per-account market user id, shaped like a UUID. */
function seededUuid(seed, salt) {
  const bytes = seededStream(seed, salt, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

/** A random id for one HTTP request. */
function uuidV4() {
  return randomUUID()
}

/** A request that always answers with `{ok, body, status, message}`. */
async function request(url, { method = 'GET', headers = {}, body, timeout = TIMEOUT_MS } = {}) {
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
    return {
      ok: false,
      status: response.status,
      body: null,
      message: `HTTP ${response.status}: ${text.trim().slice(0, 120)}`,
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    message: response.ok ? '' : `HTTP ${response.status}: ${text.trim().slice(0, 120)}`,
  }
}

/**
 * The base address of a provider.
 *
 * A credential may carry its own `baseUrl`, which is what the tests use to
 * point the provider at a local stand-in.
 */
function baseFor(credential, fallback) {
  const override = credential?.baseUrl
  if (typeof override === 'string' && override.length > 0) return override.replace(/\/+$/, '')
  return fallback
}

/** A provider that failed in a way worth showing the user. */
export class ChannelError extends Error {
  constructor(message, { code, status } = {}) {
    super(message)
    this.name = 'ChannelError'
    this.code = code
    this.status = status
  }
}

/* ------------------------------------------------------------------ */
/* LobsterAI (有道)                                                     */
/* ------------------------------------------------------------------ */

const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'
const LOBSTERAI_PORTAL_BASE = 'https://lobsterai.youdao.com'

function lobsteraiHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.access_token ?? ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'LobsterAI/0.1.0',
  }
}

async function lobsteraiSlot(credential) {
  const query = new URLSearchParams({
    placement: 'desktop_sidebar',
    clientVersion: '2026.9.4',
    containerApiVersion: '2',
    platform: 'win32',
  })
  const result = await request(`${LOBSTERAI_API_BASE}/api/client-activities/slot?${query}`, {
    headers: lobsteraiHeaders(credential),
  })
  if (!result.ok) return null
  const code = num(result.body, 'code')
  if (code !== undefined && code !== 0) return null
  const activity = result.body?.data?.activity
  return {
    slotState: str(result.body?.data, 'slotState'),
    activityCode: str(activity, 'activityCode'),
    configRevision: num(activity, 'configRevision') ?? 0,
  }
}

async function lobsteraiContext(credential, slot) {
  // The context lives under a /context suffix and needs the config revision.
  const query = new URLSearchParams({ configRevision: String(slot.configRevision) })
  const result = await request(
    `${LOBSTERAI_API_BASE}/api/client-activities/${encodeURIComponent(slot.activityCode)}/context?${query}`,
    { headers: lobsteraiHeaders(credential) },
  )
  if (!result.ok) return null
  const code = num(result.body, 'code')
  if (code !== undefined && code !== 0) return null
  const data = result.body?.data
  if (!data) return null
  const actions = Array.isArray(data.actions)
    ? data.actions.filter((entry) => typeof entry === 'string')
    : []
  return {
    claimedToday: data.state?.claimedToday === true || data.claimedToday === true,
    actions,
  }
}

export const lobsterai = {
  id: 'lobsterai',
  label: 'LobsterAI（有道）',
  color: '#FF6A00',
  portal: LOBSTERAI_PORTAL_BASE,
  /** The provider has a real daily check-in. */
  claimable: true,
  unit: 'credits',

  async status(credential) {
    const slot = await lobsteraiSlot(credential)
    if (!slot) return null
    const context = await lobsteraiContext(credential, slot)
    return {
      active: slot.slotState === 'available',
      todayCheckedIn: context?.claimedToday ?? false,
      dailyCredit: 0,
      message: slot.slotState === 'available' ? '' : `活动槽位不可用（${slot.slotState}）`,
    }
  },

  async claim(credential) {
    const slot = await lobsteraiSlot(credential)
    if (!slot) throw new ChannelError('活动槽位查询失败')
    if (slot.slotState !== 'available' || slot.activityCode.length === 0) {
      return { kind: 'inactive', message: `无可用活动（slotState=${slot.slotState}）` }
    }

    const context = await lobsteraiContext(credential, slot)
    if (!context) throw new ChannelError('活动上下文查询失败')
    if (context.claimedToday) return { kind: 'already-claimed', message: '今天已签到' }
    if (!context.actions.includes('check_in')) {
      return { kind: 'inactive', message: '当前不可签到' }
    }

    const result = await request(
      `${LOBSTERAI_API_BASE}/api/client-activities/${encodeURIComponent(slot.activityCode)}/actions/check_in`,
      {
        method: 'POST',
        headers: lobsteraiHeaders(credential),
        body: JSON.stringify({
          configRevision: slot.configRevision,
          idempotencyKey: uuidV4(),
          payload: {},
        }),
      },
    )
    if (!result.ok) throw new ChannelError(result.message || '签到请求失败', { status: result.status })

    const code = num(result.body, 'code')
    if (code !== undefined && code !== 0) {
      throw new ChannelError(str(result.body, 'msg') || `签到失败（code=${code}）`, { code })
    }

    const body = result.body?.data?.result ?? {}
    const credit = num(body, 'creditsGranted') ?? num(body, 'rewardCredits') ?? num(body, 'credits') ?? 0
    return { kind: 'claimed', credit, message: str(body, 'message') }
  },

  async balance(credential) {
    const result = await request(`${LOBSTERAI_API_BASE}/api/user/profile-summary`, {
      headers: lobsteraiHeaders(credential),
    })
    if (!result.ok) return null
    const data = result.body?.data
    if (!data) return null
    const items = Array.isArray(data.creditItems) ? data.creditItems : []
    const packages = items.map((item) => ({
      name: str(item, 'label') || str(item, 'type') || '积分包',
      unit: 'credit',
      remaining: num(item, 'creditsRemaining') ?? 0,
      total: 0,
      used: 0,
      active: true,
    }))
    return { total: num(data, 'totalCreditsRemaining') ?? 0, packages }
  },
}

/* ------------------------------------------------------------------ */
/* Qoder (阿里系)                                                        */
/* ------------------------------------------------------------------ */

const QODER = {
  qoder: {
    id: 'qoder',
    label: 'Qoder',
    color: '#615CED',
    portal: 'https://qoder.com',
    authBase: 'https://qoder.com',
    openApiBase: 'https://openapi.qoder.sh',
    clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
    sashClientType: '10',
  },
  qodercn: {
    id: 'qodercn',
    label: 'Qoder 中国版',
    color: '#7A6CF0',
    portal: 'https://qoder.cn',
    authBase: 'https://qoder.cn',
    openApiBase: 'https://openapi.qoder.com.cn',
    clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
    sashClientType: '10',
  },
}

function qoderHeaders(credential, product) {
  const token = credential.security_oauth_token || credential.access_token || ''
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
    'Cosy-ClientType': product.sashClientType,
    'User-Agent': 'Qoder',
  }
}

function makeQoder(product) {
  return {
    id: product.id,
    label: product.label,
    color: product.color,
    portal: product.portal,
    claimable: true,
    unit: 'credits',

    async status(credential) {
      const result = await request(`${product.openApiBase}/sash/api/v1/me/campaigns`, {
        headers: qoderHeaders(credential, product),
      })
      if (!result.ok) return null
      const campaigns = Array.isArray(result.body?.campaigns) ? result.body.campaigns : []
      const claimable = campaigns.filter(
        (campaign) =>
          campaign?.actionType === 'CLAIM_BENEFIT' &&
          campaign?.claimStatus !== 'CLAIMED' &&
          campaign?.claimStatus !== 'CLAIMING',
      )
      return {
        active: claimable.length > 0,
        todayCheckedIn: claimable.length === 0 && campaigns.length > 0,
        dailyCredit: 0,
        message: claimable.length === 0 ? '今天已领取' : '',
      }
    },

    async claim(credential) {
      const result = await request(`${product.openApiBase}/sash/api/v1/me/campaigns`, {
        headers: qoderHeaders(credential, product),
      })
      if (!result.ok) throw new ChannelError(result.message || '活动列表查询失败', { status: result.status })

      const campaigns = Array.isArray(result.body?.campaigns) ? result.body.campaigns : []
      const targets = campaigns.filter(
        (campaign) =>
          campaign?.actionType === 'CLAIM_BENEFIT' &&
          campaign?.claimStatus !== 'CLAIMED' &&
          campaign?.claimStatus !== 'CLAIMING',
      )

      if (targets.length === 0) {
        const claimedBefore = campaigns.some(
          (campaign) => campaign?.actionType === 'CLAIM_BENEFIT' && campaign?.claimStatus === 'CLAIMED',
        )
        return claimedBefore
          ? { kind: 'already-claimed', message: '今天已领取' }
          : { kind: 'inactive', message: '当前没有可领取的活动' }
      }

      let total = 0
      let firstError = null
      for (const target of targets) {
        const campaignId = target.campaignId ?? target.id
        const claim = await request(
          `${product.openApiBase}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`,
          {
            method: 'POST',
            headers: { ...qoderHeaders(credential, product), 'Content-Type': 'application/json' },
            body: '',
          },
        )
        if (!claim.ok) {
          if (!firstError) firstError = claim.message || '领取失败'
          continue
        }
        const body = claim.body?.result ?? claim.body
        if (body?.replayed === true) continue
        if (body?.status !== undefined && body.status !== 'CLAIMED') {
          if (!firstError) firstError = `领取未成功（status=${body.status}）`
          continue
        }
        total += num(body, 'amount') ?? 0
      }

      if (total > 0) return { kind: 'claimed', credit: total, message: '' }
      if (firstError) throw new ChannelError(firstError)
      return { kind: 'already-claimed', message: '今天已领取' }
    },

    async balance(credential) {
      const result = await request(`${product.openApiBase}/sash/api/v2/me/usage`, {
        headers: qoderHeaders(credential, product),
      })
      if (!result.ok) return null
      const total =
        num(result.body, 'available') ??
        num(result.body, 'remaining') ??
        num(result.body?.data, 'available') ??
        0
      return {
        total,
        packages: [{ name: '套餐额度', unit: 'credits', remaining: total, total, used: 0, active: true }],
      }
    },
  }
}

/* ------------------------------------------------------------------ */
/* TRAE (字节)                                                          */
/* ------------------------------------------------------------------ */

const TRAE_UG_HOST = 'https://api.trae.cn'
const TRAE_CONSOLE_HOST = 'https://www.trae.cn'
const TRAE_CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status'
const TRAE_CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim'

function traeHeaders(credential) {
  const uid = credential.uid ?? credential.user_id ?? credential.id ?? ''
  return {
    'Content-Type': 'application/json',
    Accept: '*/*',
    'Accept-Language': 'zh-CN',
    'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    Authorization: `Cloud-IDE-JWT ${credential.access_token ?? ''}`,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': seededUuid(uid, 'market'),
    'X-User-Region': 'CN',
    'X-Device-Id': seededDigits(15, uid, 'devid'),
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': 'stable_cn',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': '0.1.52',
    'X-Tt-Trace-Id': `00-${uuidV4().replace(/-/g, '')}-01`,
    'Vscode-Sessionid': seededStream(uid, 'sess', 32)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
    'X-Request-Id': uuidV4(),
  }
}

export const trae = {
  id: 'trae',
  label: 'TRAE（字节）',
  color: '#00BFA6',
  portal: TRAE_CONSOLE_HOST,
  claimable: true,
  unit: 'credits',

  async status(credential) {
    const result = await request(`${baseFor(credential, TRAE_UG_HOST)}${TRAE_CHECKIN_STATUS_PATH}`, {
      method: 'POST',
      headers: traeHeaders(credential),
      body: '{}',
    })
    if (!result.ok) return null
    const code = num(result.body, 'code')
    if (code !== undefined && code !== 0) return null
    return {
      active: result.body?.enable === true,
      todayCheckedIn: result.body?.checked_in === true,
      streakDays: num(result.body, 'streak_days') ?? 0,
      dailyCredit: num(result.body, 'credits') ?? 0,
      totalCredits: num(result.body, 'total_credits') ?? 0,
    }
  },

  async claim(credential) {
    const result = await request(`${baseFor(credential, TRAE_UG_HOST)}${TRAE_CHECKIN_CLAIM_PATH}`, {
      method: 'POST',
      headers: traeHeaders(credential),
      body: '{}',
    })
    if (!result.ok) throw new ChannelError(result.message || '签到请求失败', { status: result.status })

    const code = num(result.body, 'code')
    const message = str(result.body, 'message') || str(result.body, 'msg')
    if (code === 9074) {
      return { kind: 'failed', message: message || '签到人数过多，请稍后再试', cooldownSecs: 300 }
    }
    if (code !== undefined && code !== 0) {
      return { kind: 'failed', message: message || `签到失败（code=${code}）` }
    }

    const status = await trae.status(credential)
    return {
      kind: 'claimed',
      credit: status?.dailyCredit ?? 0,
      streakDays: status?.streakDays ?? 0,
    }
  },

  async balance(credential) {
    const result = await request(`${baseFor(credential, TRAE_UG_HOST)}/trae/api/v2/pay/ide_user_ent_usage`, {
      method: 'POST',
      headers: traeHeaders(credential),
      body: '{}',
    })
    if (!result.ok) return null
    const total = num(result.body, 'total_credits') ?? num(result.body?.data, 'total_credits') ?? 0
    return {
      total,
      packages: [{ name: '免费额度', unit: 'credits', remaining: total, total, used: 0, active: true }],
    }
  },
}

/* ------------------------------------------------------------------ */
/* MiniMax Code                                                         */
/* ------------------------------------------------------------------ */

const MINIMAX_API_HOST = 'https://agent.minimax.cn'
const MINIMAX_SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status'
const MINIMAX_SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'

/** The state of one day of the MiniMax check-in calendar. */
const MINIMAX_SIGNIN_STATUS = Object.freeze({
  Upcoming: 1,
  Claimable: 2,
  Claimed: 3,
  Disabled: 4,
})

/** The answer of the claim call. */
const MINIMAX_CLAIM_RESULT = Object.freeze({
  Claimed: 1,
  AlreadyClaimed: 2,
})

/** The kind of the check-in panel. */
const MINIMAX_PANEL_SCENE = Object.freeze({
  Unknown: 0,
  First: 1,
  Active: 2,
  Completed: 3,
  Broken: 4,
})

function minimaxHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.access_token ?? ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

/** The upstream wraps its payload in `{base_resp, data}`. */
function unwrapEnvelope(payload) {
  const nested = payload?.data
  return nested && typeof nested === 'object' && !Array.isArray(nested) ? nested : payload
}

/** The local timezone, as the upstream wants it. */
function timezoneId() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'Asia/Shanghai'
  }
}

export const minimax = {
  id: 'minimax',
  label: 'MiniMax Code',
  color: '#E4007F',
  portal: 'https://account.minimax.cn',
  claimable: true,
  unit: 'points',

  async status(credential) {
    const url = new URL(`${MINIMAX_API_HOST}${MINIMAX_SIGNIN_STATUS_PATH}`)
    url.searchParams.set('timezone_id', timezoneId())
    const result = await request(url.toString(), { headers: minimaxHeaders(credential) })
    if (!result.ok) return null

    const base = result.body?.base_resp
    if (base && num(base, 'status_code') !== undefined && num(base, 'status_code') !== 0) return null

    const data = unwrapEnvelope(result.body)
    // The panel is a seven day calendar; today carries is_today and a status.
    const days = Array.isArray(data?.days) ? data.days : []
    const today = days.find((day) => day?.is_today === true)
    const status = num(today, 'status')
    const claimedToday = status === MINIMAX_SIGNIN_STATUS.Claimed
    const streak = days
      .filter((day) => num(day, 'status') === MINIMAX_SIGNIN_STATUS.Claimed)
      .length
    return {
      active: data?.scene !== undefined && num(data, 'scene') !== MINIMAX_PANEL_SCENE.Unknown,
      todayCheckedIn: today ? claimedToday : null,
      streakDays: streak,
      dailyCredit: num(today, 'points') ?? 0,
    }
  },

  async claim(credential) {
    const url = new URL(`${MINIMAX_API_HOST}${MINIMAX_SIGNIN_CLAIM_PATH}`)
    url.searchParams.set('timezone_id', timezoneId())
    const result = await request(url.toString(), {
      method: 'POST',
      headers: minimaxHeaders(credential),
      body: '{}',
    })
    if (!result.ok) throw new ChannelError(result.message || '签到请求失败', { status: result.status })

    const base = result.body?.base_resp
    if (base && num(base, 'status_code') !== undefined && num(base, 'status_code') !== 0) {
      throw new ChannelError(str(base, 'status_msg') || '签到失败')
    }

    const data = unwrapEnvelope(result.body)
    const claimResult = num(data, 'claim_result')
    if (claimResult === 2) return { kind: 'already-claimed', message: '今日已签到' }
    if (claimResult !== 1) {
      return { kind: 'failed', message: '签到响应缺少有效的 claim_result' }
    }
    return { kind: 'claimed', credit: num(data, 'points') ?? 0 }
  },

  async balance(credential) {
    const url = new URL(`${MINIMAX_API_HOST}/minimax-cloud/api/v1/credit/details`)
    url.searchParams.set('timezone_id', timezoneId())
    const result = await request(url.toString(), { headers: minimaxHeaders(credential) })
    if (!result.ok) return null
    const data = unwrapEnvelope(result.body)
    const total = num(data, 'total_points') ?? num(data, 'balance') ?? 0
    return {
      total,
      packages: [{ name: '积分', unit: 'points', remaining: total, total, used: 0, active: true }],
    }
  },
}

/* ------------------------------------------------------------------ */
/* Loomy (讯飞)                                                          */
/* ------------------------------------------------------------------ */

const LOOMY_API_BASE = 'https://loomyad.xunfei.cn/api/v1'
const LOOMY_ACCOUNT_BASE = 'https://account.xfinfr.com'

function loomyHeaders(credential) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    token: credential.access_token ?? '',
  }
}

/** Loomy answers with `{code, msg, data}`; `000000` means fine. */
function loomyData(result) {
  if (!result.ok) throw new ChannelError(result.message || '请求失败', { status: result.status })
  const code = str(result.body, 'code')
  if (code && code !== '000000' && code !== '0') {
    throw new ChannelError(str(result.body, 'msg') || `业务错误 ${code}`)
  }
  return result.body?.data
}

export const loomy = {
  id: 'loomy',
  label: 'Loomy（讯飞）',
  color: '#2F6BFF',
  portal: 'https://loomy.xunfei.cn',
  accountBase: LOOMY_ACCOUNT_BASE,
  apiBase: LOOMY_API_BASE,
  claimable: true,
  unit: '积分',

  async status(credential) {
    const result = await request(
      `${LOOMY_API_BASE}/points/records?pageNo=1&pageSize=1&recordType=all`,
      { headers: loomyHeaders(credential) },
    )
    if (!result.ok) return null
    const data = loomyData(result)
    const daily = num(data, 'dailyBalance') ?? 0
    const consumed = num(data, 'dailyConsumed') ?? 0
    const quota = num(data, 'dailyQuota')
    // The upstream only reports the quota once the day was initialised, so
    // without it the state is unknown rather than "not claimed".
    return {
      active: true,
      todayCheckedIn: quota === undefined ? null : consumed >= quota,
      dailyCredit: quota ?? daily,
      dailyConsumed: consumed,
      dailyCycleDate: str(data, 'dailyCycleDate') ?? undefined,
    }
  },

  async claim(credential) {
    const result = await request(`${LOOMY_API_BASE}/points/first-login`, {
      method: 'POST',
      headers: loomyHeaders(credential),
      body: '{}',
    })
    if (!result.ok) throw new ChannelError(result.message || '请求失败', { status: result.status })
    const data = loomyData(result)
    if (data?.alreadyProcessed === true) {
      return { kind: 'already-claimed', message: '今日额度已初始化' }
    }
    const quota = num(data, 'dailyQuota') ?? 0
    const consumed = num(data, 'dailyConsumed') ?? 0
    return { kind: 'claimed', credit: Math.max(0, quota - consumed) }
  },

  async balance(credential) {
    const result = await request(
      `${LOOMY_API_BASE}/points/records?pageNo=1&pageSize=1&recordType=all`,
      { headers: loomyHeaders(credential) },
    )
    if (!result.ok) return null
    const data = loomyData(result)
    const permanent = num(data, 'balance') ?? 0
    const daily = num(data, 'dailyBalance') ?? 0
    const total = num(data, 'availableBalance') ?? permanent + daily
    return {
      total,
      packages: [
        { name: '永久积分', unit: '积分', remaining: permanent, total: permanent, used: 0, active: true },
        { name: '每日赠送', unit: '积分', remaining: daily, total: daily, used: 0, active: true },
      ],
    }
  },
}

/* ------------------------------------------------------------------ */
/* Raccoon (商汤)                                                        */
/* ------------------------------------------------------------------ */

const RACCOON_API_BASE = 'https://xiaohuanxiong.com'
const RACCOON_POINTS_PREFIX = '/api/web/points/v1'
const RACCOON_DESKTOP_PREFIX = '/api/web/desktop/v1'

function raccoonHeaders(credential) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.access_token ?? ''}`,
    'X-Org-Code': credential.office_identity ?? '',
    'X-Raccoon-Language': 'zh',
    'X-Client-Platform': 'desktop-windows',
    'X-Client-Version': 'v1.0.35',
  }
}

export const raccoon = {
  id: 'raccoon',
  label: 'Raccoon（商汤）',
  color: '#00A6A6',
  portal: 'https://xiaohuanxiong.com',
  claimable: false,
  /** Raccoon has no daily check-in; it pays a one-off login reward. */
  onboarding: true,
  unit: '积分',

  async status(credential) {
    const result = await request(`${RACCOON_API_BASE}${RACCOON_POINTS_PREFIX}/balance`, {
      headers: raccoonHeaders(credential),
    })
    if (!result.ok) return null
    const data = result.body?.data ?? result.body
    if (!data) return null
    return {
      active: true,
      todayCheckedIn: false,
      dailyCredit: num(data, 'daily_points') ?? 0,
    }
  },

  async claim(credential) {
    // No daily check-in; the daily allowance is simply granted.
    return { kind: 'inactive', message: 'Raccoon 没有每日签到，登录奖励自动到账' }
  },

  async onboarding(credential) {
    const result = await request(
      `${RACCOON_API_BASE}${RACCOON_DESKTOP_PREFIX}/login/points/grant`,
      { method: 'POST', headers: raccoonHeaders(credential), body: '{}' },
    )
    if (!result.ok) {
      return { kind: 'already-claimed', message: result.message || '登录奖励已领取' }
    }
    const data = result.body?.data ?? result.body
    return { kind: 'claimed', credit: num(data, 'points') ?? num(data, 'grant_points') ?? 0 }
  },

  async balance(credential) {
    const result = await request(`${RACCOON_API_BASE}${RACCOON_POINTS_PREFIX}/balance`, {
      headers: raccoonHeaders(credential),
    })
    if (!result.ok) return null
    const data = result.body?.data ?? result.body
    if (!data) return null
    const total = num(data, 'available_points') ?? 0
    const packages = []
    const push = (name, value) => {
      if (value === undefined) return
      packages.push({ name, unit: '积分', remaining: value, total: value, used: 0, active: true })
    }
    push('奖励积分', num(data, 'reward_points'))
    push('每日积分', num(data, 'daily_points'))
    push('会员积分', num(data, 'monthly_points'))
    push('充值积分', num(data, 'topup_points'))
    if (packages.length === 0) packages.push({ name: '可用积分', unit: '积分', remaining: total, total, used: 0, active: true })
    return { total, packages }
  },
}

/* ------------------------------------------------------------------ */
/* ZCode (智谱)                                                          */
/* ------------------------------------------------------------------ */

const ZCODE_ORIGIN = 'https://zcode.z.ai'
const ZCODE_BILLING_BALANCE_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/balance`
const ZCODE_BILLING_PREVIEW_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/preview`
const ZCODE_BILLING_CLAIM_URL = `${ZCODE_ORIGIN}/api/v1/zcode-plan/billing/claim`
const ZCODE_APP_VERSION_FALLBACK = '3.14.3'

function zcodeHeaders(credential, { authorization } = {}) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...authorization ? { Authorization: authorization } : {},
  }
}

export const zcode = {
  id: 'zcode',
  label: 'ZCode（智谱）',
  color: '#3B6EF6',
  portal: ZCODE_ORIGIN,
  claimable: true,
  unit: 'tokens',

  async status(credential) {
    const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
    const result = await request(
      `${ZCODE_BILLING_PREVIEW_URL}?app_version=${encodeURIComponent(appVersion)}&platform=win32`,
      {
        headers: zcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt ?? ''}` }),
      },
    )
    if (!result.ok) return null
    const plans = Array.isArray(result.body?.data?.plans) ? result.body.data.plans : []
    return {
      active: plans.length > 0,
      // The claim endpoint always wants a captcha, so the state of the day is
      // not visible from the outside.
      todayCheckedIn: null,
      dailyCredit: 0,
      message: plans.length === 0 ? '没有可领取的套餐' : '',
    }
  },

  async claim(credential) {
    const appVersion = credential.app_version ?? ZCODE_APP_VERSION_FALLBACK
    const result = await request(
      `${ZCODE_BILLING_CLAIM_URL}?app_version=${encodeURIComponent(appVersion)}&platform=win32`,
      {
        method: 'POST',
        headers: zcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt ?? ''}` }),
        body: '{}',
      },
    )
    if (!result.ok) {
      // The upstream always asks for a captcha on this endpoint and the
      // verification runs before the plan is even looked at.
      const bodyCode = num(result.body, 'code')
      if (bodyCode === 3007 || result.status === 400) {
        throw new ChannelError('上游要求人机验证，需要在官网手动领取', {
          status: result.status,
          code: bodyCode ?? 3007,
        })
      }
      throw new ChannelError(result.message || '领取失败', { status: result.status })
    }
    const data = result.body?.data ?? result.body
    const code = num(result.body, 'code')
    if (code !== undefined && code !== 0 && code !== 1003) {
      // 1003 means the package was already taken today.
      if (code === 1003) return { kind: 'already-claimed', message: '今天已经领过了' }
      throw new ChannelError(str(result.body, 'msg') || `领取失败（code=${code}）`, { code })
    }
    return {
      kind: 'claimed',
      credit: num(data, 'amount') ?? num(data, 'credits') ?? 0,
      message: str(data, 'message'),
    }
  },

  async balance(credential) {
    const result = await request(ZCODE_BILLING_BALANCE_URL, {
      headers: zcodeHeaders(credential, { authorization: `Bearer ${credential.zcode_jwt ?? ''}` }),
    })
    if (!result.ok) return null
    const data = result.body?.data
    if (!data) return null
    const buckets = (Array.isArray(data.balances) ? data.balances : []).map((item) => ({
      name: str(item, 'show_name') || str(item, 'plan_id') || '额度',
      unit: str(item, 'unit_type') || 'token',
      remaining: num(item, 'available_units') ?? num(item, 'remaining_units') ?? 0,
      total: num(item, 'total_units') ?? 0,
      used: num(item, 'used_units') ?? 0,
      active: true,
    }))
    const total = buckets.reduce((sum, bucket) => sum + bucket.remaining, 0)
    return { total, packages: buckets }
  },
}

/* ------------------------------------------------------------------ */
/* The registry                                                          */
/* ------------------------------------------------------------------ */

/** Every provider we know how to talk to, keyed by its id. */
export const PROVIDERS = {
  lobsterai,
  qoder: makeQoder(QODER.qoder),
  qodercn: makeQoder(QODER.qodercn),
  trae,
  cline: {
    id: 'cline',
    label: 'Cline',
    color: '#5B5BD6',
    portal: 'https://cline.bot',
    claimable: false,
    unit: 'dollars',
  },
  loomy,
  raccoon,
  minimax,
  zcode,
  gemini: {
    id: 'gemini',
    label: 'Gemini Code Assist',
    color: '#4285F4',
    portal: 'https://codeassist.google',
    claimable: false,
    unit: 'quota',
  },
}

/** The order the UI shows the providers in. */
export const PROVIDER_ORDER = [
  'lobsterai',
  'qoder',
  'qodercn',
  'trae',
  'cline',
  'loomy',
  'raccoon',
  'minimax',
  'zcode',
  'gemini',
]

/** Look up a provider by id. */
export function providerById(id) {
  return PROVIDERS[id] ?? null
}
