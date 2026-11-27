/**
 * The daily credit service.
 *
 * WorkBuddy gives every signed-in account a daily check-in that pays out
 * credits. The upstream is idempotent, so claiming twice on the same day is
 * harmless — but the service still checks first, because a claim that was
 * skipped because the account had already checked in is a different fact
 * from a claim that paid out.
 *
 * The scheduler works on the LOCAL calendar day: the upstream counts the
 * check-in day in its own timezone, and the machine clock is what the user
 * reads.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { APP_DIR } from '../config/paths.js'
import { resolveSession } from '../upstream/session.js'
import {
  BillingError,
  claimBenefit,
  claimDailyCheckin,
  claimTravelReward,
  fetchBenefits,
  fetchCheckinStatus,
  fetchCredits,
  fetchGrowthStreak,
  fetchMessages,
  redeemGrowthTier,
} from '../upstream/credit.js'

/** Where the service remembers what it already did. */
const STATE_FILE = join(APP_DIR, 'credit-state.json')

/** How often the scheduler looks at the clock. */
const TICK_MS = 60 * 1000

/** Retry backoff, in minutes, for a failed automatic claim. */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60]
/** The local calendar day, as `YYYY-MM-DD`. */
export function localDayKey(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** Minutes since local midnight. */
export function minutesSinceMidnight(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes()
}

/** Parse `HH:MM` into minutes past midnight; fall back to 0. */
export function parseClock(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!match) return 0
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return 0
  return hours * 60 + minutes
}

/** Read the persisted state. */
function readState(path) {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/** Write the persisted state. */
function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}

export class CreditService {
  /** The cached status answer, so the UI poll does not hit the upstream. */
  #statusCache = null

  /** How the service gets a session; replaceable in the tests. */
  #resolveSession

  /**
   * @param {object} config
   * @param {{log: (line: string) => void}} [logger]
   * @param {object} [options]
   * @param {string} [options.stateFile] where the daily state is kept
   * @param {() => Promise<object>} [options.resolveSession] how to get a session
   */
  constructor(config, logger = { log() {} }, options = {}) {
    this.config = config
    this.logger = logger
    this.stateFile = options.stateFile ?? STATE_FILE
    this.#resolveSession = options.resolveSession ?? resolveSession
    this.state = readState(this.stateFile)
    this.timer = null
    this.running = false
    this.lastResult = null
  }

  /** The credit configuration, with the defaults filled in. */
  get settings() {
    return {
      enabled: Boolean(this.config.credit?.enabled),
      time: this.config.credit?.time ?? '09:00',
      autoBenefits: this.config.credit?.autoBenefits ?? true,
      ...this.config.credit,
    }
  }

  /** The account session, renewed if needed. */
  async session() {
    const resolved = await this.#resolveSession()
    return resolved.session
  }

  /**
   * Read everything the UI shows: the check-in state, the one-off campaigns,
   * the streak tiers and the balance.
   *
   * The UI polls every few seconds, so the answer is cached: the upstream
   * answers change once a day, and re-reading them on every poll would be
   * both wasteful and rude to the upstream.
   */
  async status({ maxAgeMs = 60_000 } = {}) {
    const cached = this.#statusCache
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.value

    const session = await this.session()
    const [checkin, benefits, streak, balance] = await Promise.all([
      fetchCheckinStatus(session).catch((error) => ({ error: error.message })),
      fetchBenefits(session).catch((error) => ({ error: error.message })),
      fetchGrowthStreak(session).catch((error) => ({ error: error.message })),
      fetchCredits(session).catch((error) => ({ error: error.message })),
    ])

    const value = {
      today: localDayKey(),
      settings: this.settings,
      checkin,
      benefits,
      streak,
      balance,
      lastClaim: this.state.lastClaim ?? null,
      lastRun: this.state.lastRun ?? null,
      lastAutoRun: this.state.lastAutoRun ?? null,
      lastResult: this.lastResult,
      stateFile: this.stateFile,
    }
    this.#statusCache = { at: Date.now(), value }
    return value
  }

  /**
   * Claim whatever can be claimed right now.
   *
   * Every channel is independent: a failure in one never stops the others,
   * because a closed campaign must not block the daily check-in.
   */
  async claim({ force = false, reason = 'manual' } = {}) {
    const session = await this.session()
    const today = localDayKey()
    const results = []

    // 1. The daily check-in — the one that pays out every day.
    try {
      const before = await fetchCheckinStatus(session)
      if (before.todayCheckedIn && !force) {
        results.push({
          channel: 'daily',
          ok: true,
          claimed: false,
          skipped: true,
          message: '今天已经签到过了',
          credit: 0,
          streakDays: before.streakDays,
        })
      } else {
        const claimed = await claimDailyCheckin(session)
        results.push({
          channel: 'daily',
          ok: true,
          claimed: true,
          credit: claimed.credit,
          streakDays: claimed.streakDays,
          isStreakDay: claimed.isStreakDay,
          message: `签到成功，积分 +${claimed.credit}`,
        })
      }
    } catch (error) {
      results.push({
        channel: 'daily',
        ok: false,
        claimed: false,
        credit: 0,
        message: describe(error),
      })
    }

    // 2. The one-off campaigns, while the upstream still has them open.
    if (this.settings.autoBenefits !== false) {
      const benefits = await fetchBenefits(session).catch(() => null)
      for (const [kind, info] of [
        ['compensation', benefits?.compensation],
        ['gift', benefits?.gift],
      ]) {
        if (!info || info.error) continue
        if (info.claimed) continue
        if (!info.active) continue
        try {
          const claimed = await claimBenefit(session, kind)
          results.push({
            channel: kind,
            ok: true,
            claimed: true,
            credit: claimed.credit,
            message: `${kind === 'gift' ? '新人礼' : '补偿活动'}领取成功，积分 +${claimed.credit}`,
          })
        } catch (error) {
          results.push({
            channel: kind,
            ok: false,
            claimed: false,
            credit: 0,
            message: describe(error),
          })
        }
      }
    }

    // 3. The streak tiers the upstream says are redeemable.
    try {
      const streak = await fetchGrowthStreak(session)
      for (const tier of streak.availableTiers ?? []) {
        try {
          const redeemed = await redeemGrowthTier(session, tier)
          results.push({
            channel: `streak-${tier}`,
            ok: true,
            claimed: true,
            credit: redeemed.credit,
            message: `连续签到 ${tier} 兑换成功，积分 +${redeemed.credit}`,
          })
        } catch (error) {
          results.push({
            channel: `streak-${tier}`,
            ok: false,
            claimed: false,
            credit: 0,
            message: describe(error),
          })
        }
      }
    } catch {
      /* the streak is optional; it must never break the daily claim */
    }

    // 4. A Buddy travel reward, when the message centre says one is waiting.
    try {
      const messages = await fetchMessages(session)
      const waiting = messages.find((message) => message.claimStatus === 'unclaimed')
      if (waiting) {
        try {
          const claimed = await claimTravelReward(session)
          results.push({
            channel: 'travel',
            ok: true,
            claimed: true,
            credit: claimed.credit || waiting.rewardCredit,
            message: `Buddy 旅行奖励领取成功，积分 +${claimed.credit || waiting.rewardCredit}`,
          })
        } catch (error) {
          results.push({
            channel: 'travel',
            ok: false,
            claimed: false,
            credit: 0,
            message: describe(error),
          })
        }
      }
    } catch {
      /* the message centre is optional too */
    }

    const credit = results.reduce((sum, entry) => sum + (entry.credit ?? 0), 0)
    const summary = {
      at: Date.now(),
      day: today,
      reason,
      credit,
      results,
      ok: results.every((entry) => entry.ok),
    }
    this.lastResult = summary
    this.#statusCache = null

    this.state.lastRun = { at: summary.at, day: today, reason, credit }
    if (reason === 'auto') {
      // The automatic claim is tracked on its own, so a later manual claim
      // cannot make the scheduler think the day is still open.
      this.state.lastAutoRun = { at: summary.at, day: today, credit }
    }
    if (results.some((entry) => entry.claimed)) {
      this.state.lastClaim = { at: summary.at, day: today, credit }
    }
    writeState(this.stateFile, this.state)

    this.logger.log(
      `[credit] ${reason} claim: ${results
        .map((entry) => `${entry.channel}=${entry.ok ? (entry.claimed ? `+${entry.credit}` : 'skip') : 'fail'}`)
        .join(', ')}`,
    )
    return summary
  }

  /** Has today's automatic claim already run? */
  #claimedToday() {
    return this.state.lastAutoRun?.day === localDayKey()
  }

  /** The number of failed automatic attempts so far today. */
  #failuresToday() {
    if (this.state.lastFailure?.day !== localDayKey()) return 0
    return Number(this.state.lastFailure?.count ?? 0)
  }

  /**
   * The scheduler tick.
   *
   * It runs once a minute and claims when the local clock has passed the
   * configured time, unless today's automatic claim already happened. A
   * failed claim is retried with a growing backoff.
   */
  async tick() {
    if (!this.settings.enabled) return null
    if (this.running) return null
    if (this.#claimedToday()) return null

    const now = new Date()
    const due = minutesSinceMidnight(now) >= parseClock(this.settings.time)
    if (!due) return null

    const failures = this.#failuresToday()
    if (failures >= BACKOFF_MINUTES.length) return null
    const nextAttemptAt = this.state.lastFailure?.nextAttemptAt ?? 0
    if (failures > 0 && now.getTime() < nextAttemptAt) return null

    this.running = true
    try {
      const summary = await this.claim({ reason: 'auto' })
      if (summary.ok) {
        this.state.lastFailure = null
      } else {
        const count = failures + 1
        this.state.lastFailure = {
          day: localDayKey(),
          count,
          nextAttemptAt: now.getTime() + BACKOFF_MINUTES[count - 1] * 60 * 1000,
        }
      }
      writeState(this.stateFile, this.state)
      return summary
    } catch (error) {
      const count = failures + 1
      this.state.lastFailure = {
        day: localDayKey(),
        count,
        nextAttemptAt: now.getTime() + BACKOFF_MINUTES[Math.min(count, BACKOFF_MINUTES.length) - 1] * 60 * 1000,
        message: describe(error),
      }
      writeState(this.stateFile, this.state)
      this.logger.log(`[credit] automatic claim failed: ${describe(error)}`)
      return null
    } finally {
      this.running = false
    }
  }

  /** Start the scheduler. */
  start() {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.tick().catch(() => {})
    }, TICK_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
    this.logger.log(`[credit] scheduler started (daily at ${this.settings.time})`)
  }

  /** Stop the scheduler. */
  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}

/** Turn an error into a message worth showing. */
function describe(error) {
  if (error instanceof BillingError) return error.message
  return error?.message ?? String(error)
}
