/**
 * Upload a release asset through the GitHub REST API.
 *
 * `github.com` is unreachable from some networks, so this uses
 * `uploads.github.com` directly instead of the `gh` CLI.
 *
 *   node tools/upload-release.mjs <release-id> <file> [asset-name]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const [releaseId, file, name] = process.argv.slice(2)
if (!releaseId || !file) {
  console.error('usage: node tools/upload-release.mjs <release-id> <file> [asset-name]')
  process.exit(1)
}

const raw = execFileSync('git', ['credential', 'fill'], {
  input: `protocol=https\nhost=github.com\n\n`,
  encoding: 'utf8',
})
const token = raw.split('\n').find((line) => line.startsWith('password=')).slice('password='.length).trim()

const assetName = name ?? path.basename(file)
const body = readFileSync(file)
const size = statSync(file).size

console.log(`uploading ${assetName} (${size} bytes)`)

const response = await fetch(
  `https://uploads.github.com/repos/Lingw2/workbuddy-bridge/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`,
  {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workbuddy-bridge',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body,
  },
)

const text = await response.text()
if (!response.ok) {
  console.error(`upload failed: ${response.status} ${text.slice(0, 500)}`)
  process.exit(1)
}

const asset = JSON.parse(text)
console.log(`uploaded: ${asset.name}  ${asset.size} bytes`)
console.log(`download: ${asset.browser_download_url}`)
