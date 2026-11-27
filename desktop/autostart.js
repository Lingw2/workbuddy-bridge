/**
 * Start-on-login for the desktop application.
 *
 * Electron's own `setLoginItemSettings` is unreliable in a development run
 * (it keys the registry entry off the dev binary name), so the entry is
 * written directly under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
 * with a stable name.
 *
 * The entry launches the app with `--hidden`, which starts the gateway
 * without opening the configuration window.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const ENTRY_NAME = 'WorkBuddyBridge'

/** Read one registry value; `null` when it is absent. */
async function readValue() {
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      RUN_KEY,
      '/v',
      ENTRY_NAME,
    ])
    const match = stdout.match(/REG_SZ\s+(.+)/)
    return match ? match[1].trim() : null
  } catch {
    return null
  }
}

/** Write or remove the registry value. */
async function writeValue(value) {
  try {
    await execFileAsync('reg', [
      'add',
      RUN_KEY,
      '/v',
      ENTRY_NAME,
      '/t',
      'REG_SZ',
      '/d',
      value,
      '/f',
    ])
    return true
  } catch {
    return false
  }
}

/**
 * The command that starts this app again.
 *
 * A packaged build starts its own executable; a development run starts the
 * Electron binary with the project directory as the entry point.
 */
function buildCommand() {
  const entry = process.argv[1] ?? ''
  if (!process.defaultApp) {
    return `"${process.execPath}" --hidden`
  }
  return `"${process.execPath}" "${entry}" --hidden`
}

let commandValue = ''

/** Is start-on-login currently registered? */
export async function isEnabled() {
  const value = await readValue()
  return Boolean(value)
}

/** Register or remove start-on-login. */
export async function setEnabled(enabled) {
  if (!enabled) {
    try {
      await execFileAsync('reg', ['delete', RUN_KEY, '/v', ENTRY_NAME, '/f'])
    } catch {
      /* already gone */
    }
    return isEnabled()
  }

  commandValue = buildCommand()
  const ok = await writeValue(commandValue)
  return ok ? isEnabled() : false
}
