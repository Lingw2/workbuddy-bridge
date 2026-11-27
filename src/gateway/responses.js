/**
 * OpenAI Responses API <-> OpenAI chat completions.
 *
 * Codex only speaks the Responses API (`wire_api = "chat"` was removed in
 * 0.163.0), so the gateway implements `/v1/responses` itself.
 *
 * Ground truth for the request shape was captured from Codex 0.163.0:
 *   - body keys: model, stream, input[], tools[], tool_choice,
 *     parallel_tool_calls, reasoning, store, include, prompt_cache_key
 *   - `input[]` items:
 *       {type:'message', role:'developer'|'user'|'assistant', id, content:[{type:'input_text', text}]}
 *       {type:'function_call', status, id, name, arguments, call_id}
 *       {type:'function_call_output', id, call_id, output}
 *   - `tools[]` are FLAT: {type:'function', name, description, strict, parameters}
 */

function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const part of content) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    if (!part || typeof part !== 'object') continue
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      parts.push(part.text ?? '')
    } else if (part.type === 'input_image') {
      parts.push('[image]')
    } else if (part.type === 'refusal') {
      parts.push(part.refusal ?? '')
    }
  }
  return parts.filter((p) => p.length > 0).join('\n')
}

/**
 * Convert a Responses request into an OpenAI chat body.
 */
export function responsesToChat(body, { model, maxTokens }) {
  const messages = []
  const pendingCalls = new Map()

  if (typeof body.instructions === 'string' && body.instructions.trim().length > 0) {
    messages.push({ role: 'system', content: body.instructions })
  }

  for (const item of body.input ?? []) {
    if (!item || typeof item !== 'object') continue

    if (item.type === 'message' || item.role) {
      const role =
        item.role === 'assistant' ? 'assistant' : item.role === 'developer' ? 'system' : 'user'
      const text = textOfContent(item.content)
      if (text.length > 0) messages.push({ role, content: text })
      continue
    }

    if (item.type === 'function_call') {
      const callId = item.call_id ?? item.id
      pendingCalls.set(callId, { name: item.name, arguments: item.arguments ?? '{}' })
      continue
    }

    if (item.type === 'function_call_output') {
      const callId = item.call_id
      const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '')
      messages.push({ role: 'tool', tool_call_id: callId, content: output })
      continue
    }

    if (item.type === 'local_shell_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id ?? item.id,
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      })
      continue
    }
  }

  for (const [callId, call] of pendingCalls) {
    const alreadyAnswered = messages.some((m) => m.role === 'tool' && m.tool_call_id === callId)
    if (alreadyAnswered) continue
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: callId, type: 'function', function: { name: call.name, arguments: call.arguments } },
      ],
    })
  }

  const chat = {
    model,
    messages,
    stream: true,
    max_tokens: body.max_output_tokens ?? maxTokens ?? 32000,
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chat.tools = body.tools
      .filter((tool) => tool && (tool.type === 'function' || tool.type === 'custom'))
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description ?? '',
          parameters: tool.parameters ?? { type: 'object', properties: {} },
        },
      }))
    if (chat.tools.length > 0 && body.tool_choice && body.tool_choice !== 'auto') {
      chat.tool_choice = body.tool_choice
    }
  }

  return chat
}

/** Map the upstream usage shape onto the Responses usage shape. */
export function mapUsage(usage) {
  if (!usage) return null
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: usage.total_tokens ?? inputTokens + outputTokens,
    input_tokens_details: { cached_tokens: usage.prompt_cache_hit_tokens ?? 0 },
    output_tokens_details: { reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0 },
  }
}

/**
 * A running conversion of upstream chat chunks into Responses SSE events.
 */
export class ResponsesWriter {
  constructor({ model, responseId }) {
    this.model = model
    this.responseId = responseId
    this.createdAt = Math.floor(Date.now() / 1000)
    this.outputIndex = 0
    this.textItemId = null
    this.textStarted = false
    this.textText = ''
    this.reasoningItemId = null
    this.reasoningStarted = false
    this.reasoningText = ''
    this.toolItems = new Map()
    this.output = []
    this.usage = null
    this.status = 'in_progress'
  }

  #envelope(extra = {}) {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status: this.status,
      model: this.model,
      output: this.output,
      usage: this.usage,
      ...extra,
    }
  }

  *events() {
    yield [
      'response.created',
      { type: 'response.created', response: this.#envelope({ status: 'in_progress' }) },
    ]
  }

  /** Translate one upstream chunk into Responses events. */
  push(chunk) {
    const events = []
    const choice = chunk?.choices?.[0]
    if (!choice) return events
    const delta = choice.delta ?? {}

    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      if (!this.reasoningStarted) {
        this.reasoningStarted = true
        this.reasoningItemId = `rs_${this.responseId}_${this.outputIndex}`
        events.push([
          'response.output_item.added',
          {
            type: 'response.output_item.added',
            output_index: this.outputIndex,
            item: { id: this.reasoningItemId, type: 'reasoning', summary: [], status: 'in_progress' },
          },
        ])
        events.push([
          'response.reasoning_summary_part.added',
          {
            type: 'response.reasoning_summary_part.added',
            item_id: this.reasoningItemId,
            output_index: this.outputIndex,
            summary_index: 0,
            part: { type: 'summary_text', text: '' },
          },
        ])
      }
      this.reasoningText += delta.reasoning_content
      events.push([
        'response.reasoning_summary_text.delta',
        {
          type: 'response.reasoning_summary_text.delta',
          item_id: this.reasoningItemId,
          output_index: this.outputIndex,
          summary_index: 0,
          delta: delta.reasoning_content,
        },
      ])
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (this.reasoningStarted) {
        const reasoningItem = {
          id: this.reasoningItemId,
          type: 'reasoning',
          summary: this.reasoningText ? [{ type: 'summary_text', text: this.reasoningText }] : [],
          status: 'completed',
        }
        events.push([
          'response.output_item.done',
          { type: 'response.output_item.done', output_index: this.outputIndex, item: reasoningItem },
        ])
        this.output.push(reasoningItem)
        this.outputIndex += 1
        this.reasoningStarted = false
      }
      if (!this.textStarted) {
        this.textStarted = true
        this.textItemId = `msg_${this.responseId}_${this.outputIndex}`
        events.push([
          'response.output_item.added',
          {
            type: 'response.output_item.added',
            output_index: this.outputIndex,
            item: {
              id: this.textItemId,
              type: 'message',
              role: 'assistant',
              status: 'in_progress',
              content: [],
            },
          },
        ])
        events.push([
          'response.content_part.added',
          {
            type: 'response.content_part.added',
            item_id: this.textItemId,
            output_index: this.outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          },
        ])
      }
      this.textText += delta.content
      events.push([
        'response.output_text.delta',
        {
          type: 'response.output_text.delta',
          item_id: this.textItemId,
          output_index: this.outputIndex,
          content_index: 0,
          delta: delta.content,
        },
      ])
    }

    for (const call of delta.tool_calls ?? []) {
      const index = call.index ?? 0
      let slot = this.toolItems.get(index)
      if (!slot) {
        slot = {
          id: `fc_${this.responseId}_${this.outputIndex}_${index}`,
          callId: call.id ?? `call_${this.responseId}_${index}`,
          name: call.function?.name ?? '',
          args: '',
          outputIndex: this.outputIndex,
          started: false,
        }
        this.toolItems.set(index, slot)
        this.outputIndex += 1
      }
      if (!slot.started) {
        slot.started = true
        events.push([
          'response.output_item.added',
          {
            type: 'response.output_item.added',
            output_index: slot.outputIndex,
            item: {
              id: slot.id,
              type: 'function_call',
              call_id: slot.callId,
              name: slot.name,
              arguments: '',
              status: 'in_progress',
            },
          },
        ])
      }
      if (call.function?.name && !slot.name) slot.name = call.function.name
      const fragment = call.function?.arguments
      if (typeof fragment === 'string' && fragment.length > 0) {
        slot.args += fragment
        events.push([
          'response.function_call_arguments.delta',
          {
            type: 'response.function_call_arguments.delta',
            item_id: slot.id,
            output_index: slot.outputIndex,
            delta: fragment,
          },
        ])
      }
    }

    if (chunk.usage) this.usage = mapUsage(chunk.usage)

    return events
  }

  /** The final response object (used for the non-streaming reply body). */
  snapshot() {
    return this.#envelope()
  }

  /** Close every open item and emit the terminal event. */
  finish(finishReason) {
    const events = []
    void finishReason

    if (this.reasoningStarted) {
      const reasoningItem = {
        id: this.reasoningItemId,
        type: 'reasoning',
        summary: this.reasoningText ? [{ type: 'summary_text', text: this.reasoningText }] : [],
        status: 'completed',
      }
      events.push([
        'response.output_item.done',
        { type: 'response.output_item.done', output_index: this.outputIndex, item: reasoningItem },
      ])
      this.output.push(reasoningItem)
      this.outputIndex += 1
      this.reasoningStarted = false
    }

    if (this.textStarted) {
      events.push([
        'response.output_text.done',
        {
          type: 'response.output_text.done',
          item_id: this.textItemId,
          output_index: this.outputIndex,
          content_index: 0,
          text: this.textText,
        },
      ])
      events.push([
        'response.content_part.done',
        {
          type: 'response.content_part.done',
          item_id: this.textItemId,
          output_index: this.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: this.textText, annotations: [] },
        },
      ])
      const item = {
        id: this.textItemId,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: this.textText, annotations: [] }],
      }
      events.push([
        'response.output_item.done',
        { type: 'response.output_item.done', output_index: this.outputIndex, item },
      ])
      this.output.push(item)
      this.outputIndex += 1
      this.textStarted = false
    }

    for (const slot of this.toolItems.values()) {
      events.push([
        'response.function_call_arguments.done',
        {
          type: 'response.function_call_arguments.done',
          item_id: slot.id,
          output_index: slot.outputIndex,
          arguments: slot.args,
        },
      ])
      const item = {
        id: slot.id,
        type: 'function_call',
        call_id: slot.callId,
        name: slot.name,
        arguments: slot.args,
        status: 'completed',
      }
      events.push([
        'response.output_item.done',
        { type: 'response.output_item.done', output_index: slot.outputIndex, item },
      ])
      this.output.push(item)
    }

    this.status = 'completed'
    events.push([
      'response.completed',
      { type: 'response.completed', response: this.#envelope() },
    ])
    return events
  }
}
