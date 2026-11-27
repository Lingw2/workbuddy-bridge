/**
 * The WorkBuddy billing / credit API.
 *
 * WorkBuddy hands out free credits through a handful of endpoints. The daily
 * check-in is the one that pays out every day; the others are one-off
 * campaigns that the upstream opens and closes on its own schedule.
 *
 * Everything here is a thin wrapper over the same wire calls the WorkBuddy
 * app makes, reusing the session the app already has.
 */
import { regionOf } from './workbuddy.js'

const CN_BILLING_BASE = 'https://www.codebuddy.cn'
const GLOBAL_BASE = 'https://www.workbuddy.ai'

const JSON_TIMEOUT_MS = 20_000

/**
 * The host that serves the billing API for a session.
 *
 * `WORKBUDDY_BILLING_BASE` overrides it, which is what lets the claim flow be
 * tested against a local stand-in for the upstream.
 */
export function billingBase(domain) {
  const override = process.env.WORKBUDDY_BILLING_BASE
  if (override) return override
  if (regionOf(domain) !== 'global') return CN_BILLING_BASE
  return GLOBAL_BASE
}

/**
 * Headers for a billing request.
 *
 * The upstream wants a browser-shaped request: the app identifies itself, and
 * an account without an enterprise id says so explicitly, because a missing
 * header and an empty one are not the same thing to it.
 */
export function billingHeaders(session) {
  const base = billingBase(session.domain)
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'WorkBuddy/5.11.3',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CodeBuddy-Request': '1',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    Origin: base,
    Referer: `${base}/`,
    Authorization: `Bearer ${session.accessToken}`,
  }
  if (session.uid) headers['X-User-Id'] = session.uid
  else headers['X-No-User-Id'] = '1'
  if (session.enterpriseId) {
    headers['X-Enterprise-Id'] = session.enterpriseId
    headers['X-Tenant-Id'] = session.enterpriseId
  } else {
    headers['X-No-Enterprise-Id'] = '1'
  }
  if (session.domain) headers['X-Domain'] = session.domain
  return headers
}

/**
 * A billing error that keeps the upstream's own code and message.
 *
 * The upstream uses the code to say "nothing to do here" as much as it uses
 * it to say "that failed", so the caller needs both.
 */
export class BillingError extends Error {
  constructor(message, { code = null, status = 0, path = '' } = {}) {
    super(message)
    this.name = 'BillingError'
    this.code = code
    this.status = status
    this.path = path
  }

  /** True when the upstream says there is nothing left to claim. */
  get alreadySettled() {
    const message = String(this.message)
    return (
      this.code === 10001 ||
      /已签到|已领取|已领过|限领一次|未开启|已过期|不能重复|no unclaimed|invalid redemption/i.test(
        message,
      )
    )
  }
}

/** Send one billing request and unwrap the `{code, data}` envelope. */
async function call(session, method, path, body) {
  const url = `${billingBase(session.domain)}${path}`
  let response
  try {
    response = await fetch(url, {
      method,
      headers: billingHeaders(session),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    })
  } catch (error) {
    throw new BillingError(`network error: ${error.message}`, { path })
  }

  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BillingError(
      `upstream returned non-JSON (${response.status}): ${text.slice(0, 200)}`,
      { status: response.status, path },
    )
  }

  if (!response.ok || (typeof parsed?.code === 'number' && parsed.code !== 0)) {
    throw new BillingError(parsed?.msg ?? `upstream ${response.status}`, {
      code: typeof parsed?.code === 'number' ? parsed.code : null,
      status: response.status,
      path,
    })
  }

  return parsed?.data ?? parsed
}

/**
 * The daily check-in status.
 *
 * `today_checked_in` is the answer to "has today already been claimed", which
 * is what makes the daily claim safe to call repeatedly.
 */
export async function fetchCheckinStatus(session) {
  const data = await call(session, 'POST', '/v2/billing/meter/checkin-activity-status', {})
  return {
    active: Boolean(data?.active),
    todayCheckedIn: Boolean(data?.today_checked_in),
    streakDays: Number(data?.streak_days ?? 0),
    dailyCredit: Number(data?.daily_credit ?? 0),
    todayCredit: Number(data?.today_credit ?? 0),
    isStreakDay: Boolean(data?.is_streak_day),
    streakBonusCredit: Number(data?.streak_bonus_credit ?? 0),
    totalCredits: Number(data?.total_credits ?? 0),
    themeName: data?.theme_name ?? '',
    startTime: data?.start_time ?? '',
    endTime: data?.end_time ?? '',
    claimButtonText: data?.claim_button_text ?? '',
  }
}

/**
 * Claim the daily check-in credit.
 *
 * The upstream is idempotent here: claiming twice on the same day answers
 * with code 10001 instead of paying out again.
 */
export async function claimDailyCheckin(session) {
  const data = await call(session, 'POST', '/v2/billing/meter/daily-checkin', {})
  return {
    credit: Number(data?.credit ?? 0),
    streakDays: Number(data?.streak_days ?? 0),
    isStreakDay: Boolean(data?.is_streak_day),
  }
}

/** The status of the two one-off campaigns: compensation and the gift. */
export async function fetchBenefits(session) {
  const read = async (path) => {
    try {
      const data = await call(session, 'POST', path, {})
      return {
        claimed: Boolean(data?.claimed),
        active: Boolean(data?.active),
        creditNum: Number(data?.credit_num ?? 0),
        endTime: data?.end_time ?? '',
        claimedAt: data?.claimed_at ?? '',
      }
    } catch (error) {
      return { error: error.message, claimed: false, active: false, creditNum: 0 }
    }
  }

  const [compensation, gift] = await Promise.all([
    read('/billing/meter/compensation-status'),
    read('/billing/meter/check-gift-claimed'),
  ])
  return { compensation, gift }
}

/** Claim one of the one-off campaigns. */
export async function claimBenefit(session, kind) {
  const path = kind === 'compensation'
    ? '/billing/meter/claim-compensation'
    : '/billing/meter/claim-gift'
  const data = await call(session, 'POST', path, {})
  return {
    kind,
    credit: Number(data?.credit ?? data?.credit_num ?? 0),
    alreadyClaimed: Boolean(data?.already_claimed),
  }
}

/**
 * The continuous check-in streak and the tiers it can be redeemed for.
 *
 * A tier is only redeemable when the upstream marks it `available`; the tiers
 * are worth 0 / 50 / 150 credits for 7 / 14 / 28 days.
 */
export async function fetchGrowthStreak(session) {
  const data = await call(session, 'GET', '/activity/growth/streak')
  const streak = data?.streak ?? {}
  const cards = data?.makeup_cards ?? {}
  const redemption = data?.redemption_status ?? {}
  const tiers = Array.isArray(redemption.tiers) ? redemption.tiers : []

  const available = []
  for (const tier of ['7d', '14d', '28d']) {
    if (redemption[`tier_${tier}_status`] === 'available') available.push(tier)
  }

  return {
    days: Number(streak.days ?? 0),
    monthTotalDays: Number(streak.month_total_days ?? 0),
    nextTier: streak.next_tier ?? '',
    nextTierRemaining: Number(streak.next_tier_remaining ?? 0),
    makeupCardBalance: Number(cards.balance ?? 0),
    availableTiers: available,
    tiers: tiers.map((tier) => ({
      tier: tier.tier,
      days: Number(tier.days ?? 0),
      credit: Number(tier.credit ?? 0),
      energy: Number(tier.energy ?? 0),
      cards: Number(tier.cards ?? 0),
    })),
  }
}

/** Redeem one streak tier. Only call this for a tier the upstream offered. */
export async function redeemGrowthTier(session, tier) {
  const data = await call(session, 'POST', '/activity/growth/redeem', { tier })
  return {
    tier,
    credit: Number(data?.credit ?? 0),
    energy: Number(data?.energy ?? 0),
    alreadyClaimed: Boolean(data?.already_claimed),
  }
}

/**
 * The credit balance.
 *
 * Personal accounts read the resource package table; enterprise members read
 * the enterprise usage table, because the personal one answers an enterprise
 * member with an empty list rather than a refusal.
 */
export async function fetchCredits(session) {
  if (session.enterpriseId) {
    const data = await call(session, 'POST', '/billing/meter/get-enterprise-user-usage', {})
    const limit = Number(data?.limitNum ?? 0)
    const used = Number(data?.credit ?? 0)
    return {
      kind: 'enterprise',
      total: limit,
      used,
      remaining: limit - used,
      cycleResetTime: data?.cycleResetTime ?? '',
      packages: [],
    }
  }

  const now = new Date()
  const format = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(
      date.getMinutes(),
    ).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`

  const data = await call(session, 'POST', '/v2/billing/meter/get-user-resource', {
    PageNumber: 1,
    PageSize: 100,
    ProductCode: 'p_tcaca',
    Status: [0, 3],
    PackageEndTimeRangeBegin: format(now),
    PackageEndTimeRangeEnd: format(new Date(now.getTime() + 365 * 24 * 3600 * 1000)),
  })

  const accounts = data?.Response?.Data?.Accounts ?? []
  const packages = accounts.map((account) => ({
    name: account.PackageName ?? '',
    code: account.PackageCode ?? '',
    remain: Number(account.CapacityRemain ?? 0),
    size: Number(account.CapacitySize ?? 0),
    used: Number(account.CapacityUsed ?? 0),
    expiresAt: account.ExpiredTime ?? '',
    cycleEndTime: account.CycleEndTime ?? '',
    source:
      account.AccountAttributes?.find((attribute) => attribute.Key === 'grantSource')?.Value ?? '',
  }))

  const total = packages.reduce((sum, entry) => sum + entry.size, 0)
  const remaining = packages.reduce((sum, entry) => sum + entry.remain, 0)

  return { kind: 'personal', total, used: total - remaining, remaining, packages }
}

/**
 * The Buddy travel reward.
 *
 * The upstream only pays this when a message in the message centre says a
 * trip arrived, so this is called after reading the messages.
 */
export async function claimTravelReward(session) {
  const data = await call(session, 'POST', '/activity/growth/buddy/travel/claim', {})
  return { credit: Number(data?.reward_credit ?? data?.credit ?? 0) }
}

/**
 * The message centre.
 *
 * Only the messages are read here, but they are what tells us a campaign is
 * running and whether a travel reward is waiting.
 */
export async function fetchMessages(session) {
  const data = await call(session, 'GET', '/v2/msg-center/message/list?limit=50')
  const messages = Array.isArray(data?.messages) ? data.messages : []
  return messages.map((message) => ({
    id: String(message.msg_id ?? ''),
    bizType: message.biz_type ?? '',
    title: message.title ?? '',
    content: message.content ?? '',
    createdAt: Number(message.created_at ?? 0),
    claimStatus: message?.ext?.claim_status ?? '',
    rewardCredit: Number(message?.ext?.reward_credit ?? 0),
  }))
}
