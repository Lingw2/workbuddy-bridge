/**
 * The bridge: one place that knows the account, the model directory and how
 * client-side model names map onto WorkBuddy model ids.
 *
 * A model of a third-party service is addressed as `service/model`; those
 * requests are sent to that service instead of to WorkBuddy.
 */
import { chatCompletion, fetchModels, readSse } from '../upstream/workbuddy.js'
import { resolveSession } from '../upstream/session.js'
import { rewriteChannelSpans } from './rewrite.js'
import { channelChat, canChat } from '../channels/chat.js'
import { providerById } from '../channels/providers.js'

/** Strip a ` (1M)` style suffix Codex puts on context-window variants. */
export function stripContextSuffix(id) {
  return String(id ?? '').replace(/\s*\(1M\)\s*$/i, '').trim()
}

/**
 * Split a `service/model` id.
 *
 * @param {string} id
 * @returns {{providerId: string, modelId: string}|null}
 */
export function splitScopedModel(id) {
  const text = String(id ?? '')
  const index = text.indexOf('/')
  if (index <= 0) return null
  const providerId = text.slice(0, index)
  const modelId = text.slice(index + 1)
  if (!providerId || !modelId) return null
  if (!providerById(providerId)) return null
  return { providerId, modelId }
}

/**
 * Build the map from client-facing model names onto WorkBuddy model ids.
 *
 * Codex asks for whatever slug is in the model catalogue; Claude asks for
 * `claude-*` names. Both are resolved here.
 *
 * @param {object[]} models the WorkBuddy model directory
 * @param {object} config
 */
export function buildAliasMap(models, config) {
  const map = new Map()
  const known = new Set(models.map((model) => model.id))

  // Every WorkBuddy model is reachable under its own id.
  for (const model of models) map.set(model.id, model.id)

  // The Claude route table maps `claude-*` names onto WorkBuddy models.
  for (const route of config.claude.routes ?? []) {
    if (!route.name) continue
    map.set(route.name, route.model)
    map.set(stripContextSuffix(route.name), route.model)
  }

  // Codex asks for a configured model; accept it as-is when the account has it.
  if (config.codex.model && known.has(config.codex.model)) {
    map.set(config.codex.model, config.codex.model)
  }

  // The default model is always a valid answer.
  const fallback = config.codex.model ?? config.claude.model
  if (fallback && known.has(fallback)) map.set('default', fallback)

  return map
}

/** The Claude-facing model list, in the shape Claude desktop expects. */
export function claudeModelRoster(config) {
  return (config.claude.routes ?? []).map((route) => ({
    id: route.name,
    display_name: route.name,
    description: route.model,
    max_input_tokens: 1_000_000,
    supports_1m: true,
    anthropic_family_tier: route.tier,
    is_family_default: Boolean(route.familyDefault),
  }))
}

/** A rough token estimate, enough for a count_tokens answer. */
export function estimateInputTokens(text) {
  if (typeof text !== 'string') return 0
  return Math.ceil(text.length / 3.6)
}

export class Bridge {
  /**
   * @param {object} config
   * @param {{log: (line: string) => void}} [logger]
   * @param {object} [options]
   * @param {object} [options.store] the account store of the third-party channels
   * @param {object} [options.catalog] the aggregate model directory
   */
  constructor(config, logger = { log() {} }, options = {}) {
    this.config = config
    this.logger = logger
    this.session = null
    this.models = []
    this.aliasMap = new Map()
    this.lastError = null
    this.lastModelRefresh = 0
    this.store = options.store ?? null
    this.catalog = options.catalog ?? null
  }

  /** Resolve the account session, renewing it if needed. */
  async ensureSession() {
    if (this.session) return this.session
    const resolved = await resolveSession()
    this.session = resolved.session
    if (resolved.refreshed) this.logger.log('[workbuddy] access token refreshed')
    return this.session
  }

  /** Read the model directory and rebuild the alias map. */
  async refreshModels() {
    const session = await this.ensureSession()
    const raw = await fetchModels(session)
    this.models = raw.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      description: model.descriptionZh ?? model.descriptionEn ?? '',
      contextWindow: model.maxInputTokens ?? model.contextWindow?.defaultLength ?? 0,
      maxOutputTokens: model.maxOutputTokens ?? 0,
      supportsImages: Boolean(model.supportsImages),
      supportsReasoning: Boolean(model.supportsReasoning),
      supportsToolCall: Boolean(model.supportsToolCall),
      onlyReasoning: Boolean(model.onlyReasoning),
      reasoningEfforts: model.reasoning?.supportedEfforts ?? [],
      creditMultiplier: model.creditMultiplier ?? null,
      tags: model.tags ?? [],
    }))
    this.aliasMap = buildAliasMap(this.models, this.config)
    this.lastModelRefresh = Date.now()
    this.logger.log(`[workbuddy] model directory: ${this.models.length} models`)
    return this.models
  }

  /** The cached model directory, reading it once if needed. */
  async models_() {
    if (this.models.length === 0) await this.refreshModels()
    return this.models
  }

  /** Resolve a client-facing model name onto a WorkBuddy model id. */
  resolveModel(name) {
    if (!name) return this.config.codex.model
    const stripped = stripContextSuffix(name)
    if (this.aliasMap.has(stripped)) return this.aliasMap.get(stripped)
    if (this.aliasMap.has(name)) return this.aliasMap.get(name)
    return stripped
  }

  /**
   * The account of a third-party service that should serve the request.
   *
   * The first account that is switched on wins; the user can switch accounts
   * off in the UI to force another one.
   *
   * @param {string} providerId
   */
  #channelAccount(providerId) {
    if (!this.store) return null
    const disabled = new Set(this.config.channels?.disabledAccounts ?? [])
    const accounts = this.store
      .listByProvider(providerId)
      .filter((account) => account.enabled !== false && !disabled.has(account.id))
    return accounts[0] ?? null
  }

  /**
   * Send the request to a third-party service instead of to WorkBuddy.
   *
   * @param {string} modelId a `service/model` id
   * @param {object} chatBody an OpenAI chat body
   * @returns {AsyncGenerator<object>|null} null when the id is not a channel id
   */
  async *#chatChannel(modelId, chatBody) {
    const scoped = splitScopedModel(modelId)
    if (!scoped) return null
    if (!canChat(scoped.providerId)) {
      throw new Error(`该服务暂不支持对话：${scoped.providerId}`)
    }

    const account = this.#channelAccount(scoped.providerId)
    if (!account) {
      throw new Error(`没有可用的账号：${scoped.providerId}，请先在界面里登录`)
    }

    const provider = providerById(scoped.providerId)
    const known = this.catalog?.get(modelId)
    const body = { ...chatBody, model: known?.upstreamId ?? scoped.modelId }

    // TRAE only accepts a model through the channel that publishes it, so the
    // channel of the chosen model is passed along with the request.
    if (provider?.id === 'trae') {
      const channel = known?.channel ?? account.credential?.channel
      if (channel) body.function = channel
    }

    this.logger.log(`[channel] ${scoped.providerId} -> ${scoped.modelId}`)

    let finishReason = 'stop'
    for await (const chunk of channelChat(scoped.providerId, account.credential, body)) {
      const reason = chunk?.choices?.[0]?.finish_reason
      if (reason) finishReason = reason
      yield chunk
    }
    return finishReason
  }

  /**
   * Run one chat completion and yield the upstream chunks.
   *
   * The upstream occasionally drops a connection mid-flight, so a failed
   * request is retried once before the error is handed to the caller.
   *
   * @param {object} chatBody an OpenAI chat body
   * @param {object} [options]
   * @param {string[]} [options.rewrites] which rewrite set to apply
   */
  async *chat(chatBody, { rewrites } = {}) {
    const wanted = chatBody?.model

    // A `service/model` id goes to that service, not to WorkBuddy.
    const scoped = splitScopedModel(wanted)
    if (scoped) {
      const stream = this.#chatChannel(wanted, chatBody)
      const first = await stream.next()
      if (!first.done) {
        yield first.value
        let next = first
        while (!next.done) {
          next = await stream.next()
          if (!next.done) yield next.value
        }
        return next.value ?? 'stop'
      }
      return 'stop'
    }

    const session = await this.ensureSession()
    const { body, applied } = rewriteChannelSpans(chatBody, rewrites)
    if (applied.length > 0) {
      this.logger.log(`[workbuddy] channel wording adjusted: ${applied.map((s) => `"${s}"`).join(' | ')}`)
    }

    let response = null
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await chatCompletion(session, body)
        break
      } catch (error) {
        lastError = error
        this.logger.log(`[workbuddy] upstream request failed (${attempt + 1}/2): ${error.message}`)
      }
    }
    if (!response) throw lastError

    let finishReason = 'stop'
    for await (const chunk of readSse(response)) {
      const reason = chunk?.choices?.[0]?.finish_reason
      if (reason) finishReason = reason
      yield chunk
    }
    return finishReason
  }
}
