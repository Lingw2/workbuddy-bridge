/**
 * Talking to the models of the third-party channels.
 *
 * Every service speaks its own dialect: some answer with the OpenAI chat
 * format, some with the Anthropic message format and one with a custom
 * stream. All of them are turned into the OpenAI chunk shape here, so the
 * gateway can hand the same chunks to the Codex and the Claude writers.
 */
import { createHash } from 'node:crypto'

const TIMEOUT_MS = 120_000

/** A number out of a record. */
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

/** An OpenAI chunk that carries text. */
function textChunk(text, { reasoning = false } = {}) {
  const delta = reasoning ? { reasoning_content: text } : { content: text }
  return { id: 'chatcmpl-channel', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] }
}

/** An OpenAI chunk that carries a tool call. */
function toolChunk(call, finish = false) {
  return {
    id: 'chatcmpl-channel',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        delta: finish
 ? { tool_calls: [call] } : { tool_calls: [call] },
        finish_reason: finish ? 'tool_calls' : null,
      },
    ],
  }
}

/** The final OpenAI chunk. */
function finalChunk(reason = 'stop', usage = null) {
  const chunk = {
    id: 'chatcmpl-channel',
    object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
  }
  if (usage) chunk.usage = usage
  return chunk
}

/**
 * Read a byte stream as server-sent events.
 *
 * @param {Response} response
 * @returns {AsyncGenerator<{event: string, data: string}>}
 */
export async function* readSseEvents(response) {
  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const parsed = parseSseBlock(block)
      if (parsed) yield parsed
      index = buffer.indexOf('\n\n')
    }
  }

  const tail = parseSseBlock(buffer)
  if (tail) yield tail
}

/** One SSE block into `{event, data}`. */
function parseSseBlock(block) {
  let event = 'message'
  const dataLines = []
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (dataLines.length === 0) return null
  const data = dataLines.join('\n')
  if (data === '[DONE]') return { event: 'done', data: '' }
  return { event, data }
}

/* ------------------------------------------------------------------ */
/* OpenAI-shaped services                                                */
/* ------------------------------------------------------------------ */

/** The endpoints that answer with the OpenAI chat format. */
const OPENAI_SERVICES = {
  lobsterai: {
    path: '/api/proxy/v1/chat/completions',
    headers: (credential) => ({
      Authorization: `Bearer ${credential.access_token ?? ''}`,
      Accept: 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'LobsterAI/0.1.0',
    }),
    base: 'https://lobsterai-server.youdao.com',
  },
  loomy: {
    path: '/chat/completions',
    headers: (credential) => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential.access_token ?? ''}`,
      token: credential.access_token ?? '',
    }),
    base: 'https://loomyad.xunfei.cn/api/v1',
  },
  raccoon: {
    path: '/api/web/llm/v2/chat/completions',
    headers: (credential) => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential.access_token ?? ''}`,
      'X-Org-Code': credential.office_identity ?? '',
      'X-Raccoon-Language': 'zh',
      'X-Client-Platform': 'desktop-windows',
      'X-Client-Version': 'v1.0.35',
    }),
    base: 'https://xiaohuanxiong.com',
  },
  cline: {
    path: '/api/v1/chat/completions',
    headers: (credential) => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://cline.bot',
      'X-Title': 'Cline',
      'X-IS-MULTIROOT': 'false',
      'X-CLIENT-TYPE': 'cline-sdk',
      ...credential.access_token ? { Authorization: `Bearer ${credential.access_token}` } : {},
    }),
    base: 'https://api.cline.bot',
  },
}

/** An OpenAI-shaped chat call. */
async function* openAiChat(service, credential, body, signal) {
  const base = (credential.baseUrl ?? service.base).replace(/\/+$/, '')
  const response = await fetch(`${base}${service.path}`, {
    method: 'POST',
    headers: service.headers(credential),
    body: JSON.stringify({ ...body, stream: true }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${text.trim().slice(0, 160)}`)
  }

  for await (const event of readSseEvents(response)) {
    if (event.event === 'done') break
    if (!event.data) continue
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      continue
    }
    if (parsed.error) {
      throw new Error(str(parsed.error, 'message') || '上游返回错误')
    }
    yield parsed
  }
}

/* ------------------------------------------------------------------ */
/* Anthropic-shaped services                                             */
/* ------------------------------------------------------------------ */

const MINIMAX_API_HOST = 'https://agent.minimax.cn'
const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** The services that answer with the Anthropic message format. */
const ANTHROPIC_SERVICES = {
  minimax: {
    path: '/mavis/api/v1/llm/v1/messages',
    base: MINIMAX_API_HOST,
    headers: (credential) => ({
      Authorization: `Bearer ${credential.access_token ?? ''}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }),
  },
  zcode: {
    path: '/api/v1/zcode-plan/anthropic/v1/messages',
    base: ZCODE_ORIGIN,
    headers: (credential) => ({
      Authorization: `Bearer ${credential.zcode_jwt ?? ''}`,
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    }),
  },
}

/**
 * Read an error the upstream answered with a plain JSON body.
 *
 * Some services answer a request that cannot be served with a JSON error
 * object instead of a stream, so the body has to be looked at before the
 * stream is read.
 *
 * @param {Response} response
 * @returns {Promise<string>} the error message, or an empty string
 */
async function readJsonError(response) {
  const type = response.headers.get('content-type') ?? ''
  if (!type.includes('application/json')) return ''
  let parsed = null
  try {
    parsed = await response.json()
  } catch {
    return ''
  }
  const code = parsed?.code
  const message = str(parsed, 'msg') || str(parsed, 'message') || str(parsed, 'error')
  if (!message) return ''
  return code ? `HTTP ${response.status} (${code}): ${message}` : `HTTP ${response.status}: ${message}`
}

/** An Anthropic-shaped chat call, turned into OpenAI chunks. */
async function* anthropicChat(service, credential, body, signal) {
  const base = (credential.baseUrl ?? service.base).replace(/\/+$/, '')
  const response = await fetch(`${base}${service.path}`, {
    method: 'POST',
    headers: service.headers(credential),
    body: JSON.stringify({ ...body, stream: true, max_tokens: body.max_tokens ?? 32000 }),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${text.trim().slice(0, 160)}`)
  }

  const failure = await readJsonError(response)
  if (failure) throw new Error(failure)

  let stopReason = 'stop'
  for await (const event of readSseEvents(response)) {
    if (event.event === 'done') break
    if (!event.data) continue
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      continue
    }
    const type = str(parsed, 'type')

    if (type === 'error') {
      throw new Error(str(parsed.error, 'message') || '上游返回错误')
    }
    if (type === 'content_block_delta') {
      const delta = parsed.delta ?? {}
      const kind = str(delta, 'type')
      if (kind === 'thinking_delta') {
        const text = str(delta, 'thinking')
        if (text) yield textChunk(text, { reasoning: true })
      } else if (kind === 'text_delta') {
        const text = str(delta, 'text')
        if (text) yield textChunk(text)
      } else if (kind === 'input_json_delta') {
        const text = str(delta, 'partial_json')
        if (text) {
          yield toolChunk({
            index: num(parsed, 'index') ?? 0,
            id: `call_${num(parsed, 'index') ?? 0}`,
            type: 'function',
            function: { name: '', arguments: text },
          })
        }
      }
    } else if (type === 'message_delta') {
      const reason = str(parsed.delta, 'stop_reason')
      if (reason === 'tool_use') stopReason = 'tool_calls'
      else if (reason === 'max_tokens') stopReason = 'length'
    } else if (type === 'message_start') {
      const usage = parsed.message?.usage
      if (usage) {
        yield {
          id: 'chatcmpl-channel',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          usage: {
            prompt_tokens: num(usage, 'input_tokens') ?? 0,
            completion_tokens: num(usage, 'output_tokens') ?? 0,
            total_tokens: (num(usage, 'input_tokens') ?? 0) + (num(usage, 'output_tokens') ?? 0),
          },
        }
      }
    }
  }

  yield finalChunk(stopReason)
}

/* ------------------------------------------------------------------ */
/* TRAE                                                                 */
/* ------------------------------------------------------------------ */

const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru'
const TRAE_FUNCTION = 'solo_work_lite'

function traeHeaders(credential) {
  const uid = credential.uid ?? credential.user_id ?? ''
  const digest = createHash('sha256').update(`${uid}:trae`).digest('hex')
  return {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
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
 * The TRAE SOLO chat call.
 *
 * TRAE speaks a slightly different dialect than the OpenAI format: the
 * message content has to be a list of blocks, the tool calls live under
 * `function_call`, the tool schemas are a JSON string and the model is named
 * twice, once as `config_name` and once as `model`.
 */
async function* traeChat(credential, body, signal) {
  const base = (credential.baseUrl ?? TRAE_AGENT_HOST).replace(/\/+$/, '')

  const messages = (body.messages ?? []).map((message) => {
    const result = { ...message }
    if (result.role === 'assistant' && Array.isArray(result.tool_calls)) {
      const kept = []
      for (const call of result.tool_calls) {
        if (!call || typeof call !== 'object') continue
        const entry = { ...call }
        if (entry.function && typeof entry.function === 'object') {
          entry.function_call = entry.function
          delete entry.function
        }
        if (!entry.function_call || typeof entry.function_call.name !== 'string') continue
        if (entry.function_call.name.trim().length === 0) continue
        kept.push(entry)
      }
      if (kept.length > 0) result.tool_calls = kept
      else delete result.tool_calls
    }
    if (typeof result.content === 'string') {
      result.content = [{ type: 'text', text: result.content }]
    }
    return result
  })

  // The model name may carry a `__max` or `__dev` suffix; the upstream knows
  // the model under its plain name.
  const name = String(body.model ?? '')
  const configName = name.includes('__') ? name.split('__')[0] : name

  const payload = { ...body, stream: true, messages }
  payload.function = body.function || credential.channel || TRAE_FUNCTION
  payload.config_name = configName
  payload.model = configName

  // The tool schemas travel as a JSON string.
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    const tools = []
    for (const tool of payload.tools) {
      const fn = tool?.function
      if (!fn) continue
      const entry = { ...tool, function: { ...fn } }
      if (entry.function.parameters && typeof entry.function.parameters === 'object') {
        entry.function.parameters = JSON.stringify(entry.function.parameters)
      }
      tools.push(entry)
    }
    if (tools.length > 0) payload.tools = tools
    else delete payload.tools
  }

  const response = await fetch(`${base}/api/agent/v3/llm_utils_chat`, {
    method: 'POST',
    headers: traeHeaders(credential),
    body: JSON.stringify(payload),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}: ${text.trim().slice(0, 160)}`)
  }

  let finishReason = 'stop'
  for await (const event of readSseEvents(response)) {
    if (event.event === 'done') break
    if (!event.data) continue
    let parsed
    try {
      parsed = JSON.parse(event.data)
    } catch {
      continue
    }
    if (parsed.error) throw new Error(str(parsed.error, 'message') || '上游返回错误')

    const reasoning = str(parsed, 'reasoning_content')
    if (reasoning) yield textChunk(reasoning, { reasoning: true })

    const text = str(parsed, 'response')
    if (text) yield textChunk(text)

    const calls = Array.isArray(parsed.tool_calls) ? parsed.tool_calls : []
    for (const call of calls) {
      yield toolChunk({
        index: num(call, 'index') ?? 0,
        id: str(call, 'id') || `call_${num(call, 'index') ?? 0}`,
        type: 'function',
        function: {
          name: str(call, 'name'),
          arguments: str(call, 'arguments'),
        },
      })
    }

    if (str(parsed, 'finish_reason') === 'tool_calls') finishReason = 'tool_calls'
    else if (str(parsed, 'finish_reason') === 'length') finishReason = 'length'
  }

  yield finalChunk(finishReason)
}

/* ------------------------------------------------------------------ */
/* The entry point                                                       */
/* ------------------------------------------------------------------ */

/** The services that can actually answer a chat request. */
export const CHAT_SERVICES = new Set([
  ...Object.keys(OPENAI_SERVICES),
  ...Object.keys(ANTHROPIC_SERVICES),
  'trae',
])

/** True when this provider can serve a chat request. */
export function canChat(providerId) {
  return CHAT_SERVICES.has(providerId)
}

/**
 * Run one chat request against a third-party provider.
 *
 * @param {string} providerId
 * @param {object} credential
 * @param {object} body an OpenAI chat body
 * @param {object} [options]
 * @returns {AsyncGenerator<object>} OpenAI chat chunks
 */
export async function* channelChat(providerId, credential, body, options = {}) {
  const openAiService = OPENAI_SERVICES[providerId]
  if (openAiService) {
    yield* openAiChat(openAiService, credential, body, options.signal)
    return
  }

  const anthropicService = ANTHROPIC_SERVICES[providerId]
  if (anthropicService) {
    const anthropicBody = {
      model: body.model,
      max_tokens: body.max_tokens ?? 32000,
      messages: (body.messages ?? []).map((message) => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content:
          typeof message.content === 'string'
            ? message.content
            : (message.content ?? [])
                .filter((block) => block?.type === 'text')
                .map((block) => block.text)
                .join('\n'),
      })),
      ...body.tools
        ? {
            tools: body.tools.map((tool) => ({
              name: tool.function?.name ?? tool.name,
              description: tool.function?.description ?? tool.description,
              input_schema: tool.function?.parameters ?? tool.parameters ?? { type: 'object' },
            })),
          }
        : {},
    }
    yield* anthropicChat(anthropicService, credential, anthropicBody, options.signal)
    return
  }

  if (providerId === 'trae') {
    yield* traeChat(credential, body, options.signal)
    return
  }

  throw new Error(`该服务没有可用的对话接口：${providerId}`)
}
