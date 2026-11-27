/**
 * Search the decoded WorkBuddy app.asar text for keywords.
 *
 * The asar is 170 MB; regex with big context windows times out, so this does
 * a plain indexOf scan and prints small windows around every hit.
 *
 *   node tools/wb-grep.mjs <file> <keyword> [context] [maxHits]
 */
import { readFileSync } from 'node:fs'

const [file, keyword, context = '160', maxHits = '40'] = process.argv.slice(2)
const text = readFileSync(file, 'utf8')
const needle = keyword.toLowerCase()
const ctx = Number(context)
const limit = Number(maxHits)

let from = 0
let hits = 0
while (hits < limit) {
  const index = text.toLowerCase().indexOf(needle, from)
  if (index === -1) break
  from = index + 1
  hits++
  const start = Math.max(0, index - ctx)
  const end = Math.min(text.length, index + needle.length + ctx)
  console.log(`\n===== hit ${hits} @ ${index} =====`)
  console.log(text.slice(start, end).replace(/\s+/g, ' '))
}
console.log(`\n${hits} hits for "${keyword}"`)
