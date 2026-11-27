/**
 * The account store for the third-party channels.
 *
 * Accounts come from two places:
 *
 *   1. The "Our Free Model" plugin's own account pool, which we import once
 *      and then own a copy of.
 *   2. Accounts the user adds here, with a pasted access token.
 *
 * The store keeps its own file so that deleting an account here really
 * deletes it, and so that the app still works when the other plugin is not
 * installed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { APP_DIR } from '../config/paths.js'
import { readDshAccounts } from './dsh-store.js'
import { providerById } from './providers.js'

/** Where the accounts are kept. */
export const ACCOUNTS_FILE = join(APP_DIR, 'channel-accounts.json')

/** Read the persisted accounts. */
function readFile(path) {
  if (!existsSync(path)) return { accounts: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return { accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] }
  } catch {
    return { accounts: [] }
  }
}

/** Write the accounts back. */
function writeFile(path, state) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`)
}

export class AccountStore {
  /**
   * @param {object} [options]
   * @param {string} [options.file] where the accounts are kept
   * @param {() => Array<object>} [options.importer] where imported accounts come from
   */
  constructor(options = {}) {
    this.file = options.file ?? ACCOUNTS_FILE
    this.importer = options.importer ?? readDshAccounts
    this.state = readFile(this.file)
    this.imported = false
  }

  /** Every account, with the provider attached. */
  list() {
    const result = []
    for (const entry of this.state.accounts) {
      const provider = providerById(entry.provider)
      if (!provider) continue
      result.push({
        id: entry.id,
        provider: entry.provider,
        providerLabel: provider.label,
        color: provider.color,
        nickname: entry.nickname ?? entry.id,
        enabled: entry.enabled !== false,
        imported: entry.imported === true,
        hasToken: Boolean(entry.credential?.access_token || entry.credential?.zcode_jwt),
      })
    }
    return result
  }

  /** One account, including its credential. */
  get(id) {
    const entry = this.state.accounts.find((candidate) => candidate.id === id)
    if (!entry) return null
    const provider = providerById(entry.provider)
    if (!provider) return null
    return { ...entry, provider }
  }

  /** Every account of one provider, credentials included. */
  listByProvider(providerId) {
    return this.state.accounts
      .filter((entry) => entry.provider === providerId)
      .map((entry) => ({
        ...entry,
        providerId: entry.provider,
        provider: providerById(entry.provider),
      }))
      .filter((entry) => entry.provider)
  }

  /**
   * Copy the accounts of the other plugin into our own store.
   *
   * Accounts the user deleted here are not brought back.
   *
   * @returns {{added: number, skipped: number}}
   */
  importFromDsh() {
    const incoming = this.importer()
    const known = new Set(this.state.accounts.map((entry) => entry.id))
    let added = 0
    let skipped = 0

    for (const account of incoming) {
      if (!providerById(account.provider)) {
        skipped++
        continue
      }
      if (known.has(account.id)) {
        skipped++
        continue
      }
      this.state.accounts.push({
        id: account.id,
        provider: account.provider,
        nickname: account.nickname,
        enabled: true,
        imported: true,
        credential: account.credential,
      })
      known.add(account.id)
      added++
    }

    this.imported = true
    if (added > 0) writeFile(this.file, this.state)
    return { added, skipped }
  }

  /**
   * Add an account with a pasted access token.
   *
   * @param {object} input
   * @param {string} input.provider
   * @param {string} input.accessToken
   * @param {string} [input.nickname]
   * @param {object} [input.extra] other credential fields to keep
   */
  add({ provider, accessToken, nickname, extra = {} }) {
    if (!providerById(provider)) throw new Error(`unknown provider: ${provider}`)
    const token = String(accessToken ?? '').trim()
    if (!token) throw new Error('the access token is empty')

    const id = `${provider}-${Math.random().toString(16).slice(2, 10)}`
    this.state.accounts.push({
      id,
      provider,
      nickname: String(nickname ?? '').trim() || id,
      enabled: true,
      imported: false,
      credential: { access_token: token, ...extra },
    })
    writeFile(this.file, this.state)
    return this.get(id)
  }

  /** Switch one account on or off. */
  setEnabled(id, enabled) {
    const entry = this.state.accounts.find((candidate) => candidate.id === id)
    if (!entry) throw new Error(`unknown account: ${id}`)
    entry.enabled = Boolean(enabled)
    writeFile(this.file, this.state)
    return this.get(id)
  }

  /** Delete one account. */
  remove(id) {
    const before = this.state.accounts.length
    this.state.accounts = this.state.accounts.filter((candidate) => candidate.id !== id)
    if (this.state.accounts.length === before) throw new Error(`unknown account: ${id}`)
    writeFile(this.file, this.state)
    return true
  }

  /** Delete every account of one provider. */
  removeProvider(providerId) {
    const before = this.state.accounts.length
    this.state.accounts = this.state.accounts.filter((entry) => entry.provider !== providerId)
    const removed = before - this.state.accounts.length
    writeFile(this.file, this.state)
    return removed
  }
}
