/**
 * The daily claim for the third-party channels.
 *
 * Every provider that hands out a daily allowance has one account or more.
 * This service claims the daily allowance for EVERY account of EVERY enabled
 * provider, in one run — the user asked for exactly that, and there is no
 * reason to make them click once per account.
 *
 * The accounts are worked through one at a time on purpose: the upstreams
 * rate-limit per account and punish concurrency.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { APP_DIR } from '../config/paths.js'
import { PROVIDER_ORDER, providerById } from './providers.js'

/** Where the daily state is kept. */
const STATE_FILE = join(APP_DIR, 'channel-claim-state.json')

/** How often the scheduler looks at the clock. */
const TICK_MS = 60 * 1000

/** Retry backoff, in minutes, for a failed automatic run. */
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

/** What a claim attempt produced. */
function outcome(kind, credit, message, extra = {}) {
  return { kind, credit: Number(credit ?? 0) || 0, message: message ?? '', ...extra }
}

export class ChannelService {
  /** The cached status answer, so the UI poll does not hit the upstream. */
  #statusCache = null

  /**
   * @param {object} config
   * @param {{log: (line: string) => void}} [logger]
   * @param {object} options
   * @param {object} options.store the account store
   * @param {string} [options.stateFile] where the daily state is kept
   */
  constructor(config, logger = { log() {} }, options = {}) {
    this.config = config
    this.logger = logger
    this.store = options.store
    this.stateFile = options.stateFile ?? STATE_FILE
    this.state = readState(this.stateFile)
    this.timer = null
    this.running = false
    this.lastResult = null
  }

  /** The channel configuration, with the defaults filled in. */
  get settings() {
    const channels = this.config.channels ?? {}
    return {
      enabled: Boolean(channels.enabled),
      time: channels.time ?? '09:00',
      autoBenefits: channels.autoBenefits ?? true,
      /** Providers the user switched off. */
      disabledProviders: Array.isArray(channels.disabledProviders) ? channels.disabledProviders : [],
      /** Accounts the user switched off. */
      disabledAccounts: Array.isArray(channels.disabledAccounts) ? channels.disabledAccounts : [],
    }
  }

  /** Forget the cached status, so the next read goes out to the upstream. */
  invalidate() {
    this.#statusCache = null
  }

  /** Is this provider switched on? */
  providerEnabled(providerId) {
    return !this.settings.disabledProviders.includes(providerId)
  }

  /** Is this account switched on? */
  accountEnabled(accountId) {
    return !this.settings.disabledAccounts.includes(accountId)
  }

  /** The accounts that should be worked through, in a stable order. */
  #targets() {
    const targets = []
    for (const providerId of PROVIDER_ORDER) {
      if (!this.providerEnabled(providerId)) continue
      const provider = providerById(providerId)
      if (!provider) continue
      for (const account of this.store.listByProvider(providerId)) {
        if (account.enabled === false) continue
        if (!this.accountEnabled(account.id)) continue
        targets.push(account)
      }
    }
    return targets
  }

  /** The providers, with the number of accounts each one has. */
  providers() {
    return PROVIDER_ORDER.map((id) => {
      const provider = providerById(id)
      return {
        id,
        label: provider.label,
        color: provider.color,
        portal: provider.portal,
        claimable: provider.claimable,
        unit: provider.unit,
        enabled: this.providerEnabled(id),
        accounts: this.store.listByProvider(id).length,
      }
    })
  }

  /**
   * Read the check-in state and the balance of every account.
   *
   * The upstream is asked one account at a time, so this is deliberately not
   * parallel.
   */
  async status({ maxAgeMs = 60_000 } = {}) {
    const cached = this.#statusCache
    if (cached && Date.now() - cached.at < maxAgeMs) return cached.value

    const accounts = []
    for (const account of this.#targets()) {
      const provider = account.provider
      const row = {
        id: account.id,
        provider: account.providerId ?? account.provider,
        providerLabel: provider.label,
        color: provider.color,
        nickname: account.nickname,
        enabled: true,
      }

      if (typeof provider.status === 'function') {
        try {
          row.checkin = await provider.status(account.credential)
        } catch (error) {
          row.error = error.message
        }
      } else {
        row.checkin = null
        row.note = '该服务没有每日签到接口'
      }

      if (typeof provider.balance === 'function') {
        try {
          row.balance = await provider.balance(account.credential)
        } catch (error) {
          row.balanceError = error.message
        }
      }

      accounts.push(row)
    }

    const value = {
      today: localDayKey(),
      settings: this.settings,
      providers: this.providers(),
      accounts,
      lastRun: this.state.lastRun ?? null,
      lastAutoRun: this.state.lastAutoRun ?? null,
      lastResult: this.lastResult,
    }
    this.#statusCache = { at: Date.now(), value }
    return value
  }

  /**
   * Claim the daily allowance of every enabled account.
   *
   * @param {object} options
   * @param {boolean} [options.force] claim even when the upstream says the
   *   account already checked in
   * @param {string} [options.reason] `auto` or `manual`
   */
  async claim({ force = false, reason = 'manual' } = {}) {
    const today = localDayKey()
    const results = []

    for (const account of this.#targets()) {
      const provider = account.provider
      if (!provider.claimable) continue

      try {
        let before = null
        if (!force && typeof provider.status === 'function') {
          before = await provider.status(account.credential)
        }

        if (before?.todayCheckedIn) {
          results.push({
            accountId: account.id,
            provider: account.providerId ?? account.provider,
            nickname: account.nickname,
            outcome: outcome('already-claimed', 0, '今天已经领过了'),
          })
          continue
        }

        const raw = await provider.claim(account.credential)
        const kind = raw?.kind ?? 'failed'
        results.push({
          accountId: account.id,
          provider: account.providerId ?? account.provider,
          nickname: account.nickname,
          outcome: outcome(kind, raw?.credit, raw?.message, {
            cooldownSecs: raw?.cooldownSecs,
          }),
        })
      } catch (error) {
        results.push({
          accountId: account.id,
          provider: account.providerId ?? account.provider,
          nickname: account.nickname,
          outcome: outcome('failed', 0, error.message),
        })
      }
    }

    // The one-off rewards, which are not a daily thing.
    if (this.settings.autoBenefits !== false) {
      for (const account of this.#targets()) {
        const provider = account.provider
        if (!provider.onboarding) continue
        try {
          const raw = await provider.onboarding(account.credential)
          results.push({
            accountId: account.id,
            provider: account.providerId ?? account.provider,
            nickname: account.nickname,
            outcome: outcome(raw?.kind ?? 'failed', raw?.credit, raw?.message),
          })
        } catch (error) {
          results.push({
            accountId: account.id,
            provider: account.providerId ?? account.provider,
            nickname: account.nickname,
            outcome: outcome('failed', 0, error.message),
          })
        }
      }
    }

    const credit = results.reduce((sum, entry) => sum + (entry.outcome.credit ?? 0), 0)
    const summary = {
      at: Date.now(),
      day: today,
      reason,
      credit,
      results,
      ok: results.every((entry) => entry.outcome.kind !== 'failed'),
    }
    this.lastResult = summary
    this.#statusCache = null

    this.state.lastRun = { at: summary.at, day: today, reason, credit }
    if (reason === 'auto') {
      this.state.lastAutoRun = { at: summary.at, day: today, credit }
    }
    writeState(this.stateFile, this.state)

    this.logger.log(
      `[channels] ${reason} claim: ${results
        .map(
          (entry) =>
            `${entry.provider}/${entry.nickname}=${entry.outcome.kind === 'claimed' ? `+${entry.outcome.credit}` : entry.outcome.kind}`,
        )
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
   * configured time, unless today's automatic claim already happened.
   */
  async tick() {
    if (!this.settings.enabled) return null
    if (this.running) return null
    if (this.#claimedToday()) return null

    const now = new Date()
    if (minutesSinceMidnight(now) < parseClock(this.settings.time)) return null

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
        message: error.message,
      }
      writeState(this.stateFile, this.state)
      this.logger.log(`[channels] automatic claim failed: ${error.message}`)
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
    this.logger.log(`[channels] scheduler started (daily at ${this.settings.time})`)
  }

  /** Stop the scheduler. */
  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }
}
