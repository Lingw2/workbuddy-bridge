import { test } from 'node:test'
import assert from 'node:assert/strict'

import { anthropicToChat, chunkToAnthropicEvents, anthropicStopReason } from '../src/gateway/anthropic.js'
import { responsesToChat, ResponsesWriter, mapUsage } from '../src/gateway/responses.js'
import { rewriteChannelSpans } from '../src/gateway/rewrite.js'
import { buildAliasMap, claudeModelRoster } from '../src/gateway/bridge.js'

test('anthropic system blocks become one system message', () => {
  const chat = anthropicToChat(
    {
      system: [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      max_tokens: 128,
    },
    { model: 'm' },
  )

  assert.equal(chat.messages[0].role, 'system')
  assert.match(chat.messages[0].content, /first/)
  assert.match(chat.messages[0].content, /second/)
  assert.equal(chat.messages[1].role, 'user')
  assert.equal(chat.max_tokens, 128)
})

test('anthropic tool_use and tool_result map onto chat tool messages', () => {
  const chat = anthropicToChat(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'toolu_1', name: 'exec', input: { cmd: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'out' }],
        },
      ],
    },
    { model: 'm' },
  )

  const assistant = chat.messages.find((message) => message.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.name, 'exec')
  assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { cmd: 'ls' })

  const tool = chat.messages.find((message) => message.role === 'tool')
  assert.equal(tool.tool_call_id, 'toolu_1')
  assert.equal(tool.content, 'out')
})

test('anthropic flat tools become nested function tools', () => {
  const chat = anthropicToChat(
    {
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'exec', description: 'run', input_schema: { type: 'object' } }],
    },
    { model: 'm' },
  )

  assert.equal(chat.tools[0].type, 'function')
  assert.equal(chat.tools[0].function.name, 'exec')
  assert.deepEqual(chat.tools[0].function.parameters, { type: 'object' })
})

test('anthropic chunks open and close a text block', () => {
  const state = { nextIndex: 0, tools: {} }
  const events = chunkToAnthropicEvents(
    { choices: [{ delta: { content: 'hello' } }] },
    state,
  )

  assert.equal(events[0][0], 'content_block_start')
  assert.equal(events[1][0], 'content_block_delta')
  assert.equal(events[1][1].delta.text, 'hello')
})

test('anthropic stop reasons map onto the Anthropic vocabulary', () => {
  assert.equal(anthropicStopReason('tool_calls'), 'tool_use')
  assert.equal(anthropicStopReason('length'), 'max_tokens')
  assert.equal(anthropicStopReason('stop'), 'end_turn')
})

test('responses developer messages become system messages', () => {
  const chat = responsesToChat(
    {
      instructions: 'be brief',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'sys' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ],
    },
    { model: 'm' },
  )

  const roles = chat.messages.map((message) => message.role)
  assert.ok(roles.includes('system'))
  assert.ok(roles.includes('user'))
})

test('responses function call output becomes a chat tool message', () => {
  const chat = responsesToChat(
    {
      input: [
        {
          type: 'function_call',
          id: 'fc_1',
          name: 'exec_command',
          arguments: '{"cmd":"echo"}',
          call_id: 'call_1',
        },
        {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'done',
        },
      ],
    },
    { model: 'm' },
  )

  const tool = chat.messages.find((message) => message.role === 'tool')
  assert.ok(tool)
  assert.equal(tool.tool_call_id, 'call_1')
  assert.equal(tool.content, 'done')
})

test('responses writer emits the event sequence Codex expects', () => {
  const writer = new ResponsesWriter({ model: 'm', responseId: 'resp_1' })
  const names = [...writer.events()].map(([name]) => name)
  assert.ok(names.includes('response.created'))

  const pushed = writer
    .push({ choices: [{ delta: { content: 'hi' } }] })
    .map(([name]) => name)
  assert.ok(pushed.includes('response.output_text.delta'))

  const done = writer.finish('stop').map(([name]) => name)
  assert.ok(done.includes('response.completed'))
})

test('usage is mapped onto the Responses shape', () => {
  const usage = mapUsage({
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    completion_tokens_details: { reasoning_tokens: 2 },
  })
  assert.equal(usage.input_tokens, 10)
  assert.equal(usage.output_tokens, 4)
  assert.equal(usage.total_tokens, 14)
})

test('the channel rewrite replaces the blocked phrases', () => {
  const { body, applied } = rewriteChannelSpans({
    messages: [
      {
        role: 'system',
        content:
          'x-anthropic-billing-header: cc_version=1; cc_entrypoint=sdk-cli;\n' +
          'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
      },
    ],
  })

  assert.ok(applied.length >= 2)
  const text = body.messages[0].content
  assert.ok(!text.includes('x-anthropic-billing-header'))
  assert.ok(!text.includes('claude-code/issues'))
  assert.ok(text.includes('x-request-metadata'))
})

test('the rewrite leaves user messages alone', () => {
  const { body, applied } = rewriteChannelSpans({
    messages: [{ role: 'user', content: 'x-anthropic-billing-header:' }],
  })
  assert.equal(applied.length, 0)
  assert.match(body.messages[0].content, /x-anthropic-billing-header/)
})

test('the alias map resolves Claude route names onto WorkBuddy models', () => {
  const models = [
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
  ]
  const config = {
    claude: {
      model: 'deepseek-v4-pro',
      routes: [
        { name: 'claude-sonnet-5', model: 'deepseek-v4-pro', tier: 'sonnet' },
        { name: 'claude-fable-5', model: 'glm-5.3', tier: 'fable' },
      ],
    },
  }

  const alias = buildAliasMap(models, { ...config, codex: { model: 'deepseek-v4-pro' } })
  assert.equal(alias.get('claude-sonnet-5'), 'deepseek-v4-pro')
  assert.equal(alias.get('claude-fable-5'), 'glm-5.3')
  assert.equal(alias.get('deepseek-v4-pro'), 'deepseek-v4-pro')
})

test('the Claude roster only exposes claude style names', () => {
  const roster = claudeModelRoster({
    claude: {
      model: 'deepseek-v4-pro',
      routes: [
        { name: 'claude-sonnet-5', model: 'deepseek-v4-pro', tier: 'sonnet', familyDefault: true },
        { name: 'claude-fable-5', model: 'glm-5.3', tier: 'fable' },
      ],
    },
  })

  assert.equal(roster.length, 2)
  for (const entry of roster) {
    assert.match(entry.id, /^claude-/)
  }
  assert.ok(roster.find((entry) => entry.id === 'claude-sonnet-5').is_family_default)
})
