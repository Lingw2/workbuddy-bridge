/**
 * Install the bridge into Claude.
 *
 * Two surfaces:
 *
 *   Claude Code (CLI)  -> `~/.claude/settings.json` env block
 *   Claude desktop     -> `%LOCALAPPDATA%\Claude-3p\configLibrary\<id>.json`
 *
 * The desktop app only accepts route names that look like Claude models, so
 * the gateway exposes `claude-*` names and maps them onto WorkBuddy models.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  CLAUDE_SETTINGS,
  CLAUDE_DESKTOP_CONFIG,
  CLAUDE_DESKTOP_META,
  CLAUDE_DESKTOP_ENTRY_ID,
} from './paths.js'
import { readJsonFile, writeJsonFile } from './json.js'
import { backupFile } from './codex.js'

/** The env block Claude Code reads. */
function claudeEnv(config) {
  const baseUrl = `http://127.0.0.1:${config.claude.port}`
  const env = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_AUTH_TOKEN: config.claude.token,
  }

  const routes = config.claude.routes ?? []
  const byTier = (tier) => routes.find((route) => route.tier === tier)
  const primary = config.claude.model

  env.ANTHROPIC_MODEL = primary
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = byTier('sonnet')?.name ?? primary
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = byTier('opus')?.name ?? primary
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = byTier('haiku')?.name ?? primary
  env.CLAUDE_CODE_SUBAGENT_MODEL = primary
  return env
}

/** Write `~/.claude/settings.json`. */
export function installClaudeCode(config) {
  backupFile(CLAUDE_SETTINGS)
  const settings = readJsonFile(CLAUDE_SETTINGS, {}) ?? {}
  settings.env = { ...(settings.env ?? {}), ...claudeEnv(config) }
  writeJsonFile(CLAUDE_SETTINGS, settings)
  return CLAUDE_SETTINGS
}

/** Read back what Claude Code currently points at. */
export function readClaudeCodeState() {
  const settings = readJsonFile(CLAUDE_SETTINGS, null)
  if (!settings) return null
  const baseUrl = settings.env?.ANTHROPIC_BASE_URL ?? null
  return {
    baseUrl,
    model: settings.env?.ANTHROPIC_MODEL ?? null,
    installed: Boolean(baseUrl?.includes('127.0.0.1')),
  }
}

/**
 * Write the Claude desktop 3p configuration.
 *
 * The desktop app reads one JSON file per configuration entry from its
 * config library. The entry id used here is the one the desktop app ships with
 * for third-party gateways.
 */
export function installClaudeDesktop(config) {
  backupFile(CLAUDE_DESKTOP_CONFIG)
  const entry = readJsonFile(CLAUDE_DESKTOP_CONFIG, {}) ?? {}

  entry.inferenceProvider = 'gateway'
  entry.inferenceGatewayBaseUrl = `http://127.0.0.1:${config.claude.port}`
  entry.inferenceGatewayApiKey = config.claude.token
  entry.inferenceGatewayAuthScheme = 'bearer'
  entry.inferenceModels = (config.claude.routes ?? []).map((route) => ({
    name: route.name,
    labelOverride: route.model,
    ...(route.tier ? { anthropicFamilyTier: route.tier } : {}),
    ...(route.familyDefault ? { isFamilyDefault: true } : {}),
    supports1m: true,
  }))
  entry.coworkEgressAllowedHosts = entry.coworkEgressAllowedHosts ?? ['*']
  entry.disableDeploymentModeChooser = true

  writeJsonFile(CLAUDE_DESKTOP_CONFIG, entry)

  // Keep the library index pointing at this entry.
  const meta = readJsonFile(CLAUDE_DESKTOP_META, null)
  if (meta) {
    meta.appliedId = CLAUDE_DESKTOP_ENTRY_ID
    if (Array.isArray(meta.entries)) {
      if (!meta.entries.some((entryMeta) => entryMeta.id === CLAUDE_DESKTOP_ENTRY_ID)) {
        meta.entries.push({ id: CLAUDE_DESKTOP_ENTRY_ID, name: 'WorkBuddy Bridge' })
      }
    }
    writeJsonFile(CLAUDE_DESKTOP_META, meta)
  }

  return CLAUDE_DESKTOP_CONFIG
}

/** Read back what the Claude desktop app currently points at. */
export function readClaudeDesktopState() {
  const entry = readJsonFile(CLAUDE_DESKTOP_CONFIG, null)
  if (!entry) return null
  return {
    provider: entry.inferenceProvider ?? null,
    baseUrl: entry.inferenceGatewayBaseUrl ?? null,
    models: (entry.inferenceModels ?? []).map((model) => model.name),
    installed: entry.inferenceProvider === 'gateway',
  }
}
