/**
 * Upload the repository through the GitHub REST API.
 *
 * `github.com` itself is unreachable from some networks while
 * `api.github.com` is, so this pushes with the Git Data API instead of
 * `git push`.
 *
 *   node tools/push-via-api.mjs [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const OWNER = process.env.GH_OWNER ?? 'Lingw2'
const REPO = process.env.GH_REPO ?? 'workbuddy-bridge'
const DRY_RUN = process.argv.includes('--dry-run')

function githubToken() {
  const raw = execFileSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=github.com\n\n`,
    encoding: 'utf8',
  })
  const match = raw.split('\n').find((line) => line.startsWith('password='))
  if (!match) throw new Error('no GitHub credential found in the git credential store')
  return match.slice('password='.length).trim()
}

const TOKEN = githubToken()
const API = `https://api.github.com/repos/${OWNER}/${REPO}`

async function api(endpoint, { method = 'GET', body } = {}) {
  const response = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'workbuddy-bridge',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text ? JSON.parse(text) : null
  } catch {
    payload = text
  }
  if (!response.ok) {
    throw new Error(`${method} ${endpoint} -> ${response.status}: ${text.slice(0, 400)}`)
  }
  return payload
}

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\n').map((line) => line.trim()).filter(Boolean)
}

const files = trackedFiles()
console.log(`${files.length} tracked files`)

if (DRY_RUN) {
  for (const file of files) console.log(' -', file)
  process.exit(0)
}

const baseTree = await api('/git/trees/main?recursive=1').catch(() => null)
const existing = new Map()
if (baseTree?.tree) {
  for (const entry of baseTree.tree) {
    if (entry.type === 'blob') existing.set(entry.path, entry.sha)
  }
}
console.log(`remote currently holds ${existing.size} blobs`)

const tree = []
for (const file of files) {
  const absolute = path.join(ROOT, file)
  if (!existsSync(absolute)) continue
  const content = readFileSync(absolute)
  const blob = await api('/git/blobs', {
    method: 'POST',
    body: { content: content.toString('base64'), encoding: 'base64' },
  })
  const changed = existing.get(file) !== blob.sha
  tree.push({ path: file, mode: '100644', type: 'blob', sha: blob.sha })
  console.log(`${changed ? 'changed' : 'same   '}  ${file}`)
}

const created = await api('/git/trees', {
  method: 'POST',
  body: { base_tree: 'main', tree },
})

const commit = await api('/git/commits', {
  method: 'POST',
  body: {
    message: 'chore: publish via the GitHub API',
    tree: created.sha,
    parents: [baseTree?.sha ?? (await api('/git/ref/heads/main')).object.sha],
  },
})

await api('/git/refs/heads/main', { method: 'PATCH', body: { sha: commit.sha, force: false } })
console.log(`pushed ${commit.sha} -> ${OWNER}/${REPO}@main`)
