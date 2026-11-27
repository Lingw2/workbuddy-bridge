/**
 * Connectivity and speed checks for the third-party channels.
 *
 * "Can I reach this service with this account?" and "how fast is it?" are two
 * different questions, so both are answered here: the probe runs a couple of
 * requests against the account's own endpoint and reports the round-trip
 * times it measured.
 */
import { PROVIDER_ORDER, providerById } from './providers.js'

/** How many samples one probe takes. */
const SAMPLES = 3

/** The smallest gap between two samples. */
const GAP_MS = 120

/** The timeout for one sample. */
const TIMEOUT_MS = 12_000

/**
 * Time one call of the provider's status endpoint.
 *
 * @returns {Promise<{ok: boolean, ms: number, error?: string}>}
 */
async function timeOnce(provider, credential) {
  const started = Date.now()
  try {
    if (typeof provider.status === 'function') {
      await provider.status(credential)
    } else if (typeof provider.balance === 'function') {
      await provider.balance(credential)
    } else {
      return { ok: false, ms: 0, error: '该服务没有可测试的接口' }
    }
    return { ok: true, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error.message }
  }
}

/** Wait a moment. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Probe one account.
 *
 * @param {object} account
 * @param {object} provider
 * @returns {Promise<object>} the probe result
 */
export async function probeAccount(account, provider) {
  const samples = []
  let lastError = ''

  for (let index = 0; index < SAMPLES; index++) {
    if (index > 0) await sleep(GAP_MS)
    const sample = await timeOnce(provider, account.credential)
    samples.push(sample)
    if (!sample.ok) lastError = sample.error ?? lastError
    // A failing account rarely recovers within the same probe.
    if (!sample.ok) break
  }

  const times = samples.filter((sample) => sample.ok).map((sample) => sample.ms)
  const ok = times.length > 0
  const average = ok ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : 0
  const fastest = ok ? Math.min(...times) : 0
  const slowest = ok ? Math.max(...times) : 0

  return {
    accountId: account.id,
    provider: account.providerId ?? account.provider,
    nickname: account.nickname,
    ok,
    averageMs: average,
    fastestMs: fastest,
    slowestMs: slowest,
    samples: samples.length,
    error: ok ? '' : lastError || '连接失败',
    /** A rough grade for the UI. */
    speed: !ok ? 'bad' : average < 400 ? 'fast' : average < 1200 ? 'ok' : 'slow',
  }
}

/**
 * Probe every account of every enabled provider.
 *
 * @param {object} options
 * @param {object} options.store the account store
 * @param {ChannelService} options.service the claim service
 * @returns {Promise<object>}
 */
export async function probeAll({ store, service }) {
  const results = []
  for (const providerId of PROVIDER_ORDER) {
    if (!service.providerEnabled(providerId)) continue
    const provider = providerById(providerId)
    if (!provider) continue

    for (const account of store.listByProvider(providerId)) {
      if (account.enabled === false) continue
      if (!service.accountEnabled(account.id)) continue
      results.push(await probeAccount(account, provider))
    }
  }

  const good = results.filter((row) => row.ok)
  return {
    at: Date.now(),
    results,
    summary: {
      total: results.length,
      reachable: good.length,
      averageMs: good.length
        ? Math.round(good.reduce((sum, row) => sum + row.averageMs, 0) / good.length)
        : 0,
    },
  }
}
