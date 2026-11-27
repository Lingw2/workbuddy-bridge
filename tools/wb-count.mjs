/**
 * Count keyword occurrences in a large text file.
 *
 *   node tools/wb-count.mjs <file> <keyword> [keyword...]
 */
import { readFileSync } from 'node:fs'

const [file, ...keywords] = process.argv.slice(2)
const text = readFileSync(file, 'utf8')
const lower = text.toLowerCase()

for (const keyword of keywords) {
  const needle = keyword.toLowerCase()
  let count = 0
  let from = 0
  while (true) {
    const index = lower.indexOf(needle, from)
    if (index === -1) break
    count++
    from = index + 1
  }
  console.log(`${count.toString().padStart(6)}  ${keyword}`)
}
