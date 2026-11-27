/**
 * The application: one process that owns the gateway servers and the config
 * UI.
 */
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { LOG_DIR } from './config/paths.js'
import { loadConfig, saveConfig } from './config/store.js'
import { Bridge } from './gateway/bridge.js'
import { GatewayServer } from './gateway/server.js'
import { CreditService } from './credit/service.js'
import { AccountStore } from './channels/store.js'
import { ChannelService } from './channels/service.js'
import { autoInstallClients } from './config/autoinstall.js'

/** A logger that writes to the log file and the console. */
export function createLogger(level = 'info') {
  mkdirSync(LOG_DIR, { recursive: true })
  const file = join(LOG_DIR, 'bridge.log')
  const stamp = () => new Date().toISOString()

  return {
    log(line) {
      const text = `${stamp()} ${line}`
      try {
        appendFileSync(file, `${text}\n`)
      } catch {
        /* the log is best effort */
      }
      if (level !== 'quiet') console.log(line)
    },
  }
}

export class App {
  constructor(config = loadConfig()) {
    this.config = config
    this.logger = createLogger(config.logLevel)
    this.bridge = new Bridge(config, this.logger)
    /** The daily WorkBuddy credit claim. */
    this.credit = new CreditService(config, this.logger)
    /** The accounts of the third-party channels. */
    this.channelAccounts = new AccountStore()
    /** The daily claim for the third-party channels. */
    this.channels = new ChannelService(config, this.logger, { store: this.channelAccounts })
    this.servers = []
    this.uiServer = null
    /** Ports served by a gateway this process did not start. */
    this.externalPorts = []
    /**
     * Optional hook for start-on-login, provided by the desktop shell.
     *
     * The CLI has no way to register itself with the OS, so the UI only shows
     * the switch when the host implements it.
     *
     * @type {null | {isEnabled: () => Promise<boolean>, setEnabled: (on: boolean) => Promise<void>}}
     */
    this.autoStart = null
  }

  /** Register the host's start-on-login implementation. */
  setAutoStart(handler) {
    this.autoStart = handler
  }

  /**
   * Start the gateway servers for every enabled client.
   *
   * A port that already serves this tool is reused instead of failing, so
   * `workbuddy-bridge ui` can be opened next to a running gateway.
   */
  async startGateway() {
    const { codex, claude } = this.config

    if (codex.enabled) {
      await this.#startOne('codex', codex.port, codex.token)
    }

    if (claude.enabled) {
      await this.#startOne('claude', claude.port, claude.token)
    }

    return this.servers
  }

  /** Start one server, or adopt the one already listening on that port. */
  async #startOne(name, port, token) {
    if (await this.#probeExisting(name, port)) {
      this.logger.log(`[${name}] reusing the gateway already listening on ${port}`)
      this.externalPorts.push({ name, port })
      return null
    }

    const server = new GatewayServer({
      name,
      port,
      token,
      bridge: this.bridge,
      config: this.config,
      logger: this.logger,
    })
    await server.start()
    this.servers.push(server)
    return server
  }

  /** Is our own gateway already listening on this port? */
  async #probeExisting(name, port) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1200),
      })
      if (!response.ok) return false
      const body = await response.json()
      return body.service === 'workbuddy-bridge' && body.client === name
    } catch {
      return false
    }
  }

  /** Load the model directory, reporting failures without crashing. */
  async loadModels() {
    try {
      return await this.bridge.refreshModels()
    } catch (error) {
      this.logger.log(`[workbuddy] model directory unavailable: ${error.message}`)
      return []
    }
  }

  /** Start the daily credit scheduler. */
  startCreditScheduler() {
    this.credit.start()
  }

  /**
   * Point the installed clients at the local gateway.
   *
   * This runs on every start, so a fresh machine is set up without the user
   * having to click through the page, and a client that was reset by another
   * tool is repaired on the next start.
   *
   * @param {boolean} [force] write the configuration even when the client
   *   already looks connected
   */
  async autoInstallClients(force = false) {
    if (this.config.autoInstall === false) {
      this.logger.log('[clients] automatic setup is switched off')
      return null
    }
    try {
      const result = await autoInstallClients(this)
      for (const [id, entry] of Object.entries(result.clients ?? {})) {
        if (entry?.ok && !entry.already) {
          this.logger.log(`[clients] ${id} now points at the gateway`)
        } else if (entry?.ok && entry.already) {
          this.logger.log(`[clients] ${id} already points at the gateway`)
        } else if (entry?.skipped) {
          this.logger.log(`[clients] ${id} skipped: ${entry.skipped}`)
        } else if (entry?.error) {
          this.logger.log(`[clients] ${id} failed: ${entry.error}`)
        }
      }
      return result
    } catch (error) {
      this.logger.log(`[clients] automatic setup failed: ${error.message}`)
      return null
    }
  }

  /**
   * Start the daily claim scheduler for the third-party channels.
   *
   * The accounts of the other plugin are imported once, so the user does not
   * have to paste a token for every account.
   */
  startChannelScheduler() {
    try {
      const imported = this.channelAccounts.importFromDsh()
      if (imported.added > 0) {
        this.logger.log(`[channels] imported ${imported.added} accounts from the other plugin`)
      }
    } catch (error) {
      this.logger.log(`[channels] could not import accounts: ${error.message}`)
    }
    this.channels.start()
  }

  /** Stop every server. */
  async stop() {
    this.credit.stop()
    this.channels.stop()
    for (const server of this.servers) await server.stop()
    this.servers = []
    if (this.uiServer) {
      await new Promise((resolve) => this.uiServer.close(resolve))
      this.uiServer = null
    }
  }

  /** Replace the configuration and persist it. */
  updateConfig(next) {
    this.config = saveConfig(next)
    this.bridge.config = this.config
    this.credit.config = this.config
    this.channels.config = this.config
    return this.config
  }
}
