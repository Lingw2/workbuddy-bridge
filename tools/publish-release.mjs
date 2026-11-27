/**
 * Create a GitHub release through the REST API.
 *
 * `github.com` is unreachable from some networks, so this uses
 * `api.github.com` directly instead of the `gh` CLI.
 *
 *   node tools/publish-release.mjs <tag> <name> <notes-file>
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const [tag, name, notesFile] = process.argv.slice(2)
if (!tag || !name || !notesFile) {
  console.error('usage: node tools/publish-release.mjs <tag> <name> <notes-file>')
  process.exit(1)
}

const raw = execFileSync('git', ['credential', 'fill'], {
  input: `protocol=https\nhost=github.com\n\n`,
  encoding: 'utf8',
})
const token = raw.split('\n').find((line) => line.startsWith('password=')).slice('password='.length).trim()

const body = readFileSync(notesFile, 'utf8').replace(/\r\n/g, '\n')

const response = await fetch('https://api.github.com/repos/Lingw2/workbuddy-bridge/releases', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'workbuddy-bridge',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    tag_name: tag,
    name,
    body,
    draft: false,
    prerelease: false,
    target_commitish: 'main',
  }),
})

const text = await response.text()
if (!response.ok) {
  console.error(`create failed: ${response.status} ${text.slice(0, 600)}`)
  process.exit(1)
}

const release = JSON.parse(text)
console.log(`release ${release.id} ${release.tag_name}`)
console.log(release.html_url)
writeFileSync(path.join('.release-id'), String(release.id))
