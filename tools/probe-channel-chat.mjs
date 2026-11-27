/**
 * A one-off probe: can a third-party service actually answer a chat request?
 *
 * Usage: node tools/probe-channel-chat.mjs <service/model>
 */
import { AccountStore } from '../src/channels/store.js'
import { ModelCatalog } from '../src/channels/catalog.js'
import { Bridge } from '../src/gateway/bridge.js'
import { loadConfig } from '../src/config/store.js'

const wanted = process.argv[2] ?? ''
const config = loadConfig()
const store = new AccountStore()
store.importFromDsh()
const catalog = new ModelCatalog(config, { log: (line) => console.log(line) }, { store })
await catalog.refresh([])

if (!wanted) {
  console.log('--- models ---')
  for (const model of catalog.list()) console.log(model.id)
  process.exit(0)
}

const known = catalog.get(wanted)
if (!known) {
  console.log(`unknown model: ${wanted}`)
  process.exit(1)
}
console.log('model:', wanted, '->', known.upstreamId, 'channel', known.channel ?? '-')

const bridge = new Bridge(config, { log: (line) => console.log(line) }, { store, catalog })

const body = {
  model: wanted,
  stream: true,
  messages: [{ role: 'user', content: 'reply with exactly: CHANNEL_OK' }],
  max_tokens: 256,
}

let text = ''
try {
  for await (const chunk of bridge.chat(body)) {
    const delta = chunk?.choices?.[0]?.delta ?? {}
    if (delta.content) text += delta.content
    if (delta.reasoning_content) text += `[think]${delta.reasoning_content}`
  }
  console.log('--- answer ---')
  console.log(text.trim())
  console.log(text.includes('CHANNEL_OK') ? 'PASS' : 'FAIL')
} catch (error) {
  console.log('ERROR:', error.message)
}
