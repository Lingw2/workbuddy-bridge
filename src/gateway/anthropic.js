/**
 * Anthropic Messages API <-> OpenAI chat completions.
 *
 * Ground truth for the request shape was captured from Claude Code:
 *   - `system` is an ARRAY of {type:'text', text, cache_control?} blocks
 *   - `messages[].content` is an ARRAY of typed blocks
 *     (text / tool_use / tool_result / thinking / image)
 *   - `tools[]` uses Anthropic's flat {name, description, input_schema}
 *   - `max_tokens` is mandatory
 */

/** Anthropic block -> plain text. Images are replaced by a marker. */
function blockToText(block) {
  if (!block || typeof block !== 'object') return ''
  if (typeof block === 'string') return block
  if (block.type === 'text') return block.text ?? ''
  if (block.type === 'thinking') return block.thinking ?? ''
  if (block.type === 'redacted_thinking') return ''
  if (block.type === 'image') return '[image]'
  return ''
}

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(blockToText)
    .filter((text) => text.length > 0)
    .join('\n')
}

/**
 * Convert an Anthropic Messages request into an OpenAI chat body.
 *
 * @param {object} body Anthropic request body
 * @param {object} opts
 * @param {string} opts.model Model id to actually call upstream
 * @param {number} [opts.maxTokens] Output token cap
 */
export function anthropicToChat(body, { model, maxTokens }) {
  const messages = []

  if (body.system) {
    const text = contentToText(body.system)
    if (text.trim().length > 0) messages.push({ role: 'system', content: text })
  }

  for (const message of body.messages ?? []) {
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const content = message.content

    if (typeof content === 'string') {
      if (content.length > 0) messages.push({ role, content })
      continue
    }
    if (!Array.isArray(content)) continue

    const textParts = []
    const toolUses = []
    const toolResults = []

    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' || block.type === 'thinking') {
        textParts.push(blockToText(block))
      } else if (block.type === 'tool_use') {
        toolUses.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
        })
      } else if (block.type === 'tool_result') {
        toolResults.push({
          role: 'tool',
          tool_call_id: block.tool_use_id,
          content: contentToText(block.content) || (block.is_error ? '(tool error)' : ''),
        })
      } else if (block.type === 'image') {
        textParts.push('[image]')
      }
    }

    if (toolResults.length > 0) {
      for (const toolResult of toolResults) messages.push(toolResult)
      continue
    }

    const text = textParts.filter((t) => t.length > 0).join('\n')
    if (toolUses.length > 0) {
      messages.push({ role: 'assistant', content: text.length > 0 ? text : null, tool_calls: toolUses })
    } else if (text.length > 0) {
      messages.push({ role, content: text })
    }
  }

  const chat = {
    model,
    messages,
    stream: true,
    max_tokens: body.max_tokens ?? maxTokens ?? 32000,
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chat.tools = body.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description ?? '',
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      },
    }))
    if (body.tool_choice?.type && body.tool_choice.type !== 'auto') {
      chat.tool_choice = body.tool_choice
    }
  }

  return chat
}

/**
 * Translate one upstream OpenAI chat chunk into Anthropic SSE events.
 *
 * @returns {Array<[string, object]>} `[eventName, dataObject]` pairs
 */
export function chunkToAnthropicEvents(chunk, state) {
  const events = []
  const choice = chunk?.choices?.[0]
  if (!choice) return events
  const delta = choice.delta ?? {}

  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    if (!state.thinkingOpen) {
      state.thinkingOpen = true
      state.nextIndex += 1
      state.thinkingIndex = state.nextIndex
      events.push([
        'content_block_start',
        { type: 'content_block_start', index: state.thinkingIndex, content_block: { type: 'thinking', thinking: '' } },
      ])
    }
    events.push([
      'content_block_delta',
      {
        type: 'content_block_delta',
        index: state.thinkingIndex,
        delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
      },
    ])
  }

  if (state.thinkingOpen && (delta.content || delta.tool_calls)) {
    events.push(['content_block_stop', { type: 'content_block_stop', index: state.thinkingIndex }])
    state.thinkingOpen = false
  }

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    if (!state.textOpen) {
      state.textOpen = true
      state.nextIndex += 1
      state.textIndex = state.nextIndex
      events.push([
        'content_block_start',
        { type: 'content_block_start', index: state.textIndex, content_block: { type: 'text', text: '' } },
      ])
    }
    events.push([
      'content_block_delta',
      { type: 'content_block_delta', index: state.textIndex, delta: { type: 'text_delta', text: delta.content } },
    ])
  }

  for (const call of delta.tool_calls ?? []) {
    const index = call.index ?? 0
    let slot = state.tools[index]
    if (!slot) {
      slot = state.tools[index] = {
        id: call.id ?? `toolu_${index}_${Date.now()}`,
        name: call.function?.name ?? '',
        args: '',
        blockIndex: 0,
        started: false,
      }
    }
    if (!slot.started) {
      slot.started = true
      slot.blockIndex = ++state.nextIndex
      events.push([
        'content_block_start',
        {
          type: 'content_block_start',
          index: slot.blockIndex,
          content_block: { type: 'tool_use', id: slot.id, name: slot.name, input: {} },
        },
      ])
    }
    if (call.function?.name && !slot.name) slot.name = call.function.name
    const fragment = call.function?.arguments
    if (typeof fragment === 'string' && fragment.length > 0) {
      slot.args += fragment
      events.push([
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: slot.blockIndex,
          delta: { type: 'input_json_delta', partial_json: fragment },
        },
      ])
    }
  }

  return events
}

/** Anthropic stop_reason for an upstream finish_reason. */
export function anthropicStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}
