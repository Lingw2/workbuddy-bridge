/**
 * The tests for the aggregate model directory.
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

import { ModelCatalog } from '../src/channels/catalog.js'
import { AccountStore } from '../src/channels/store.js'
import { vendorOf } from '../src/channels/vendors.js'
import { splitScopedModel } from '../src/gateway/bridge.js'
import { scopedModelId } from '../src/channels/models.js'

/** A temporary directory for the state files. */
function tempDir() {
  return mkdtempSync(join(tmpdir(), 'wbg-catalog-'))
}

/**
 * A store with one account of one provider.
 *
 * Qoder is used on purpose: it has no model endpoint, so the tests never
 * reach out to the network.
 */
function makeStore(dir, providerId = 'qoder', credential = { access_token: 'token' }) {
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

/** The settings of a catalog that has everything switched on. */
function config(overrides = {}) {
  return {
    channels: {
      enabled: true,
      time: '09:00',
      autoBenefits: true,
      disabledProviders: [],
      disabledAccounts: [],
      disabledModels: [],
      providerModels: {},
      ...overrides,
    },
  }
}

test('a model name is assigned to the company that made it', () => {
  assert.equal(vendorOf('DeepSeek-V4-Pro').id, 'deepseek')
  assert.equal(vendorOf('glm-5.3').id, 'zhipu')
  assert.equal(vendorOf('Kimi-K3.1-Pro').id, 'moonshot')
  assert.equal(vendorOf('MiniMax-M3').id, 'minimax')
  assert.equal(vendorOf('Doubao-Seed-2.1-Pro').id, 'doubao')
  assert.equal(vendorOf('qwen3.8-max').id, 'qwen')
  assert.equal(vendorOf('gemini-3.8-pro').id, 'gemini')
  assert.equal(vendorOf('claude-sonnet-4.5').id, 'anthropic')
  assert.equal(vendorOf('gpt-4o').id, 'openai')
  assert.equal(vendorOf('something nobody knows').id, 'unknown')
})

test('the WorkBuddy models keep their own ids and get a vendor', async () => {
  const dir = tempDir()
  const store = makeStore(dir, 'trae')
  const catalog = new ModelCatalog(config(), { log() {} }, { store })
  await catalog.refresh([
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'hy4std', name: 'Hy4' },
  ])
  const workbuddy = catalog.list().filter((model) => model.source === 'workbuddy')
  assert.equal(workbuddy.length, 2)
  assert.equal(workbuddy[0].id, 'deepseek-v4-pro')
  assert.equal(workbuddy[0].vendor.id, 'deepseek')
  assert.equal(workbuddy[0].providerLabel, 'WorkBuddy')
})

test('a service model is addressed as service/model', async () => {
  const dir = tempDir()
  const store = makeStore(dir, 'trae')
  const catalog = new ModelCatalog(config(), { log() {} }, { store })
  await catalog.refresh([])
  const scoped = scopedModelId('trae', 'DeepSeek-V4-Pro')
  assert.equal(scoped, 'trae/deepseek-v4-pro')
  assert.deepEqual(splitScopedModel(scoped), {
    providerId: 'trae',
    modelId: 'deepseek-v4-pro',
  })
})

test('an unknown service is not a channel id', () => {
  assert.equal(splitScopedModel('deepseek-v4-pro'), null)
  assert.equal(splitScopedModel('nosuchservice/model'), null)
  assert.equal(splitScopedModel('/model'), null)
  assert.equal(splitScopedModel('trae/'), null)
})

test('the models are grouped by the company that made them', async () => {
  const dir = tempDir()
  const store = makeStore(dir, 'trae')
  const catalog = new ModelCatalog(config(), { log() {} }, { store })
  await catalog.refresh([
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
  ])
  const groups = catalog.grouped()
  const labels = groups.map((group) => group.label)
  assert.ok(labels.includes('DeepSeek 深度求索'))
  assert.ok(labels.includes('智谱 GLM'))
  for (const group of groups) {
    assert.ok(group.models.length > 0)
    assert.ok(group.color)
  }
})

test('a switched off service disappears from the picker', async () => {
  const dir = tempDir()
  const store = makeStore(dir, 'trae')
  const catalog = new ModelCatalog(
    config({ disabledProviders: ['trae'] }),
    { log() {} },
    { store },
  )
  await catalog.refresh([{ id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }])
  assert.equal(catalog.visible().filter((model) => model.source === 'trae').length, 0)
  assert.equal(catalog.visible().filter((model) => model.source === 'workbuddy').length, 1)
})

test('a single model can be switched off', async () => {
  const dir = tempDir()
  const store = makeStore(dir, 'trae')
  const catalog = new ModelCatalog(
    config({ disabledModels: ['trae/glm-5.1'] }),
    { log() {} },
    { store },
  )
  await catalog.refresh([])
  assert.equal(catalog.modelDisabled('trae/glm-5.1'), true)
  assert.equal(catalog.modelDisabled('trae/glm-5.2'), false)
})

test('the service without a model endpoint still offers its built-in table', async () => {
  const dir = tempDir()
  const store = new AccountStore({ file: join(dir, 'accounts.json'), importer: () => [] })
  const catalog = new ModelCatalog(config(), { log() {} }, { store })
  await catalog.refresh([])
  const ids = catalog.list().map((model) => model.id)
  assert.ok(ids.includes('qoder/claude-sonnet-4.5'))
  assert.ok(ids.includes('gemini/gemini-3.8-flash'))
})

test('the model of a service can be chosen', async () => {
  const dir = tempDir()
  const store = makeStore(dir, 'qoder')
  const catalog = new ModelCatalog(
    config({ providerModels: { qoder: 'qoder/gpt-4o' } }),
    { log() {} },
    { store },
  )
  await catalog.refresh([])
  assert.equal(catalog.defaultOf('qoder'), 'qoder/gpt-4o')
  assert.equal(catalog.defaultOf('gemini'), 'gemini/gemini-3.8-flash')
})
