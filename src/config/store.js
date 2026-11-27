/**
 * The tool's own configuration.
 *
 * One JSON file under the user's home directory holds everything the UI can
 * change. Tokens for the local gateway are generated once and never leave the
 * machine.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

import { APP_DIR, CONFIG_FILE } from './paths.js'

/** The default Claude route table, used until the user changes it. */
export const DEFAULT_CLAUDE_ROUTES = [
  { name: 'claude-sonnet-5', model: 'deepseek-v4-pro', tier: 'sonnet', familyDefault: true },
  { name: 'claude-opus-5', model: 'deepseek-v4-pro', tier: 'opus' },
  { name: 'claude-fable-5', model: 'glm-5.3', tier: 'fable' },
  { name: 'claude-haiku-4-5', model: 'deepseek-v4.1-flash', tier: 'haiku', familyDefault: true },
]

export const DEFAULTS = {
  codex: {
    enabled: true,
    port: 4000,
    model: 'deepseek-v4-pro',
    reasoningEffort: 'high',
    token: '',
  },
  claude: {
    enabled: true,
    port: 4001,
    model: 'deepseek-v4-pro',
    token: '',
    routes: DEFAULT_CLAUDE_ROUTES,
  },
  clients: {
    codex: true,
    claudeCode: true,
    claudeDesktop: true,
  },
  logLevel: 'info',
}

/** Generate a token the local gateway requires in the Authorization header. */
function newToken(prefix) {
  return `wbg-${prefix}-${randomBytes(16).toString('hex')}`
}

/**
 * Read the config, filling in defaults for anything missing.
 *
 * The file is written back when it was absent or when a freshly generated
 * token had to be filled in, so the tokens are stable across restarts.
 */
export function loadConfig() {
  const existed = existsSync(CONFIG_FILE)
  let stored = {}
  if (existed) {
    try {
      stored = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    } catch {
      stored = {}
    }
  }

  const config = {
    ...DEFAULTS,
    ...stored,
    codex: { ...DEFAULTS.codex, ...(stored.codex ?? {}) },
    claude: { ...DEFAULTS.claude, ...(stored.claude ?? {}) },
    clients: { ...DEFAULTS.clients, ...(stored.clients ?? {}) },
  }

  let generated = false
  if (!config.codex.token) {
    config.codex.token = newToken('codex')
    generated = true
  }
  if (!config.claude.token) {
    config.claude.token = newToken('claude')
    generated = true
  }
  if (!Array.isArray(config.claude.routes) || config.claude.routes.length === 0) {
    config.claude.routes = DEFAULT_CLAUDE_ROUTES.map((route) => ({ ...route }))
    generated = true
  }

  if (!existed || generated) saveConfig(config)

  return config
}

/** Write the config back, keeping a timestamped backup of the previous file. */
export function saveConfig(config) {
  mkdirSync(APP_DIR, { recursive: true })
  if (existsSync(CONFIG_FILE)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak-${stamp}`)
  }
  writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`)
  return config
}

/** Deep-ish merge for the settings the UI posts back. */
export function mergeConfig(current, patch) {
  const next = { ...current }
  if (patch.codex) next.codex = { ...current.codex, ...patch.codex }
  if (patch.claude) {
    next.claude = { ...current.claude, ...patch.claude }
    if (Array.isArray(patch.claude.routes)) {
      next.claude.routes = patch.claude.routes.map((route) => ({
        name: String(route.name ?? ''),
        model: String(route.model ?? ''),
        tier: route.tier ?? undefined,
        familyDefault: Boolean(route.familyDefault),
      }))
    }
  }
  if (patch.clients) next.clients = { ...current.clients, ...patch.clients }
  if (typeof patch.logLevel === 'string') next.logLevel = patch.logLevel
  return next
}
