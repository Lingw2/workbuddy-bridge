/**
 * Extract all API-ish paths from a large text file.
 *
 *   node tools/wb-regex.mjs <file> <regex> [maxHits] [context]
 */
import { readFileSync } from 'node:fs'

const [file, pattern, maxHits = '200', context = '0'] = process.argv.slice(2)
const text = readFileSync(file, 'utf8')
const limit = Number(maxHits)
const ctx = Number(context)

const re = new RegExp(pattern, 'g')
let match
let hits = 0
const seen = new Set()
while ((match = re.exec(text)) !== null) {
  hits++
  const value = match[0]
  if (seen.has(value)) continue
  seen.add(value)
  console.log(ctx ? `${value}\n    ...${text.slice(Math.max(0, match.index - ctx), match.index + ctx).replace(/\s+/g, ' ')}...` : value)
  if (seen.size >= limit) break
}
console.log(`\n${hits} total matches, ${seen.size} unique`)
