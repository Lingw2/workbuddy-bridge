/**
 * Platform paths.
 *
 * Everything the tool reads or writes lives under the user's home directory so
 * the project itself can stay read-only and relocatable.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

export const HOME = homedir()

/** This tool's own state directory (config, logs). */
export const APP_DIR = join(HOME, '.workbuddy-bridge')
export const CONFIG_FILE = join(APP_DIR, 'config.json')
export const LOG_DIR = join(APP_DIR, 'logs')

/** Codex (CLI and desktop share this directory). */
export const CODEX_DIR = join(HOME, '.codex')
export const CODEX_CONFIG = join(CODEX_DIR, 'config.toml')
export const CODEX_MODEL_CATALOG = join(CODEX_DIR, 'cc-switch-model-catalog.json')

/** Claude Code CLI. */
export const CLAUDE_DIR = join(HOME, '.claude')
export const CLAUDE_SETTINGS = join(CLAUDE_DIR, 'settings.json')

/** Claude desktop, 3p (gateway) configuration. */
export const CLAUDE_DESKTOP_DIR = join(HOME, 'AppData', 'Local', 'Claude-3p')
export const CLAUDE_DESKTOP_CONFIG_LIBRARY = join(CLAUDE_DESKTOP_DIR, 'configLibrary')
export const CLAUDE_DESKTOP_ENTRY_ID = '00000000-0000-4000-8000-000000157210'
export const CLAUDE_DESKTOP_CONFIG = join(
  CLAUDE_DESKTOP_CONFIG_LIBRARY,
  `${CLAUDE_DESKTOP_ENTRY_ID}.json`,
)
export const CLAUDE_DESKTOP_META = join(CLAUDE_DESKTOP_CONFIG_LIBRARY, '_meta.json')

/** cc-switch, an optional provider switcher that rewrites the files above. */
export const CCSWITCH_DIR = join(HOME, '.cc-switch')
export const CCSWITCH_DB = join(CCSWITCH_DIR, 'cc-switch.db')
export const CCSWITCH_SETTINGS = join(CCSWITCH_DIR, 'settings.json')
export const CCSWITCH_LIVE_STATE = join(CCSWITCH_DIR, 'live-state.json')

/**
 * Candidate locations for a signed-in WorkBuddy session.
 *
 * The desktop app writes its session next to its extension data; the CLI
 * plugin keeps a vault copy. Both are read-only for us — we only borrow the
 * tokens and refresh them through the upstream refresh endpoint.
 */
export const CREDENTIAL_SOURCES = [
  {
    id: 'desktop-extension',
    label: 'WorkBuddy 桌面端（扩展数据）',
    path: join(HOME, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  },
  {
    id: 'desktop-extension-roaming',
    label: 'WorkBuddy 桌面端（漫游数据）',
    path: join(HOME, 'AppData', 'Roaming', 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'),
  },
  {
    id: 'vault-cn',
    label: 'WorkBuddy CLI 凭据库（CN）',
    path: join(HOME, '.dsh', 'workbuddy-vault', 'cn', '5998bb1a4d7d530a8cf2531e.json'),
  },
  {
    id: 'vault-global',
    label: 'WorkBuddy CLI 凭据库（国际）',
    path: join(HOME, '.dsh', 'workbuddy-vault', 'global', '509a52dae3ecf2a6dd46dbea.json'),
  },
]

/** The WorkBuddy app and CLI channel identities the upstream understands. */
export const USER_AGENTS = {
  app: 'WorkBuddy/5.11.3 WorkBuddy/5.11.3 CLI/2.63.2',
  cli: 'CLI/2.63.2 CodeBuddy/2.63.2',
}

/** Which of the well-known clients are installed on this machine. */
export function detectClients() {
  return {
    codex: existsSync(CODEX_DIR),
    claudeCode: existsSync(CLAUDE_DIR),
    claudeDesktop: existsSync(CLAUDE_DESKTOP_CONFIG_LIBRARY),
    ccSwitch: existsSync(CCSWITCH_DB),
  }
}
