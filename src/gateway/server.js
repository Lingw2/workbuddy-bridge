/**
 * The local gateway HTTP server.
 *
 * Two servers are exposed, one per client family, so a Codex install and a
 * Claude install can be pointed at different ports and different tokens:
 *
 *   /v1/responses   OpenAI Responses API  -> Codex
 *   /v1/messages    Anthropic Messages API -> Claude Code and Claude desktop
 *   /v1/models      model directory
 *
 * The servers bind to 127.0.0.1 only, refuse non-loopback Host/Origin headers
 * and require a bearer token.
 */
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

import { anthropicToChat, chunkToAnthropicEvents, anthropicStopReason } from './anthropic.js'
import { responsesToChat, ResponsesWriter } from './responses.js'
import { CLAUDE_REWRITES, CODEX_REWRITES } from './rewrite.js'
import { claudeModelRoster, estimateInputTokens } from './bridge.js'

const MAX_BODY_BYTES = 32 * 1024 * 1024

/** True when a Host header points at this machine. */
export function hostIsLoopback(host) {
  if (!host) return false
  const value = String(host).trim().toLowerCase()
  if (value.startsWith('[')) {
    const end = value.indexOf(']')
    if (end === -1) return false
    const hostPart = value.slice(1, end)
    return hostPart === '::1' || hostPart === '0:0:0:0:0:0:0:1'
  }
  const name = value.split(':')[0]
  return name === 'localhost' || name === '127.0.0.1' || /^127\./.test(name)
}

/** True when an Origin header points at this machine. A missing Origin passes. */
export function originIsLoopback(origin) {
  if (!origin) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  return hostIsLoopback(url.host)
}

/** Constant-time string comparison. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Pull the bearer token out of a request. */
export function extractToken(req) {
  const header = req.headers['authorization']
  if (typeof header === 'string' && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim()
  }
  const apiKey = req.headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.length > 0) return apiKey.trim()
  return ''
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
}

/** Write one SSE event. */
function sendEvent(res, name, data) {
  res.write(`event: ${name}\n`)
  res.write(`data: ${JSON.stringify(data)}\n\n`)
}

/**
 * One HTTP server that speaks one client protocol.
 */
export class GatewayServer {
  /**
   * @param {object} options
   * @param {string} options.name 'codex' | 'claude'
   * @param {number} options.port
   * @param {string} options.token
   * @param {object} options.bridge
   * @param {object} options.config
   * @param {(line: string) => void} [options.logger]
   */
  constructor({ name, port, token, bridge, config, logger = { log() {} } }) {
    this.name = name
    this.port = port
    this.token = token
    this.bridge = bridge
    this.config = config
    this.logger = logger
    this.server = null
    this.startedAt = null
  }

  async start() {
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.logger.log(`[${this.name}] request failed: ${error.message}`)
        if (!res.headersSent) {
          writeJson(res, 500, { error: { message: error.message, type: 'internal_error' } })
        } else {
          res.end()
        }
      })
    })

    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.port, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })

    this.startedAt = Date.now()
    this.logger.log(`[${this.name}] listening on http://127.0.0.1:${this.port}`)
    return this
  }

  async stop() {
    if (!this.server) return
    await new Promise((resolve) => this.server.close(resolve))
    this.server = null
  }

  async #handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const path = url.pathname

    if (!hostIsLoopback(req.headers.host)) {
      writeJson(res, 403, { error: { message: 'host_not_allowed', type: 'invalid_request_error' } })
      return
    }
    if (!originIsLoopback(req.headers.origin)) {
      writeJson(res, 403, { error: { message: 'origin_not_allowed', type: 'invalid_request_error' } })
      return
    }

    // Health probes are open so the UI can poll without a token.
    if (path === '/healthz' || path === '/health' || path === '/') {
      writeJson(res, 200, {
        ok: true,
        service: 'workbuddy-bridge',
        client: this.name,
        port: this.port,
        uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
        models: this.bridge.models.length,
      })
      return
    }

    if (!safeEqual(extractToken(req), this.token)) {
      writeJson(res, 401, { error: { message: 'unauthorized', type: 'authentication_error' } })
      return
    }

    if (path === '/v1/models' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? '1000')
      const models = this.name === 'claude' ? claudeModelRoster(this.config) : this.#codexRoster()
      writeJson(res, 200, {
        object: 'list',
        data: models.slice(0, limit),
        rawCount: models.length,
        has_more: models.length > limit,
      })
      return
    }

    if (path === '/v1/messages/count_tokens' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const text = JSON.stringify(body.messages ?? body.input ?? '')
      writeJson(res, 200, { input_tokens: estimateInputTokens(text) })
      return
    }

    if (this.name === 'codex' && path === '/v1/responses' && req.method === 'POST') {
      await this.#codexResponses(req, res)
      return
    }

    if (this.name === 'claude' && path === '/v1/messages' && req.method === 'POST') {
      await this.#claudeMessages(req, res)
      return
    }

    writeJson(res, 404, { error: { message: `no such route: ${req.method} ${path}` } })
  }

  /** The Codex-facing model list (OpenAI shape). */
  #codexRoster() {
    const catalog = this.bridge.catalog?.visible?.() ?? []
    const models = catalog.length > 0 ? catalog : this.bridge.models
    return models.map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: model.provider ?? 'workbuddy',
    }))
  }

  /** Codex: OpenAI Responses API. */
  async #codexResponses(req, res) {
    const body = await readJsonBody(req)
    const upstreamModel = this.bridge.resolveModel(body.model)
    this.logger.log(`[codex] model ${body.model} -> ${upstreamModel}`)

    const chat = responsesToChat(body, {
      model: upstreamModel,
      maxTokens: 32000,
    })

    const responseId = `resp_${Date.now().toString(36)}`
    const writer = new ResponsesWriter({ model: upstreamModel, responseId })

    // The upstream is contacted before the stream starts, so a failure is
    // reported as a normal HTTP error instead of a half-open event stream.
    let stream
    let first
    try {
      stream = this.bridge.chat(chat, { rewrites: CODEX_REWRITES })
      first = await stream.next()
    } catch (error) {
      this.logger.log(`[codex] upstream error: ${error.message}`)
      writeJson(res, 502, {
        error: { message: `upstream request failed: ${error.message}`, type: 'api_error' },
      })
      return
    }

    sse(res)
    for (const [name, data] of writer.events()) sendEvent(res, name, data)

    let finishReason = 'stop'
    try {
      let next = first
      while (!next.done) {
        for (const [name, data] of writer.push(next.value)) sendEvent(res, name, data)
        next = await stream.next()
      }
      finishReason = next.value ?? 'stop'
    } catch (error) {
      this.logger.log(`[codex] upstream error: ${error.message}`)
      sendEvent(res, 'response.failed', {
        type: 'response.failed',
        response: { ...writer.snapshot(), status: 'failed', error: { message: error.message } },
      })
      res.end()
      return
    }

    for (const [name, data] of writer.finish(finishReason)) sendEvent(res, name, data)
    res.end()
  }

  /** Claude: Anthropic Messages API. */
  async #claudeMessages(req, res) {
    const body = await readJsonBody(req)
    const upstreamModel = this.bridge.resolveModel(body.model)
    this.logger.log(`[claude] model ${body.model} -> ${upstreamModel}`)

    const chat = anthropicToChat(body, {
      model: upstreamModel,
      maxTokens: 32000,
    })

    const messageId = `msg_${Date.now().toString(36)}`
    const state = { nextIndex: 0, thinkingOpen: false, thinkingIndex: 0, textOpen: false, textIndex: 0, tools: {} }
    const usage = { input_tokens: 0, output_tokens: 0 }

    // The upstream is contacted before the stream starts, so a failure is
    // reported as a normal HTTP error instead of a half-open event stream.
    let stream
    let first
    try {
      stream = this.bridge.chat(chat, { rewrites: CLAUDE_REWRITES })
      first = await stream.next()
    } catch (error) {
      this.logger.log(`[claude] upstream error: ${error.message}`)
      writeJson(res, 502, {
        error: { type: 'api_error', message: `upstream request failed: ${error.message}` },
      })
      return
    }

    sse(res)
    sendEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })

    let finishReason = 'stop'
    try {
      let next = first
      while (!next.done) {
        const chunk = next.value
        if (chunk.usage) {
          usage.input_tokens = chunk.usage.prompt_tokens ?? usage.input_tokens
          usage.output_tokens = chunk.usage.completion_tokens ?? usage.output_tokens
        }
        for (const [name, data] of chunkToAnthropicEvents(chunk, state)) {
          sendEvent(res, name, data)
        }
        next = await stream.next()
      }
      finishReason = next.value ?? 'stop'
    } catch (error) {
      this.logger.log(`[claude] upstream error: ${error.message}`)
      sendEvent(res, 'error', {
        type: 'error',
        error: { type: 'api_error', message: error.message },
      })
      res.end()
      return
    }

    if (state.thinkingOpen) {
      sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index: state.thinkingIndex })
    }
    if (state.textOpen) {
      sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index: state.textIndex })
    }
    for (const slot of Object.values(state.tools)) {
      sendEvent(res, 'content_block_stop', { type: 'content_block_stop', index: slot.blockIndex })
    }

    sendEvent(res, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: anthropicStopReason(finishReason), stop_sequence: null },
      usage: { ...usage },
    })
    sendEvent(res, 'message_stop', { type: 'message_stop' })
    res.end()
  }
}
