/**
 * Smoke test for both gateway surfaces.
 *
 * Usage: node test/smoke.mjs [codex|claude]
 */
import { loadConfig } from '../src/config/store.js'

const config = loadConfig()

async function codex() {
  const body = {
    model: config.codex.model,
    stream: true,
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'reply with exactly: SMOKE_CODEX_OK' }],
      },
    ],
  }

  const response = await fetch(`http://127.0.0.1:${config.codex.port}/v1/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.codex.token}`,
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6))
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const answer = events
    .filter((event) => event.type === 'response.output_text.delta')
    .map((event) => event.delta)
    .join('')

  const names = [...new Set(events.map((event) => event.type))]
  console.log('codex status :', response.status)
  console.log('codex events :', names.join(', '))
  console.log('codex answer :', answer)
  return response.status === 200 && answer.includes('SMOKE_CODEX_OK')
}

async function claude() {
  const body = {
    model: (config.claude.routes ?? []).find((route) => route.tier === 'sonnet')?.name ?? 'claude-sonnet-5',
    max_tokens: 256,
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'reply with exactly: SMOKE_CLAUDE_OK' }] }],
  }

  const response = await fetch(`http://127.0.0.1:${config.claude.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': config.claude.token,
    },
    body: JSON.stringify(body),
  })

  const text = await response.text()
  const events = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => {
      try {
        return JSON.parse(line.slice(6))
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const answer = events
    .filter((event) => event.type === 'content_block_delta' && event.delta?.type === 'text_delta')
    .map((event) => event.delta.text)
    .join('')

  const names = [...new Set(events.map((event) => event.type))]
  console.log('claude status :', response.status)
  console.log('claude events :', names.join(', '))
  console.log('claude answer :', answer)
  return response.status === 200 && answer.includes('SMOKE_CLAUDE_OK')
}

const which = process.argv[2]
let ok = true

if (!which || which === 'codex') ok = (await codex()) && ok
if (!which || which === 'claude') ok = (await claude()) && ok

process.exitCode = ok ? 0 : 1
