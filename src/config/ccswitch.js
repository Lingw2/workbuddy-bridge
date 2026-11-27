/**
 * Optional cc-switch protection.
 *
 * cc-switch is a provider switcher that rewrites the same files this tool
 * writes (`~/.codex/config.toml`, `~/.claude/settings.json`, the Claude
 * desktop configuration). When it is installed and a different provider is
 * selected, it overwrites the bridge configuration on its next switch.
 *
 * This module registers the bridge as a cc-switch provider so that selecting
 * it inside cc-switch keeps the same configuration, and so that the current
 * selection points at the bridge.
 *
 * The database is only touched when cc-switch is not running, and it is always
 * backed up first.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  CCSWITCH_DB,
  CCSWITCH_SETTINGS,
  CCSWITCH_LIVE_STATE,
} from './paths.js'

const execFileAsync = promisify(execFile)

/** The provider ids the bridge registers. */
export const CODEX_PROVIDER_ID = '11111111-0000-4000-8000-000000000001'
export const CLAUDE_PROVIDER_ID = '11111111-0000-4000-8000-000000000003'
export const CLAUDE_DESKTOP_PROVIDER_ID = '11111111-0000-4000-8000-000000000002'
export const PROVIDER_NAME = 'WorkBuddy Bridge'

/**
 * Names earlier versions of this tool used.
 *
 * The provider row is reused instead of duplicated when one of these is found,
 * so upgrading the tool does not pile up rows in the cc-switch database.
 */
const LEGACY_PROVIDER_NAMES = ['WorkBuddy Gateway']

/** Is cc-switch running right now? */
export async function isRunning() {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq cc-switch.exe', '/NH'])
    return stdout.toLowerCase().includes('cc-switch.exe')
  } catch {
    return false
  }
}

/** Load node:sqlite lazily so the tool still runs on Node versions without it. */
async function loadSqlite() {
  try {
    const mod = await import('node:sqlite')
    return mod.DatabaseSync
  } catch {
    return null
  }
}

/**
 * The Codex provider config cc-switch expects.
 *
 * cc-switch writes this TOML over `~/.codex/config.toml` when the provider
 * is selected, so it has to carry everything the desktop app needs — the
 * shared common config plus the bridge provider.
 *
 * @param {object} config
 * @param {string} commonConfig the shared `common_config_codex` value
 */
function codexProviderConfig(config, commonConfig) {
  const baseUrl = `http://127.0.0.1:${config.codex.port}/v1`
  const bridge = [
    `model_provider = "workbuddy"`,
    `model = "${config.codex.model}"`,
    `model_reasoning_effort = "${config.codex.reasoningEffort}"`,
    '',
    '[model_providers.workbuddy]',
    'name = "workbuddy"',
    `base_url = "${baseUrl}"`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    `experimental_bearer_token = "${config.codex.token}"`,
  ].join('\n')

  const shared = (commonConfig ?? '').trim()
  const merged = shared
    ? `${shared}\n\n${bridge}\n`
    : `${bridge}\n`

  return {
    auth: { OPENAI_API_KEY: config.codex.token },
    config: merged,
  }
}

/** The Claude desktop provider config cc-switch expects. */
function claudeProviderConfig(config) {
  const routes = {}
  for (const route of config.claude.routes ?? []) {
    routes[route.name] = {
      model: route.model,
      labelOverride: route.model,
      supports1m: true,
    }
  }

  return {
    env: {
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${config.claude.port}`,
      ANTHROPIC_AUTH_TOKEN: config.claude.token,
    },
    meta: {
      claudeDesktopMode: 'direct',
      claudeDesktopModelRoutes: routes,
      apiFormat: 'anthropic',
    },
  }
}

/**
 * Register the bridge inside cc-switch and make it the current provider.
 *
 * @param {object} config
 * @returns {Promise<{ok: boolean, reason?: string, providerIds?: object}>}
 */
export async function installCcSwitch(config) {
  if (!existsSync(CCSWITCH_DB)) {
    return { ok: false, reason: 'cc-switch is not installed on this machine' }
  }
  if (await isRunning()) {
    return { ok: false, reason: 'cc-switch is running; quit it first so the database is not locked' }
  }

  const DatabaseSync = await loadSqlite()
  if (!DatabaseSync) {
    return { ok: false, reason: 'node:sqlite is unavailable; install Node 22.5 or newer' }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  copyFileSync(CCSWITCH_DB, `${CCSWITCH_DB}.bak-workbuddy-${stamp}`)

  let providerIds = null
  let commonConfig = ''

  const db = new DatabaseSync(CCSWITCH_DB)
  try {
    const now = Date.now()

    // The shared Codex settings cc-switch keeps; the bridge provider has to be
    // merged with them or the desktop configuration is lost.
    const commonRow = db
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get('common_config_codex')
    commonConfig = commonRow?.value ?? ''

    // Reuse a provider this tool registered before, so repeated installs do not
    // pile up duplicates.
    const findExisting = (appType) => {
      const names = [PROVIDER_NAME, ...LEGACY_PROVIDER_NAMES]
      for (const name of names) {
        const row = db
          .prepare(`SELECT id FROM providers WHERE app_type = ? AND name = ?`)
          .get(appType, name)
        if (row) return row.id
      }
      return null
    }
    const codexId = findExisting('codex') ?? CODEX_PROVIDER_ID
    const claudeId = findExisting('claude') ?? CLAUDE_PROVIDER_ID
    const claudeDesktopId = findExisting('claude-desktop') ?? CLAUDE_DESKTOP_PROVIDER_ID

    // The primary key is (id, app_type), so the conflict target has to name
    // both columns.
    const insertProvider = db.prepare(`
      INSERT INTO providers (id, app_type, name, settings_config, website_url, category,
                             created_at, sort_index, notes, icon, icon_color, meta,
                             is_current, in_failover_queue, cost_multiplier,
                             limit_daily_usd, limit_monthly_usd, provider_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, '1.0', NULL, NULL, 'custom')
      ON CONFLICT(id, app_type) DO UPDATE SET
        name = excluded.name,
        settings_config = excluded.settings_config,
        meta = excluded.meta,
        is_current = 1
    `)

    insertProvider.run(
      codexId,
      'codex',
      PROVIDER_NAME,
      JSON.stringify(codexProviderConfig(config, commonConfig)),
      'https://www.workbuddy.cn',
      'custom',
      now,
      100,
      'Local WorkBuddy gateway for Codex',
      null,
      null,
      JSON.stringify({ apiFormat: 'openai_responses', commonConfigEnabled: true }),
    )

    insertProvider.run(
      claudeId,
      'claude',
      PROVIDER_NAME,
      JSON.stringify(claudeProviderConfig(config)),
      'https://www.workbuddy.cn',
      'custom',
      now,
      100,
      'Local WorkBuddy gateway for Claude Code',
      null,
      null,
      JSON.stringify({ apiFormat: 'anthropic' }),
    )

    insertProvider.run(
      claudeDesktopId,
      'claude-desktop',
      PROVIDER_NAME,
      JSON.stringify(claudeProviderConfig(config)),
      'https://www.workbuddy.cn',
      'custom',
      now,
      100,
      'Local WorkBuddy gateway for Claude desktop',
      null,
      null,
      JSON.stringify({
        claudeDesktopMode: 'direct',
        claudeDesktopModelRoutes: Object.fromEntries(
          (config.claude.routes ?? []).map((route) => [
            route.name,
            { model: route.model, labelOverride: route.model, supports1m: true },
          ]),
        ),
        apiFormat: 'anthropic',
      }),
    )

    // Any other provider of the same kind stops being current.
    for (const [appType, id] of [
      ['codex', codexId],
      ['claude', claudeId],
      ['claude-desktop', claudeDesktopId],
    ]) {
      db.prepare(
        `UPDATE providers SET is_current = 0 WHERE app_type = ? AND id <> ?`,
      ).run(appType, id)
    }

    db.close()
    providerIds = { codex: codexId, claude: claudeId, claudeDesktop: claudeDesktopId }
  } catch (error) {
    try {
      db.close()
    } catch {
      /* ignore */
    }
    return { ok: false, reason: error.message }
  }

  patchCcSwitchSettings(providerIds)
  patchCcSwitchLiveState()

  return {
    ok: true,
    providerIds,
  }
}

/** Point cc-switch's own settings at the bridge providers. */
function patchCcSwitchSettings(providerIds) {
  if (!existsSync(CCSWITCH_SETTINGS)) return
  try {
    const settings = JSON.parse(readFileSync(CCSWITCH_SETTINGS, 'utf8'))
    settings.currentProviderCodex = providerIds.codex
    settings.currentProviderClaude = providerIds.claude
    settings.currentProviderClaudeDesktop = providerIds.claudeDesktop
    writeFileSync(CCSWITCH_SETTINGS, `${JSON.stringify(settings, null, 2)}\n`)
  } catch {
    /* optional */
  }
}

/**
 * Turn off cc-switch's own proxy for Codex.
 *
 * Its proxy speaks the chat/completions dialect, which the Responses API does
 * not understand, so the bridge has to be reached directly.
 */
function patchCcSwitchLiveState() {
  if (!existsSync(CCSWITCH_LIVE_STATE)) return
  try {
    const state = JSON.parse(readFileSync(CCSWITCH_LIVE_STATE, 'utf8'))
    // The live state nests the per-app entries under `apps`.
    const apps = state.apps ?? state
    if (apps.codex) {
      apps.codex.mode = 'direct'
      delete apps.codex.proxy_route
      delete apps.codex.proxyRoute
    }
    writeFileSync(CCSWITCH_LIVE_STATE, `${JSON.stringify(state, null, 2)}\n`)
  } catch {
    /* optional */
  }
}

/** What cc-switch currently points at. */
export async function readCcSwitchState() {
  if (!existsSync(CCSWITCH_DB)) return null
  const DatabaseSync = await loadSqlite()
  if (!DatabaseSync) return null
  const db = new DatabaseSync(CCSWITCH_DB, { readOnly: true })
  try {
    const rows = db
      .prepare(`SELECT id, app_type, name, is_current FROM providers WHERE is_current = 1`)
      .all()
    return rows.map((row) => ({
      id: row.id,
      appType: row.app_type,
      name: row.name,
      isBridge:
        row.name === PROVIDER_NAME || LEGACY_PROVIDER_NAMES.includes(row.name),
    }))
  } catch {
    return null
  } finally {
    db.close()
  }
}
