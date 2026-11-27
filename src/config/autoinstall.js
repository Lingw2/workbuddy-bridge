/**
 * The automatic client setup.
 *
 * The user asked for a tool that works on a fresh machine without clicking
 * through a wizard: as soon as the gateway starts it looks for Codex, Claude
 * Code and the Claude desktop app, and points them at the local gateway.
 *
 * Every step is optional and every failure is reported instead of thrown, so
 * a missing client never keeps the gateway from starting.
 */
import { installCodex, readCodexState } from './codex.js'
import { installClaudeCode, readClaudeCodeState } from './claude.js'
import { installClaudeDesktop, readClaudeDesktopState } from './claude.js'
import { installCcSwitch, readCcSwitchState } from './ccswitch.js'
import { detectClients } from './paths.js'

/**
 * The clients that can be set up, and how to read their state back.
 */
const TARGETS = [
  {
    id: 'codex',
    label: 'Codex',
    install: (config, models) => installCodex(config, models),
    state: readCodexState,
  },
  {
    id: 'claudeCode',
    label: 'Claude Code',
    install: (config) => installClaudeCode(config),
    state: readClaudeCodeState,
  },
  {
    id: 'claudeDesktop',
    label: 'Claude 桌面版',
    install: (config) => installClaudeDesktop(config),
    state: readClaudeDesktopState,
  },
]

/**
 * Point every installed client at the local gateway.
 *
 * @param {object} app the running App
 * @returns {Promise<object>} what was done, per client
 */
export async function autoInstallClients(app) {
  const config = app.config
  const detected = detectClients()
  const models = app.bridge.models.length ? app.bridge.models : await app.loadModels()
  const result = { at: Date.now(), clients: {}, errors: [] }

  for (const target of TARGETS) {
    if (config.clients?.[target.id] === false) {
      result.clients[target.id] = { skipped: 'switched off in the settings' }
      continue
    }

    if (!detected[target.id]) {
      result.clients[target.id] = { skipped: `${target.label} is not installed` }
      continue
    }

    try {
      const state = target.state()
      if (state?.installed) {
        result.clients[target.id] = { ok: true, already: true, baseUrl: state.baseUrl }
        continue
      }
      const written = target.install(config, models)
      result.clients[target.id] = { ok: true, path: written?.configPath ?? written?.path ?? null }
    } catch (error) {
      result.clients[target.id] = { ok: false, error: error.message }
      result.errors.push(`${target.label}: ${error.message}`)
    }
  }

  // cc-switch rewrites the files above, so it needs a provider of its own to
  // keep it from putting the old configuration back.
  if (detected.ccSwitch) {
    try {
      const guard = await installCcSwitch(config)
      result.clients.ccSwitch = guard
    } catch (error) {
      result.clients.ccSwitch = { ok: false, error: error.message }
      result.errors.push(`cc-switch: ${error.message}`)
    }
  }

  return result
}

/**
 * Read back what every client points at.
 *
 * @returns {object}
 */
export function clientStates() {
  const states = {}
  for (const target of TARGETS) {
    try {
      states[target.id] = target.state()
    } catch {
      states[target.id] = null
    }
  }
  try {
    states.ccSwitch = readCcSwitchState()
  } catch {
    states.ccSwitch = null
  }
  return states
}
