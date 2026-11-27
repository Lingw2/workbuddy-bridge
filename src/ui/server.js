/**
 * The local configuration UI.
 *
 * A single page, served from 127.0.0.1, with a small JSON API behind it.
 * Nothing is exposed beyond the loopback interface and the API refuses
 * requests that do not come from this machine.
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { detectClients, LOG_DIR } from '../config/paths.js'
import { loadConfig, mergeConfig } from '../config/store.js'
import { installCodex, readCodexState } from '../config/codex.js'
import {
  installClaudeCode,
  installClaudeDesktop,
  readClaudeCodeState,
  readClaudeDesktopState,
} from '../config/claude.js'
import { installCcSwitch, readCcSwitchState, isRunning as ccSwitchRunning } from '../config/ccswitch.js'
import { discoverSession, describeSession } from '../upstream/session.js'
import { providerById, PROVIDER_ORDER } from '../channels/providers.js'
import { probeAll } from '../channels/probe.js'
import { openInBrowser } from '../config/browser.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_FILE = join(HERE, 'index.html')

/** True when the request came from this machine. */
function isLocal(req) {
  const remote = req.socket.remoteAddress ?? ''
  return (
    remote === '127.0.0.1' ||
    remote === '::1' ||
    remote === '::ffff:127.0.0.1' ||
    remote.startsWith('127.')
  )
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** Read the tail of the log file. */
export function tailLog(lines = 200) {
  const file = join(LOG_DIR, 'bridge.log')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const all = text.split(/\r?\n/).filter((line) => line.length > 0)
  return all.slice(-lines)
}

/**
 * Start the UI server.
 *
 * @param {object} options
 * @param {object} options.app the running App
 * @param {number} options.port
 */
export async function startUiServer({ app, port }) {
  const server = createServer(async (req, res) => {
    if (!isLocal(req)) {
      json(res, 403, { error: 'local requests only' })
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const body = readFileSync(INDEX_FILE)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': body.length,
        'cache-control': 'no-store',
      })
      res.end(body)
      return
    }

    if (url.pathname === '/api/state' && req.method === 'GET') {
      json(res, 200, await collectState(app))
      return
    }

    if (url.pathname === '/api/config' && req.method === 'POST') {
      const patch = await readBody(req)
      const next = mergeConfig(app.config, patch)
      app.updateConfig(next)
      json(res, 200, { ok: true, config: next })
      return
    }

    if (url.pathname === '/api/models/refresh' && req.method === 'POST') {
      const models = await app.loadModels()
      json(res, 200, { ok: true, models })
      return
    }

    if (url.pathname === '/api/install' && req.method === 'POST') {
      const target = (await readBody(req)).target
      json(res, 200, await installTarget(app, target))
      return
    }

    if (url.pathname === '/api/gateway/restart' && req.method === 'POST') {
      await app.stop()
      await app.startGateway()
      json(res, 200, { ok: true })
      return
    }

    if (url.pathname === '/api/autostart' && req.method === 'POST') {
      const enabled = Boolean((await readBody(req)).enabled)
      if (!app.autoStart) {
        json(res, 200, { ok: false, error: 'this host cannot register start-on-login' })
        return
      }
      try {
        await app.autoStart.setEnabled(enabled)
        json(res, 200, { ok: true, enabled: await app.autoStart.isEnabled() })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/credit/status' && req.method === 'GET') {
      try {
        json(res, 200, { ok: true, ...(await app.credit.status()) })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/credit/claim' && req.method === 'POST') {
      try {
        const summary = await app.credit.claim({ reason: 'manual' })
        json(res, 200, { ok: true, ...summary })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/status' && req.method === 'GET') {
      try {
        json(res, 200, { ok: true, ...(await app.channels.status()) })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/claim' && req.method === 'POST') {
      try {
        const summary = await app.channels.claim({ reason: 'manual' })
        json(res, 200, { ok: true, ...summary })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/import' && req.method === 'POST') {
      try {
        const result = app.channelAccounts.importFromDsh()
        app.channels.invalidate()
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/account/add' && req.method === 'POST') {
      const body = await readBody(req)
      try {
        const account = app.channelAccounts.add({
          provider: String(body.provider ?? ''),
          accessToken: String(body.accessToken ?? ''),
          nickname: body.nickname,
          extra: body.extra ?? {},
        })
        json(res, 200, { ok: true, account })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/account/enable' && req.method === 'POST') {
      const body = await readBody(req)
      const id = String(body.id ?? '')
      try {
        const account = app.channelAccounts.setEnabled(id, Boolean(body.enabled))
        const disabled = new Set(app.config.channels?.disabledAccounts ?? [])
        if (account.enabled) disabled.delete(id)
        else disabled.add(id)
        setDisabledAccounts(app, disabled)
        json(res, 200, { ok: true, account: { id: account.id, enabled: account.enabled } })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/account/delete' && req.method === 'POST') {
      const body = await readBody(req)
      const id = String(body.id ?? '')
      try {
        app.channelAccounts.remove(id)
        const disabled = new Set(app.config.channels?.disabledAccounts ?? [])
        disabled.delete(id)
        setDisabledAccounts(app, disabled)
        json(res, 200, { ok: true })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/provider/toggle' && req.method === 'POST') {
      const body = await readBody(req)
      const id = String(body.id ?? '')
      const enabled = Boolean(body.enabled)
      try {
        const config = app.config
        const disabled = new Set(config.channels?.disabledProviders ?? [])
        if (enabled) disabled.delete(id)
        else disabled.add(id)
        app.updateConfig(mergeConfig(config, {
          channels: { disabledProviders: [...disabled] },
        }))
        json(res, 200, { ok: true, id, enabled })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/channels/login' && req.method === 'GET') {
      const id = String(url.searchParams.get('provider') ?? '')
      const provider = providerById(id)
      if (!provider) {
        json(res, 404, { error: `unknown provider: ${id}` })
        return
      }
      openInBrowser(provider.portal)
      json(res, 200, { ok: true, url: provider.portal })
      return
    }

    if (url.pathname === '/api/channels/probe' && req.method === 'GET') {
      try {
        const result = await probeAll({
          store: app.channelAccounts,
          service: app.channels,
        })
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        json(res, 200, { ok: false, error: error.message })
      }
      return
    }

    if (url.pathname === '/api/logs' && req.method === 'GET') {
      json(res, 200, { lines: tailLog(Number(url.searchParams.get('lines') ?? '200')) })
      return
    }

    json(res, 404, { error: 'not found' })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })

  return server
}

/** Gather everything the page renders. */
async function collectState(app) {
  const config = app.config
  const session = discoverSession()
  const models = app.bridge.models

  let ccSwitch = null
  try {
    ccSwitch = {
      installed: Boolean(await readCcSwitchState()),
      running: await ccSwitchRunning(),
      current: await readCcSwitchState(),
    }
  } catch {
    ccSwitch = null
  }

  return {
    config: {
      codex: config.codex,
      claude: config.claude,
      clients: config.clients,
      credit: config.credit,
      channels: config.channels,
      logLevel: config.logLevel,
    },
    models,
    session: session.session ? describeSession(session.session, session.source) : null,
    sessionSources: session.candidates.map((candidate) => ({
      id: candidate.source.id,
      label: candidate.source.label,
      path: candidate.source.path,
      domain: candidate.session.domain,
      expiresAt: candidate.session.expiresAt,
    })),
    clients: detectClients(),
    codex: readCodexState(),
    claudeCode: readClaudeCodeState(),
    claudeDesktop: readClaudeDesktopState(),
    ccSwitch,
    credit: await collectCredit(app),
    channels: await collectChannels(app),
    channelAccounts: app.channelAccounts.list(),
    autoStart: app.autoStart
      ? { supported: true, enabled: await app.autoStart.isEnabled() }
      : { supported: false, enabled: false },
    gateway: [
      { name: 'codex', port: config.codex.port },
      { name: 'claude', port: config.claude.port },
    ].map((entry) => ({
      ...entry,
      running: app.servers.some((server) => server.name === entry.name) ||
        app.externalPorts.some((entry2) => entry2.name === entry.name),
      owned: app.servers.some((server) => server.name === entry.name),
    })),
    logs: tailLog(120),
  }
}

/**
 * The state of the third-party channels.
 *
 * The upstream is asked one account at a time, so this can take a while; a
 * failure of one account must not break the page.
 */
async function collectChannels(app) {
  const settings = app.channels.settings
  const providers = app.channels.providers()

  try {
    const status = await app.channels.status({ maxAgeMs: 30_000 })
    return { supported: true, providers, ...status }
  } catch (error) {
    return { supported: true, providers, settings, error: error.message }
  }
}

/**
 * Remember that an account is switched off.
 *
 * The account store keeps its own flag; the config keeps the list the UI
 * reads back, so both stay in step.
 */
function setDisabledAccounts(app, ids) {
  app.updateConfig(
    mergeConfig(app.config, { channels: { disabledAccounts: [...new Set(ids)] } }),
  )
}

/** The credit state, without letting a billing failure break the page. */
async function collectCredit(app) {
  const settings = app.credit.settings
  try {
    const status = await app.credit.status()
    return { supported: true, ...status }
  } catch (error) {
    return { supported: true, settings, error: error.message }
  }
}

/** Install the bridge into one of the clients. */
async function installTarget(app, target) {
  const config = app.config
  try {
    if (target === 'codex') {
      const models = app.bridge.models.length ? app.bridge.models : await app.loadModels()
      const result = installCodex(config, models)
      return { ok: true, target, ...result }
    }
    if (target === 'claude-code') {
      return { ok: true, target, path: installClaudeCode(config) }
    }
    if (target === 'claude-desktop') {
      return { ok: true, target, path: installClaudeDesktop(config) }
    }
    if (target === 'cc-switch') {
      const result = await installCcSwitch(config)
      return { ...result, target }
    }
    if (target === 'all') {
      const models = app.bridge.models.length ? app.bridge.models : await app.loadModels()
      const written = [
        installCodex(config, models).configPath,
        installClaudeCode(config),
        installClaudeDesktop(config),
      ]
      const guard = await installCcSwitch(config)
      return { ok: true, target, written, guard }
    }
    return { ok: false, target, error: `unknown target: ${target}` }
  } catch (error) {
    return { ok: false, target, error: error.message }
  }
}

/** The configuration used when the CLI starts the tool. */
export { loadConfig }
