/**
 * Reading the credentials another DSH plugin already stored.
 *
 * The "Our Free Model" plugin keeps its account pool in two files under the
 * DSH home directory:
 *
 *   settings-legacy.yaml   the account list (provider, nickname, ref name)
 *   .credentials.yaml      the secret behind every ref name
 *
 * We only READ them — they belong to another program and it may rewrite them
 * at any time. Everything we learn is copied into our own store so the rest
 * of the app never depends on a file another program owns.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { HOME } from '../config/paths.js'

/** Where the other plugin keeps its files. */
export const DSH_HOME = process.env.DSH_HOME ?? join(HOME, '.dsh')
export const DSH_CREDENTIALS = join(DSH_HOME, '.credentials.yaml')
export const DSH_SETTINGS = join(DSH_HOME, 'settings-legacy.yaml')
export const DSH_SETTINGS_YAML = join(DSH_HOME, 'settings.yaml')

/**
 * Read the `refs:` section of a credentials file.
 *
 * The values are YAML single-quoted scalars, and the JSON inside them can be
 * long enough that the writer folded it across several lines. YAML folds a
 * line break into a single space, so the value is reassembled the same way.
 *
 * @param {string} text
 * @returns {Map<string, string>} the raw JSON text of every ref
 */
export function parseCredentialRefs(text) {
  const refs = new Map()
  const lines = text.split(/\r?\n/)

  let inRefs = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]

    if (!inRefs) {
      if (/^refs:\s*$/.test(line)) inRefs = true
      continue
    }

    const match = /^ {2}([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line)
    if (!match) {
      // A new top-level key ends the section.
      if (/^\S/.test(line)) break
      continue
    }

    const [, name, first] = match
    const value = first.startsWith("'")
      ? readFoldedQuoted(lines, index, first)
      : first.trim()
    refs.set(name, value)
  }

  return refs
}

/**
 * Read a YAML single-quoted scalar that may continue on the next lines.
 *
 * @param {string[]} lines
 * @param {number} start the line the scalar starts on
 * @param {string} first the text after `name: `
 * @returns {string} the unfolded value
 */
function readFoldedQuoted(lines, start, first) {
  let text = first.slice(1) // drop the opening quote
  let index = start

  while (index < lines.length) {
    const end = findClosingQuote(text)
    if (end !== -1) {
      return text.slice(0, end).replace(/''/g, "'")
    }
    index++
    if (index >= lines.length) break
    text += ` ${lines[index].trim()}`
  }

  return text.replace(/'/g, '')
}

/** Find the closing quote of a YAML single-quoted scalar. */
function findClosingQuote(text) {
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "'") continue
    if (text[index + 1] === "'") {
      index++
      continue
    }
    return index
  }
  return -1
}

/**
 * Read the account list from the plugin's settings file.
 *
 * The file is a plain block YAML: a `channel-pack:` mapping with an
 * `accounts:` sequence of flat records. Only that shape is understood.
 *
 * @param {string} text
 * @returns {Array<object>}
 */
export function parseAccountList(text) {
  const lines = text.split(/\r?\n/)
  const accounts = []
  let inChannelPack = false
  let inAccounts = false
  let current = null

  for (const line of lines) {
    if (/^channel-pack:\s*$/.test(line)) {
      inChannelPack = true
      continue
    }
    if (!inChannelPack) continue

    // A new top-level key ends the section.
    if (/^[A-Za-z]/.test(line) && !/^ {2}/.test(line)) {
      inChannelPack = false
      inAccounts = false
      continue
    }

    if (/^ {2}accounts:\s*$/.test(line)) {
      inAccounts = true
      continue
    }
    if (inAccounts && /^ {2}\S/.test(line)) {
      inAccounts = false
      continue
    }
    if (!inAccounts) continue

    const item = /^ {4}-\s*(\S.*)$/.exec(line)
    if (item) {
      if (current) accounts.push(current)
      current = {}
      const [key, ...rest] = item[1].split(':')
      if (rest.length) current[key.trim()] = rest.join(':').trim()
      continue
    }

    const field = /^ {6}(\S+):\s*(.*)$/.exec(line)
    if (field && current) {
      current[field[1]] = field[2].trim()
      continue
    }

    // A nested mapping (modelRateLimits and friends) is kept as raw text.
    const nested = /^ {8}(\S+):\s*(.*)$/.exec(line)
    if (nested && current) {
      current[nested[1]] = nested[2].trim()
    }
  }

  if (current) accounts.push(current)
  return accounts
}

/**
 * Read every account the other plugin has, with its credential attached.
 *
 * @returns {Array<object>} accounts with `{id, provider, nickname, credential}`
 */
export function readDshAccounts() {
  if (!existsSync(DSH_CREDENTIALS)) return []

  let refs = new Map()
  let accounts = []
  try {
    refs = parseCredentialRefs(readFileSync(DSH_CREDENTIALS, 'utf8'))
  } catch {
    return []
  }

  const settingsFile = existsSync(DSH_SETTINGS_YAML) ? DSH_SETTINGS_YAML : DSH_SETTINGS
  if (existsSync(settingsFile)) {
    try {
      accounts = parseAccountList(readFileSync(settingsFile, 'utf8'))
    } catch {
      accounts = []
    }
  }

  const result = []
  for (const entry of accounts) {
    const ref = entry.credentialRef
    if (!ref) continue
    const raw = refs.get(ref)
    if (!raw) continue

    let credential = null
    try {
      credential = JSON.parse(raw)
    } catch {
      continue
    }
    if (!credential || typeof credential !== 'object') continue

    result.push({
      id: entry.id ?? `${entry.provider}-${ref}`,
      provider: entry.provider,
      nickname: entry.nickname ?? entry.id,
      enabled: entry.enabled !== 'false',
      credential,
      source: 'dsh',
    })
  }

  return result
}
