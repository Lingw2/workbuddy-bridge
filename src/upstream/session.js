/**
 * Session discovery and renewal.
 *
 * The tool never asks for a WorkBuddy password or API key. It borrows the
 * session the WorkBuddy app already has on this machine and renews it through
 * the upstream refresh endpoint when it expires.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { APP_DIR, CREDENTIAL_SOURCES } from '../config/paths.js'
import { parseSessionFile, refreshToken } from '../upstream/workbuddy.js'

const REFRESH_MARGIN_MS = 5 * 60 * 1000

/** Where we keep our own copy of the session so we do not depend on the app. */
function localSessionPath() {
  return join(APP_DIR, 'session.json')
}

/** Read a session from one of the known locations. */
function readFrom(source) {
  if (!existsSync(source.path)) return null
  try {
    return parseSessionFile(readFileSync(source.path, 'utf8'), source.path)
  } catch {
    return null
  }
}

/**
 * Find a usable WorkBuddy session.
 *
 * Preference order: our own copy (already validated and possibly renewed),
 * then the known app locations, newest first.
 *
 * @returns {{session: object|null, source: object|null, candidates: object[]}}
 */
export function discoverSession() {
  const candidates = []

  const local = localSessionPath()
  if (existsSync(local)) {
    const session = readFrom({ id: 'local', label: '本工具保存的会话', path: local })
    if (session) candidates.push({ source: { id: 'local', label: '本工具保存的会话', path: local }, session })
  }

  for (const source of CREDENTIAL_SOURCES) {
    const session = readFrom(source)
    if (session) candidates.push({ source, session })
  }

  // Prefer a session that still has a refresh token and is not expired.
  const ranked = [...candidates].sort((a, b) => {
    const score = (entry) => {
      let value = 0
      if (entry.session.refreshToken) value += 2
      if (entry.session.expiresAt > Date.now()) value += 1
      return value
    }
    return score(b) - score(a)
  })

  return {
    session: ranked[0]?.session ?? null,
    source: ranked[0]?.source ?? null,
    candidates,
  }
}

/** Save a session copy for later runs. */
export function saveSession(session) {
  mkdirSync(APP_DIR, { recursive: true })
  writeFileSync(
    localSessionPath(),
    JSON.stringify(
      {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        domain: session.domain,
        uid: session.uid,
        uin: session.uin,
        nickname: session.nickname,
        enterpriseId: session.enterpriseId,
        expiresAt: session.expiresAt,
        refreshExpiresAt: session.refreshExpiresAt,
        savedAt: Date.now(),
      },
      null,
      2,
    ),
  )
}

/**
 * Get a session that is valid right now, renewing it if needed.
 *
 * @returns {Promise<{session: object, source: object|null, refreshed: boolean}>}
 */
export async function resolveSession() {
  const found = discoverSession()
  if (!found.session) {
    throw new Error(
      'No WorkBuddy session found. Open the WorkBuddy app and sign in, then try again.',
    )
  }

  const session = { ...found.session }
  const expiringSoon = !session.expiresAt || session.expiresAt - Date.now() < REFRESH_MARGIN_MS

  if (!expiringSoon) {
    return { session, source: found.source, refreshed: false }
  }

  if (!session.refreshToken) {
    throw new Error(
      'The WorkBuddy session has expired and carries no refresh token. Sign in to WorkBuddy again.',
    )
  }

  const renewed = await refreshToken(session)
  session.accessToken = renewed.accessToken
  if (renewed.refreshToken) session.refreshToken = renewed.refreshToken
  if (renewed.domain) session.domain = renewed.domain
  session.expiresAt = Date.now() + 24 * 60 * 60 * 1000
  saveSession(session)
  return { session, source: found.source, refreshed: true }
}

/** A short, non-secret summary for the UI. */
export function describeSession(session, source) {
  return {
    domain: session.domain,
    region: session.domain?.includes('.ai') ? 'global' : 'cn',
    uid: session.uid,
    nickname: session.nickname,
    expiresAt: session.expiresAt,
    hasRefreshToken: Boolean(session.refreshToken),
    source: source ? { id: source.id, label: source.label, path: source.path } : null,
  }
}
