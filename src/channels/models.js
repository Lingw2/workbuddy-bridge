/**
 * The model directory of the third-party channels.
 *
 * Every service publishes its models somewhere else, or nowhere at all, so
 * each provider gets its own reader here. The results are put into one shape
 * so the UI can list them together with the WorkBuddy models.
 *
 * A model that the upstream does not publish is simply not listed: the
 * fallback tables are only used when the upstream cannot be reached, and are
 * marked as such.
 */
import { createHash, randomUUID } from 'node:crypto'

const TIMEOUT_MS = 30_000

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

/** A number out of a record, whatever type it arrives as. */
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

/** A string out of a record. */
function str(record, key) {
  if (!record || typeof record !== 'object') return ''
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

/** A stable id from a model name, used to build the provider-scoped id. */
function slug(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** One model in the shape the rest of the app expects. */
function model(id, name, extra = {}) {
  return {
    id,
    name: name ?? id,
    contextWindow: extra.contextWindow ?? 0,
    maxOutputTokens: extra.maxOutputTokens ?? 0,
    supportsImages: Boolean(extra.supportsImages),
    supportsReasoning: Boolean(extra.supportsReasoning),
    supportsToolCall: true,
    reasoningEfforts: extra.reasoningEfforts ?? [],
    source: extra.source ?? 'upstream',
    ...extra,
  }
}

/* ------------------------------------------------------------------ */
/* LobsterAI                                                            */
/* ------------------------------------------------------------------ */

const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'

/**
 * The LobsterAI model list needs the key pair of the account, so the body is
 * built from the stored credential instead of the current clock.
 */
function lobsteraiKeyfromBody(credential) {
  const body = {
    uuid: credential.uuid ?? '',
    first_keyfrom: String(credential.first_keyfrom ?? ''),
    latest_keyfrom: String(credential.latest_keyfrom ?? ''),
    version: credential.version ?? '2026.9.4',
  }
  if (credential.user_id) body.user_id = String(credential.user_id)
  return body
}

function lobsteraiHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.access_token ?? ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'LobsterAI/0.1.0',
  }
}

async function lobsteraiModels(credential) {
  const body = lobsteraiKeyfromBody(credential)
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'string' && value.length > 0) query.set(key, value)
  }
  const result = await request(`${LOBSTERAI_API_BASE}/api/models/available?${query}`, {
    headers: lobsteraiHeaders(credential),
  })
  if (!result.ok) return null
  const records = Array.isArray(result.body?.data) ? result.body.data
    : Array.isArray(result.body?.data?.models) ? result.body.data.models
    : Array.isArray(result.body?.models) ? result.body.models
    : []
  const models = []
  for (const record of records) {
    const id = str(record, 'modelId') || str(record, 'id')
    if (!id) continue
    models.push(
      model(id, str(record, 'modelName') || id, {
        contextWindow: num(record, 'contextWindow') ?? 0,
        maxOutputTokens: num(record, 'maxTokens') ?? 0,
        supportsImages: record.supportsImage === true,
        supportsReasoning: record.supportsThinking === true,
        description: str(record, 'description'),
      }),
    )
  }
  return models
}

/* ------------------------------------------------------------------ */
/* Qoder                                                                */
/* ------------------------------------------------------------------ */

const QODER_FALLBACK_MODELS = [
  { id: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5', contextWindow: 200000, supportsImage: true },
  { id: 'claude-opus-4.1', name: 'Claude Opus 4.1', contextWindow: 200000, supportsImage: true },
  { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, supportsImage: true },
  { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', contextWindow: 256000 },
  { id: 'deepseek-v3.2', name: 'DeepSeek V3.2', contextWindow: 128000 },
]

async function qoderModels() {
  // Qoder publishes no model list, so the built-in table is the answer.
  return QODER_FALLBACK_MODELS.map((entry) =>
    model(entry.id, entry.name, {
      contextWindow: entry.contextWindow,
      supportsImages: entry.supportsImage === true,
      source: 'builtin',
    }),
  )
}

/* ------------------------------------------------------------------ */
/* TRAE                                                                 */
/* ------------------------------------------------------------------ */

const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru'
const TRAE_BATCH_MODELS_PATH = '/api/ide/v1/batch_get_detail_param'

/** The channels a model may be called through. */
const TRAE_CHANNELS = [
  'solo_agent',
  'solo_work_lite',
  'solo_agent_remote',
  'solo_work_remote',
  'solo_agent_lite',
  'chat_v3',
  'builder_v3',
  'solo_coder',
  'solo_design_lite',
  'solo_design_remote',
  'git_ai',
  'code_reviewer',
  'code_review_summary',
  'multimodal',
  'system_diagnosis',
]

function traeHeaders(credential) {
  const uid = credential.uid ?? credential.user_id ?? ''
  const digest = createHash('sha256').update(`${uid}:trae`).digest('hex')
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'Trae/0.1.52',
    Authorization: `Cloud-IDE-JWT ${credential.access_token ?? ''}`,
    'X-Cloudide-Token': credential.access_token ?? '',
    'X-Ide-Token': credential.access_token ?? '',
    'X-Uid': uid,
    'X-App-Id': '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    'X-App-Version': 'default',
    'X-Ide-Version': '0.1.52',
    'X-Ide-Version-Code': '20260811',
    'X-App-Version-Code': '20260811',
    'X-Ide-Version-Type': 'stable',
    'X-Device-Type': 'windows',
    'X-OS-Version': '10.0.19045',
    'X-Device-Brand': 'PC',
    'Request-Traffic-Type': 'prod',
    'X-Machine-Id': digest.slice(0, 32),
    'X-Device-Id': digest.slice(32, 47),
  }
}

/**
 * The models that are not meant to be talked to.
 *
 * The upstream lists helper models next to the chat models: the tools of the
 * IDE, the summary writers and the placeholders for a custom model the user
 * has not configured yet. They are of no use in a chat, so they are left out.
 */
const TRAE_NON_CHAT = [
  'placeholder',
  'title_generation',
  'input_optimization',
  'summary',
  'subagent',
  'sub_agent',
  'search_agent',
  'file_search_agent',
  'fast_apply',
  'code-review-judge',
  'computer_use',
  'browser_use',
  'code_review_summary',
]

/** Is this a model the user can talk to? */
function isTraeChatModel(id) {
  const text = String(id ?? '').toLowerCase()
  return !TRAE_NON_CHAT.some((fragment) => text.includes(fragment))
}

/**
 * Read the models out of the batch answer.
 *
 * The upstream lists one entry per channel, and every entry holds the models
 * that can be called through that channel. The name of the model is the
 * `config_name`; the `model_detail_list` inside it holds the `__max` and
 * `__dev` variants together with their token limits, and the context window
 * is the larger of the two window sizes.
 */
function parseTraeBatchModelList(payload) {
  const configs = Array.isArray(payload?.function_configs) ? payload.function_configs : []
  const models = []
  const seen = new Map()

  for (const config of configs) {
    const channel = str(config, 'function') || str(config, 'function_name')
    if (channel && !TRAE_CHANNELS.includes(channel)) continue
    const list = Array.isArray(config?.config_info_list) ? config.config_info_list : []

    for (const info of list) {
      if (info?.isHidden === true) continue
      const id = str(info, 'config_name') || str(info, 'id') || str(info, 'name')
      if (!id) continue
      if (!isTraeChatModel(id)) continue

      const windows = info?.context_window_tokens
      const contextWindow =
        (windows && typeof windows === 'object'
          ? num(windows, 'max') ?? num(windows, 'dev')
          : undefined) ??
        num(info, 'context_window') ??
        0

      const details = Array.isArray(info?.model_detail_list) ? info.model_detail_list : []
      const maxOutputTokens = details.reduce(
        (best, detail) => Math.max(best, num(detail, 'max_tokens') ?? 0),
        num(info, 'max_output_tokens') ?? 0,
      )

      const entry = model(id, str(info, 'display_name') || id, {
        contextWindow,
        maxOutputTokens,
        supportsImages: info?.display_config?.multimodal === true,
        supportsReasoning: details.some((detail) =>
          String(detail?.model_name ?? '').toLowerCase().includes('thinking'),
        ),
        channel,
        source: 'upstream',
      })

      // The same model can be listed by more than one channel. The first
      // channel of the list wins, because that is the one the tool prefers.
      const known = seen.get(id)
      if (!known) {
        seen.set(id, entry)
        models.push(entry)
      }
    }
  }
  return models
}

async function traeModels(credential) {
  const body = {
    functions: TRAE_CHANNELS,
    agent_type: '',
    current_config_info: { config_name: '', is_custom_model: false },
    mode_type: 0,
    access_type: 0,
    ab_force_vids: '',
    ab_autotest_advanced_mode: 0,
    show_custom_model: true,
  }
  const base = credential.baseUrl ?? TRAE_AGENT_HOST
  const result = await request(`${base.replace(/\/+$/, '')}${TRAE_BATCH_MODELS_PATH}`, {
    method: 'POST',
    headers: traeHeaders(credential),
    body: JSON.stringify(body),
  })
  if (!result.ok) return null
  return parseTraeBatchModelList(result.body)
}

/* ------------------------------------------------------------------ */
/* MiniMax                                                              */
/* ------------------------------------------------------------------ */

const MINIMAX_API_HOST = 'https://agent.minimax.cn'

function minimaxHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.access_token ?? ''}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
}

async function minimaxModels(credential) {
  const url = new URL(`${MINIMAX_API_HOST}/mavis/api/v1/models`)
  url.searchParams.set('region', 'cn')
  url.searchParams.set('buildEnv', 'prod')
  const result = await request(url.toString(), { headers: minimaxHeaders(credential) })
  if (!result.ok) return null
  const payload = result.body?.payload ?? result.body?.data?.payload ?? result.body
  // The providers arrive as a list, so the MiniMax one is looked up by its id.
  const list = Array.isArray(payload?.providers) ? payload.providers : []
  const provider = payload?.providers?.minimax ?? list.find((entry) => entry?.providerId === 'minimax')
  const configs = provider?.config ?? {}
  const order = Array.isArray(configs.model_order) ? configs.model_order : []
  const raw = configs.models && typeof configs.models === 'object' ? configs.models : {}

  // The models arrive as a dictionary, so the key is the id of the model and
  // the value only holds its limits.
  const entries = order.length > 0
    ? order.map((id) => [id, raw[id]]).filter(([, record]) => Boolean(record))
    : Object.entries(raw)

  const models = []
  for (const [key, record] of entries) {
    const id = str(record, 'id') || key
    if (!id) continue
    const limit = record.limit && typeof record.limit === 'object' ? record.limit : {}
    const options = Array.isArray(record.context_window_options)
      ? record.context_window_options.filter((value) => typeof value === 'number')
      : []
    const contextWindow = options.length > 0 ? Math.max(...options) : num(limit, 'context') ?? 0
    const modalities = record.modalities && typeof record.modalities === 'object' ? record.modalities : {}
    const inputs = Array.isArray(modalities.input) ? modalities.input : []
    models.push(
      model(id, str(record, 'name') || id, {
        contextWindow,
        maxOutputTokens: num(limit, 'output') ?? 0,
        supportsImages: inputs.includes('image'),
        supportsReasoning: Boolean(record.thinking_config),
        reasoningEfforts: Array.isArray(record.effort_options) ? record.effort_options : [],
      }),
    )
  }
  return models
}

/* ------------------------------------------------------------------ */
/* Loomy                                                                */
/* ------------------------------------------------------------------ */

const LOOMY_API_BASE = 'https://loomyad.xunfei.cn/api/v1'

function loomyHeaders(credential) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    token: credential.access_token ?? '',
  }
}

async function loomyModels(credential) {
  const base = credential.baseUrl ?? LOOMY_API_BASE
  const result = await request(`${base.replace(/\/+$/, '')}/models`, {
    headers: loomyHeaders(credential),
  })
  if (!result.ok) return null
  const payload = result.body?.data
  const list = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
    : Array.isArray(result.body) ? result.body
    : []
  const models = []
  for (const record of list) {
    const id = str(record, 'id') || str(record, 'name')
    if (!id) continue
    const capabilities = record.capabilities && typeof record.capabilities === 'object' ? record.capabilities : {}
    const modalities = Array.isArray(capabilities.input_modalities) ? capabilities.input_modalities : []
    models.push(
      model(id, str(record, 'name') || id, {
        contextWindow: num(record, 'context_length') ?? num(record, 'context_window') ?? 0,
        maxOutputTokens: num(record, 'max_tokens') ?? 0,
        supportsImages: modalities.includes('image'),
        supportsReasoning: capabilities.reasoning === true,
        reasoningEfforts: Array.isArray(capabilities.reasoning_efforts) ? capabilities.reasoning_efforts : [],
      }),
    )
  }
  return models
}

/* ------------------------------------------------------------------ */
/* Raccoon                                                              */
/* ------------------------------------------------------------------ */

const RACCOON_API_BASE = 'https://xiaohuanxiong.com'

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

async function raccoonModels(credential) {
  const base = credential.baseUrl ?? RACCOON_API_BASE
  const result = await request(`${base.replace(/\/+$/, '')}/api/web/llm/v2/model_catalog`, {
    headers: raccoonHeaders(credential),
  })
  if (!result.ok) return null
  if (num(result.body, 'code') !== undefined && num(result.body, 'code') !== 0) return null
  const categories = Array.isArray(result.body?.data?.categories) ? result.body.data.categories : []
  const models = []
  for (const category of categories) {
    if (str(category, 'type') !== 'chat') continue
    const list = Array.isArray(category.models) ? category.models : []
    for (const entry of list) {
      const id = str(entry, 'name')
      if (!id || entry.visible === false) continue
      const params = entry.params && typeof entry.params === 'object' ? entry.params : {}
      models.push(
        model(id, id, {
          contextWindow: num(params, 'context_window') ?? num(entry, 'context_window') ?? 0,
          maxOutputTokens: num(params, 'max_tokens') ?? 0,
          supportsImages: Array.isArray(entry.tags) && entry.tags.some((tag) => String(tag).toLowerCase() === 'vision'),
          source: 'upstream',
        }),
      )
    }
  }
  return models
}

/* ------------------------------------------------------------------ */
/* ZCode                                                                */
/* ------------------------------------------------------------------ */

const ZCODE_ORIGIN = 'https://zcode.z.ai'
const ZCODE_APP_VERSION = '3.14.3'

function zcodeHeaders(credential) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${credential.zcode_jwt ?? ''}`,
  }
}

async function zcodeModels(credential) {
  const appVersion = credential.app_version ?? ZCODE_APP_VERSION
  const url = `${ZCODE_ORIGIN}/api/v1/client/configs?app_version=${encodeURIComponent(appVersion)}&platform=unknown`
  const result = await request(url, { headers: zcodeHeaders(credential) })
  if (!result.ok) return null
  const builtins = result.body?.data?.builtinModels
  const list = Array.isArray(builtins) ? builtins
    : builtins && typeof builtins === 'object' ? Object.values(builtins)
    : []
  const models = []
  for (const record of list) {
    const id = str(record, 'id') || str(record, 'modelId')
    if (!id) continue
    const capabilities = record.capabilities && typeof record.capabilities === 'object' ? record.capabilities : {}
    const reasoning = capabilities.reasoning && typeof capabilities.reasoning === 'object' ? capabilities.reasoning : {}
    models.push(
      model(id, str(record, 'name') || id, {
        contextWindow: num(record, 'contextWindow') ?? num(record, 'context_window') ?? 0,
        maxOutputTokens: num(record, 'maxCompletionTokens') ?? num(record, 'maxTokens') ?? 0,
        supportsImages: capabilities.vision === true,
        supportsReasoning: Boolean(reasoning.levels && reasoning.levels.length > 0),
        reasoningEfforts: Array.isArray(reasoning.levels) ? reasoning.levels : [],
      }),
    )
  }
  return models
}

/* ------------------------------------------------------------------ */
/* Cline                                                                */
/* ------------------------------------------------------------------ */

const CLINE_API_BASE = 'https://api.cline.bot'

function clineHeaders(credential) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'X-IS-MULTIROOT': 'false',
    'X-CLIENT-TYPE': 'cline-sdk',
    ...credential.access_token ? { Authorization: `Bearer ${credential.access_token}` } : {},
  }
}

async function clineModels(credential) {
  const base = credential.baseUrl ?? CLINE_API_BASE
  const result = await request(`${base.replace(/\/+$/, '')}/api/v1/models`, {
    headers: clineHeaders(credential),
  })
  if (!result.ok) return null
  const list = Array.isArray(result.body?.data) ? result.body.data : []
  const models = []
  for (const record of list) {
    const id = str(record, 'id')
    if (!id) continue
    models.push(
      model(id, str(record, 'display_name') || str(record, 'name') || id, {
        contextWindow: num(record, 'context_window') ?? num(record, 'contextWindow') ?? 0,
        maxOutputTokens: num(record, 'max_tokens') ?? 0,
        supportsImages: record.supportsImages === true,
      }),
    )
  }
  return models
}

/* ------------------------------------------------------------------ */
/* Gemini                                                               */
/* ------------------------------------------------------------------ */

const GEMINI_ENDPOINT_DAILY = 'https://daily-cloudcode-pa.googleapis.com'

/** The models the Code Assist line hands out. */
const GEMINI_FALLBACK_MODELS = [
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', contextWindow: 1048576 },
  { id: 'gemini-3.8-pro', name: 'Gemini 3.8 Pro', contextWindow: 1048576 },
]

async function geminiModels() {
  // The Code Assist line does not publish a plain model list, so the built-in
  // table is used.
  return GEMINI_FALLBACK_MODELS.map((entry) =>
    model(entry.id, entry.name, { contextWindow: entry.contextWindow, source: 'builtin' }),
  )
}

/* ------------------------------------------------------------------ */
/* The registry                                                          */
/* ------------------------------------------------------------------ */

/** How each provider's model list is read. */
export const MODEL_READERS = {
  lobsterai: lobsteraiModels,
  qoder: qoderModels,
  qodercn: qoderModels,
  trae: traeModels,
  cline: clineModels,
  loomy: loomyModels,
  raccoon: raccoonModels,
  minimax: minimaxModels,
  zcode: zcodeModels,
  gemini: geminiModels,
}

/**
 * The models of one provider.
 *
 * @param {string} providerId
 * @param {object} credential
 * @returns {Promise<Array<object>|null>} null when the upstream could not be read
 */
export async function providerModels(providerId, credential) {
  const reader = MODEL_READERS[providerId]
  if (!reader) return null
  try {
    return await reader(credential)
  } catch {
    return null
  }
}

/** The provider-scoped id of a model, so two services can offer the same name. */
export function scopedModelId(providerId, modelId) {
  return `${providerId}/${slug(modelId)}`
}

/** A fresh request id, used by the chat calls. */
export function requestId() {
  return randomUUID()
}
