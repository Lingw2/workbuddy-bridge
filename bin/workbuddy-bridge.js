#!/usr/bin/env node
/**
 * workbuddy-bridge — use the models in your WorkBuddy account inside Codex
 * and Claude.
 *
 * Commands:
 *   ui       start the gateway and open the configuration UI (default)
 *   start    start the gateway only
 *   status   show what is running and what is configured
 *   doctor   check the account, the clients and the configuration
 *   models   list the models available in the account
 *   install  write the configuration into Codex / Claude
 */
import { App } from '../src/app.js'
import { loadConfig } from '../src/config/store.js'
import { startUiServer } from '../src/ui/server.js'
import { detectClients, CLAUDE_SETTINGS, CLAUDE_DESKTOP_CONFIG } from '../src/config/paths.js'
import { readJsonFile, writeJsonFile } from '../src/config/json.js'
import { readCodexState, installCodex, uninstallCodex, backupFile } from '../src/config/codex.js'
import {
  readClaudeCodeState,
  readClaudeDesktopState,
  installClaudeCode,
  installClaudeDesktop,
} from '../src/config/claude.js'
import { installCcSwitch, readCcSwitchState } from '../src/config/ccswitch.js'
import { resolveSession, describeSession } from '../src/upstream/session.js'

const UI_PORT = Number(process.env.WORKBUDDY_BRIDGE_UI_PORT ?? 4477)

/** Open the browser on the UI page. */
async function openUi(url) {
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    if (process.platform === 'win32') {
      await run('cmd', ['/c', 'start', '', url])
    } else if (process.platform === 'darwin') {
      await run('open', [url])
    } else {
      await run('xdg-open', [url])
    }
  } catch {
    console.log(`Open ${url} in your browser.`)
  }
}

/** `ui`: the gateway plus the configuration page. */
async function commandUi() {
  const app = new App(loadConfig())
  await app.startGateway()
  await app.loadModels()
  app.uiServer = await startUiServer({ app, port: UI_PORT })
  const url = `http://127.0.0.1:${UI_PORT}/`
  console.log(`\n  WorkBuddy Bridge`)
  console.log(`  ───────────────────────────────────────────`)
  console.log(`  UI          ${url}`)
  console.log(`  Codex       http://127.0.0.1:${app.config.codex.port}/v1/responses`)
  console.log(`  Claude      http://127.0.0.1:${app.config.claude.port}/v1/messages`)
  console.log(`  Models      ${app.bridge.models.length}`)
  console.log(`\n  Press Ctrl+C to stop.\n`)
  await openUi(url)
}

/** `start`: the gateway only. */
async function commandStart() {
  const app = new App(loadConfig())
  await app.startGateway()
  await app.loadModels()
  console.log('Gateway running. Press Ctrl+C to stop.')
  await new Promise(() => {})
}

/** `status`: what is running, what is configured. */
async function commandStatus() {
  const config = loadConfig()
  const app = new App(config)
  const clients = detectClients()

  console.log('\n  WorkBuddy Bridge status\n  ────────────────────────')
  console.log(`  codex      port ${config.codex.port}  model ${config.codex.model}`)
  console.log(`  claude     port ${config.claude.port}  model ${config.claude.model}`)
  console.log(`  clients    codex=${clients.codex} claudeCode=${clients.claudeCode} claudeDesktop=${clients.claudeDesktop} ccSwitch=${clients.ccSwitch}`)

  for (const [name, port] of [
    ['codex', config.codex.port],
    ['claude', config.claude.port],
  ]) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(1500),
      })
      const body = await response.json()
      console.log(`  ${name.padEnd(10)} running — ${body.models} models`)
    } catch {
      console.log(`  ${name.padEnd(10)} not running`)
    }
  }

  const codex = readCodexState()
  const claudeCode = readClaudeCodeState()
  const claudeDesktop = readClaudeDesktopState()
  console.log(`  codex config      ${codex?.installed ? `installed (${codex.baseUrl})` : 'not installed'}`)
  console.log(`  claude code       ${claudeCode?.installed ? `installed (${claudeCode.baseUrl})` : 'not installed'}`)
  console.log(`  claude desktop    ${claudeDesktop?.installed ? `installed (${claudeDesktop.baseUrl})` : 'not installed'}`)
  console.log('')
}

/** `doctor`: check everything that can be wrong. */
async function commandDoctor() {
  const config = loadConfig()
  const problems = []
  const notes = []

  try {
    const { session, source, refreshed } = await resolveSession()
    const described = describeSession(session, source)
    notes.push(`account ok — ${described.domain} (${described.region}), source ${described.source?.label ?? 'local cache'}${refreshed ? ', token refreshed' : ''}`)
  } catch (error) {
    problems.push(`account: ${error.message}`)
  }

  const clients = detectClients()
  if (!clients.codex) problems.push('Codex is not installed (~/.codex missing)')
  if (!clients.claudeCode) problems.push('Claude Code is not installed (~/.claude missing)')
  if (!clients.claudeDesktop) notes.push('Claude desktop not found; skipping its configuration')

  const codex = readCodexState()
  if (codex && !codex.installed) {
    problems.push(`Codex still points at "${codex.provider}"; run: workbuddy-bridge install codex`)
  }
  const claudeCode = readClaudeCodeState()
  if (claudeCode && !claudeCode.installed) {
    problems.push(`Claude Code still points at ${claudeCode.baseUrl}; run: workbuddy-bridge install claude-code`)
  }
  const claudeDesktop = readClaudeDesktopState()
  if (claudeDesktop && !claudeDesktop.installed) {
    problems.push('Claude desktop is not on the gateway provider; run: workbuddy-bridge install claude-desktop')
  }

  for (const [name, port] of [
    ['codex', config.codex.port],
    ['claude', config.claude.port],
  ]) {
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
      notes.push(`${name} gateway is up on ${port}`)
    } catch {
      notes.push(`${name} gateway is not running on ${port} (start it with: workbuddy-bridge start)`)
    }
  }

  console.log('\n  workbuddy-bridge doctor\n  ────────────────────────')
  for (const note of notes) console.log(`  · ${note}`)
  for (const problem of problems) console.log(`  ! ${problem}`)
  console.log(problems.length ? '\n  Some things need attention.\n' : '\n  Everything checks out.\n')
  if (problems.length) process.exitCode = 1
}

/** `models`: list what the account offers. */
async function commandModels() {
  const app = new App(loadConfig())
  const models = await app.loadModels()
  if (!models.length) {
    console.log('No models. Open WorkBuddy, sign in, then run: workbuddy-bridge models')
    return
  }
  console.log('\n  id                          name                    context     out      reasoning')
  console.log('  ───────────────────────────────────────────────────────────────────────────')
  for (const model of models) {
    console.log(
      `  ${model.id.padEnd(27)} ${String(model.name ?? '').padEnd(23)} ${String(model.contextWindow).padEnd(12)} ${String(model.maxOutputTokens).padEnd(8)} ${model.reasoningEfforts?.join('/') ?? '-'}`,
    )
  }
  console.log('')
}

/** `install`: write the configuration into the clients. */
async function commandInstall(targets) {
  const config = loadConfig()
  const app = new App(config)
  const models = app.bridge.models.length ? app.bridge.models : await app.loadModels()

  const list = targets.length ? targets : ['codex', 'claude-code', 'claude-desktop']
  for (const target of list) {
    try {
      if (target === 'codex') {
        console.log(`  codex          -> ${installCodex(config, models).configPath}`)
      } else if (target === 'claude-code') {
        console.log(`  claude-code    -> ${installClaudeCode(config)}`)
      } else if (target === 'claude-desktop') {
        console.log(`  claude-desktop -> ${installClaudeDesktop(config)}`)
      } else if (target === 'cc-switch') {
        const result = await installCcSwitch(config)
        console.log(
          result.ok
            ? `  cc-switch      -> registered (${result.providerIds.codex})`
            : `  cc-switch      -> skipped: ${result.reason}`,
        )
      } else {
        console.log(`  ?              unknown target: ${target}`)
      }
    } catch (error) {
      console.log(`  ${target.padEnd(14)} failed: ${error.message}`)
    }
  }
  console.log('')
}

/** `uninstall`: take the bridge back out of the clients. */
async function commandUninstall(targets) {
  const list = targets.length ? targets : ['codex', 'claude-code', 'claude-desktop']
  for (const target of list) {
    if (target === 'codex') {
      const done = uninstallCodex()
      console.log(`  codex          ${done ? 'removed' : 'nothing to remove'}`)
    } else if (target === 'claude-code') {
      const settings = readJsonFile(CLAUDE_SETTINGS, null)
      if (settings?.env) {
        for (const key of [
          'ANTHROPIC_BASE_URL',
          'ANTHROPIC_AUTH_TOKEN',
          'ANTHROPIC_MODEL',
          'ANTHROPIC_DEFAULT_SONNET_MODEL',
          'ANTHROPIC_DEFAULT_OPUS_MODEL',
          'ANTHROPIC_DEFAULT_HAIKU_MODEL',
          'ANTHROPIC_DEFAULT_FABLE_MODEL',
          'CLAUDE_CODE_SUBAGENT_MODEL',
        ]) {
          delete settings.env[key]
        }
        backupFile(CLAUDE_SETTINGS)
        writeJsonFile(CLAUDE_SETTINGS, settings)
      }
      console.log('  claude-code    cleaned')
    } else {
      console.log(`  ${target.padEnd(14)} nothing to remove`)
    }
  }
  console.log('')
}

/** Run a command and keep the process alive for the long-running ones. */
async function main() {
  const [command = 'ui', ...rest] = process.argv.slice(2)

  switch (command) {
    case 'ui':
      return commandUi()
    case 'start':
      return commandStart()
    case 'status':
      return commandStatus()
    case 'doctor':
      return commandDoctor()
    case 'models':
      return commandModels()
    case 'install':
      return commandInstall(rest)
    case 'uninstall':
      return commandUninstall(rest)
    case 'help':
    case '--help':
    case '-h':
      console.log(readHelp())
      return
    default:
      console.log(`Unknown command: ${command}\n`)
      console.log(readHelp())
      process.exitCode = 1
  }
}

function readHelp() {
  return `
  workbuddy-bridge — use your WorkBuddy models in Codex and Claude

  Usage:
    workbuddy-bridge [command]

  Commands:
    ui                 start the gateway and open the configuration page
    start              start the gateway only
    status             show what is running and what is configured
    doctor             check the account, the clients and the configuration
    models             list the models your account can use
    install [targets]  write the configuration into codex / claude-code /
                       claude-desktop (all three by default)
    uninstall [targets] remove the bridge configuration again

  Environment:
    WORKBUDDY_BRIDGE_UI_PORT   port for the configuration page (default 4477)
`
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
