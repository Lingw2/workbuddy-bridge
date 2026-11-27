/**
 * The tests for the third-party channels.
 *
 * The upstream is replaced by a small HTTP server, so the tests never touch
 * the real services.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ChannelService, localDayKey, minutesSinceMidnight, parseClock } from '../src/channels/service.js'
import { AccountStore } from '../src/channels/store.js'
import { probeAccount, probeAll } from '../src/channels/probe.js'
import { providerById, PROVIDER_ORDER } from '../src/channels/providers.js'

/** A temporary directory for the state files. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'wbg-channels-'))
}

/**
 * A stand-in for one upstream service.
 *
 * @param {object} options
 * @param {object} [options.routes] path -> {status, body}
 */
async function startMock(options = {}) {
  const routes = options.routes ?? {}
  const hits = []
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    hits.push({ path: url.pathname, method: req.method })
    const route = routes[url.pathname]
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 404, msg: 'no route' }))
      return
    }
    if (typeof route.body === 'function') await route.body(req, res)
    else {
      res.writeHead(route.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(route.body ?? {}))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A store with one account of one provider. */
function makeStore(dir, providerId, credential = { access_token: 'token' }) {
  const file = join(dir, 'accounts.json')
  writeFileSync(file, JSON.stringify({ accounts: [] }))
  const store = new AccountStore({
    file,
    importer: () => [
      { id: 'acc-1', provider: providerId, nickname: 'tester', enabled: true, credential },
    ],
  })
  store.importFromDsh()
  return store
}

test('localDayKey, minutesSinceMidnight and parseClock', () => {
  const date = new Date(2026, 10, 27, 9, 30)
  assert.equal(localDayKey(date), '2026-11-27')
  assert.equal(minutesSinceMidnight(date), 9 * 60 + 30)
  assert.equal(parseClock('09:30'), 570)
  assert.equal(parseClock('nonsense'), 0)
  assert.equal(parseClock('99:99'), 0)
})

test('every provider is listed and has a portal to log in at', () => {
  assert.equal(PROVIDER_ORDER.length, 10)
  for (const id of PROVIDER_ORDER) {
    const provider = providerById(id)
    assert.ok(provider, `missing provider ${id}`)
    assert.ok(provider.portal.startsWith('https://'), `${id} has no portal`)
    assert.ok(provider.label)
  }
})

test('the account store imports once and keeps deletions', () => {
  const dir = tempDir()
  const file = join(dir, 'accounts.json')
  writeFileSync(file, JSON.stringify({ accounts: [] }))
  let source = [
    { id: 'a-1', provider: 'trae', nickname: 'one', enabled: true, credential: { access_token: 'x' } },
    { id: 'a-2', provider: 'lobsterai', nickname: 'two', enabled: true, credential: { access_token: 'y' } },
  ]
  const store = new AccountStore({ file, importer: () => source })
  assert.equal(store.importFromDsh().added, 2)
  assert.equal(store.importFromDsh().added, 0)

  store.remove('a-1')
  assert.equal(store.list().length, 1)

  // The deleted account must not come back on the next import.
  source = source.filter((entry) => entry.id !== 'a-1')
  assert.equal(store.importFromDsh().added, 0)
  assert.equal(store.list().length, 1)
})

test('an account can be switched off and deleted', () => {
  const dir = tempDir()
  const store = makeStore(dir, 'trae')
  assert.equal(store.list()[0].enabled, true)
  store.setEnabled('acc-1', false)
  assert.equal(store.list()[0].enabled, false)
  store.remove('acc-1')
  assert.equal(store.list().length, 0)
})

test('a disabled provider is never claimed', async () => {
  const dir = tempDir()
  const mock = await startMock({
    routes: {
      '/trae/api/v2/ug/checkin_credits/status': { body: { code: 0, enable: true, checked_in: false, credits: 300 } },
      '/trae/api/v2/ug/checkin_credits/claim': { body: { code: 0 } },
    },
  })
  try {
    const store = makeStore(dir, 'trae')
    const config = {
      channels: { enabled: true, time: '00:00', disabledProviders: ['trae'], disabledAccounts: [] },
    }
    const service = new ChannelService(config, { log() {} }, {
      store,
      stateFile: join(dir, 'state.json'),
    })
    const summary = await service.claim({ reason: 'manual' })
    assert.equal(summary.results.length, 0)
    assert.equal(mock.hits.length, 0)
  } finally {
    await mock.close()
  }
})

test('the scheduler claims once a day and skips a second run', async () => {
  const dir = tempDir()
  const mock = await startMock({
    routes: {
      '/trae/api/v2/ug/checkin_credits/status': { body: { code: 0, enable: true, checked_in: false, credits: 300 } },
      '/trae/api/v2/ug/checkin_credits/claim': { body: { code: 0 } },
    },
  })
  try {
    const store = makeStore(dir, 'trae', { access_token: 'token', baseUrl: mock.base })
    const config = {
      channels: { enabled: true, time: '00:00', disabledProviders: [], disabledAccounts: [] },
    }
    const stateFile = join(dir, 'state.json')
    const service = new ChannelService(config, { log() {} }, { store, stateFile })

    const first = await service.tick()
    assert.ok(first, 'the first tick should claim')
    assert.equal(mock.hits.filter((hit) => hit.path.endsWith('/claim')).length, 1)

    const second = await service.tick()
    assert.equal(second, null, 'the second tick on the same day should do nothing')
    assert.equal(mock.hits.filter((hit) => hit.path.endsWith('/claim')).length, 1)
  } finally {
    await mock.close()
  }
})

test('the probe measures the round trip and reports a failure', async () => {
  const dir = tempDir()
  const mock = await startMock({
    routes: {
      '/trae/api/v2/ug/checkin_credits/status': { body: { code: 0, enable: true, checked_in: true, credits: 300 } },
    },
  })
  try {
    const store = makeStore(dir, 'trae')
    const provider = providerById('trae')
    const account = store.listByProvider('trae')[0]

    const good = await probeAccount(account, provider)
    assert.equal(good.ok, true)
    assert.ok(good.averageMs >= 0)
    assert.ok(['fast', 'ok', 'slow'].includes(good.speed))

    const broken = await probeAccount({ ...account, credential: { access_token: 'bad' } }, {
      ...provider,
      status: async () => {
        throw new Error('401 unauthorized')
      },
    })
    assert.equal(broken.ok, false)
    assert.equal(broken.speed, 'bad')
    assert.match(broken.error, /401/)
  } finally {
    await mock.close()
  }
})

test('probeAll walks every enabled account', async () => {
  const dir = tempDir()
  const store = makeStore(dir, 'trae')
  const config = { channels: { enabled: true, time: '09:00', disabledProviders: [], disabledAccounts: [] } }
  const service = new ChannelService(config, { log() {} }, {
    store,
    stateFile: join(dir, 'state.json'),
  })
  const result = await probeAll({ store, service })
  assert.equal(result.results.length, 1)
  assert.equal(result.summary.total, 1)
})
