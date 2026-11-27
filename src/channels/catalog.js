/**
 * One model directory for everything the user can talk to.
 *
 * The WorkBuddy account has its own models, and every third-party service
 * publishes its own on a different endpoint with a different shape. The
 * catalog reads them all and puts them into one list, with the maker of every
 * model attached, so the picker can group them by the company that built
 * them.
 *
 * A model of a third-party service is addressed as `service/model`, so two
 * services can offer the same model name without colliding.
 */
import { providerModels, scopedModelId } from './models.js'
import { vendorOf, VENDORS } from './vendors.js'
import { providerById, PROVIDER_ORDER } from './providers.js'

/** The WorkBuddy account is not a "service" of the channel list. */
export const WORKBUDDY = 'workbuddy'

/**
 * The services that publish their models without an account.
 *
 * Qoder and Gemini do not have a model endpoint at all, so their built-in
 * table is the answer even when the user has not signed in yet.
 */
const BUILTIN_ONLY = new Set(['qoder', 'qodercn', 'gemini'])

export class ModelCatalog {
  /**
   * @param {object} config
   * @param {{log: (line: string) => void}} [logger]
   * @param {object} [options]
   * @param {object} [options.store] the account store
   */
  constructor(config, logger = { log() {} }, options = {}) {
    this.config = config
    this.logger = logger
    this.store = options.store ?? null
    this.models = []
    this.lastRefresh = 0
  }

  /** The channel settings that decide what is visible. */
  get settings() {
    const channels = this.config.channels ?? {}
    return {
      disabledProviders: Array.isArray(channels.disabledProviders) ? channels.disabledProviders : [],
      disabledModels: Array.isArray(channels.disabledModels) ? channels.disabledModels : [],
      providerModels:
        channels.providerModels && typeof channels.providerModels === 'object'
          ? { ...channels.providerModels }
          : {},
    }
  }

  /** Is this service switched off? */
  providerDisabled(providerId) {
    return this.settings.disabledProviders.includes(providerId)
  }

  /** Is this single model switched off? */
  modelDisabled(modelId) {
    return this.settings.disabledModels.includes(modelId)
  }

  /** The accounts of one service that may be used. */
  #accountsOf(providerId) {
    if (!this.store) return []
    const disabled = this.settings.disabledAccounts ?? []
    return this.store
      .listByProvider(providerId)
      .filter((account) => account.enabled !== false && !disabled.includes(account.id))
  }

  /**
   * Rebuild the directory.
   *
   * @param {object[]} [workbuddyModels] the models of the WorkBuddy account
   * @returns {Promise<object[]>} every model we know
   */
  async refresh(workbuddyModels = []) {
    const models = []

    for (const entry of workbuddyModels) {
      models.push({
        id: entry.id,
        name: entry.name ?? entry.id,
        description: entry.description ?? '',
        contextWindow: entry.contextWindow ?? 0,
        maxOutputTokens: entry.maxOutputTokens ?? 0,
        supportsImages: Boolean(entry.supportsImages),
        supportsReasoning: Boolean(entry.supportsReasoning),
        supportsToolCall: Boolean(entry.supportsToolCall),
        reasoningEfforts: entry.reasoningEfforts ?? [],
        source: WORKBUDDY,
        provider: WORKBUDDY,
        providerLabel: 'WorkBuddy',
        available: true,
        vendor: vendorOf(`${entry.name ?? ''} ${entry.id}`),
      })
    }

    for (const providerId of PROVIDER_ORDER) {
      const provider = providerById(providerId)
      if (!provider) continue

      const accounts = this.#accountsOf(providerId)
      let list = null

      for (const account of accounts) {
        const read = await providerModels(providerId, account.credential)
        if (read && read.length > 0) {
          list = read
          break
        }
      }

      if (!list && BUILTIN_ONLY.has(providerId)) {
        list = await providerModels(providerId, {})
      }
      if (!list) continue

      for (const entry of list) {
        models.push({
          ...entry,
          id: scopedModelId(providerId, entry.id),
          // The upstream is picky about the spelling of its model names, so
          // the name it published is kept next to our own id.
          upstreamId: entry.id,
          source: providerId,
          provider: providerId,
          providerLabel: provider.label,
          available: accounts.length > 0,
          vendor: vendorOf(`${entry.name ?? ''} ${entry.id}`),
        })
      }
    }

    this.models = models
    this.lastRefresh = Date.now()
    this.logger.log(
      `[catalog] ${models.length} models (${models.filter((m) => m.source === WORKBUDDY).length} WorkBuddy)`,
    )
    return models
  }

  /** Every model we know, including the ones that are switched off. */
  list() {
    return this.models
  }

  /** The models the user may pick. */
  visible() {
    return this.models.filter((model) => {
      if (model.source === WORKBUDDY) return true
      if (this.providerDisabled(model.source)) return false
      return !this.modelDisabled(model.id)
    })
  }

  /**
   * The visible models, grouped by the company that made them.
   *
   * @returns {Array<{id: string, label: string, color: string, models: object[]}>}
   */
  grouped() {
    const groups = new Map()
    for (const model of this.visible()) {
      const key = model.vendor?.id ?? 'unknown'
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(model)
    }
    return VENDORS.filter((vendor) => groups.has(vendor.id)).map((vendor) => ({
      id: vendor.id,
      label: vendor.label,
      color: vendor.color,
      models: groups.get(vendor.id),
    }))
  }

  /** The models of one service. */
  ofProvider(providerId) {
    return this.models.filter((model) => model.provider === providerId)
  }

  /** One model, by its id. */
  get(modelId) {
    return this.models.find((model) => model.id === modelId) ?? null
  }

  /**
   * The model each service uses when the user did not pick one.
   *
   * @param {string} providerId
   */
  defaultOf(providerId) {
    const chosen = this.settings.providerModels?.[providerId]
    if (chosen && this.models.some((model) => model.id === chosen)) return chosen
    const first = this.visible().find((model) => model.provider === providerId)
    return first?.id ?? null
  }
}
