/**
 * Print the cc-switch provider table.
 *
 * Useful when the bridge and cc-switch disagree about the current provider.
 *
 *   node tools/dump-ccswitch.mjs
 */
import { DatabaseSync } from 'node:sqlite'

import { CCSWITCH_DB } from '../src/config/paths.js'

const db = new DatabaseSync(CCSWITCH_DB, { readOnly: true })
try {
  console.log(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'providers'").get()?.sql)
  console.log('--- rows ---')
  console.log(
    JSON.stringify(
      db.prepare('SELECT id, app_type, name, is_current FROM providers').all(),
      null,
      1,
    ),
  )
} finally {
  db.close()
}
