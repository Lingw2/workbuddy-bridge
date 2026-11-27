/**
 * Try a real daily check-in with the international account.
 *
 * The CN account has already checked in today, and the upstream is
 * idempotent, so the second account is the only way to watch a payout
 * actually happen.
 *
 *   node tools/probe-claim-global.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseSessionFile } from '../src/upstream/workbuddy.js'
import {
  billingBase,
  claimDailyCheckin,
  fetchCheckinStatus,
} from '../src/upstream/credit.js'

const HOME = process.env.USERPROFILE
const VAULT_GLOBAL = join(HOME, '.dsh', 'workbuddy-vault', 'global', '509a52dae3ecf2a6dd46dbea.json')

const session = parseSessionFile(readFileSync(VAULT_GLOBAL, 'utf8'), VAULT_GLOBAL)
if (!session) {
  console.log('no global session')
  process.exit(1)
}

console.log(`session: domain=${session.domain} uid=${session.uid}`)
console.log(`billing base: ${billingBase(session.domain)}`)

console.log('\n--- status before ---')
try {
  console.log(JSON.stringify(await fetchCheckinStatus(session), null, 2))
} catch (error) {
  console.log(`status ERROR: ${error.message}`)
}

console.log('\n--- claim ---')
try {
  console.log(JSON.stringify(await claimDailyCheckin(session), null, 2))
} catch (error) {
  console.log(`claim ERROR: ${error.message} (code=${error.code ?? '-'} status=${error.status ?? '-'})`)
}

console.log('\n--- status after ---')
try {
  console.log(JSON.stringify(await fetchCheckinStatus(session), null, 2))
} catch (error) {
  console.log(`status ERROR: ${error.message}`)
}
