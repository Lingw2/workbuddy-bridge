/**
 * Install the bridge into Codex.
 *
 * Codex reads `~/.codex/config.toml`. This writes a `[model_providers.workbuddy]`
 * table and points the top-level `model_provider` at it, leaving every other
 * provider alone. It also refreshes the model catalogue Codex shows in its
 * picker, because Codex resolves a slug through that file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'

import { CODEX_CONFIG, CODEX_MODEL_CATALOG } from './paths.js'
import { getTopLevel, setTopLevel, setTable, removeTable } from './toml.js'

const PROVIDER_NAME = 'workbuddy'

/** Codex only understands these reasoning effort names. */
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const EFFORT_DESCRIPTIONS = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balanced reasoning depth for everyday work',
  high: 'Greater reasoning depth for complex problems',
  xhigh: 'Very deep reasoning for hard problems',
  max: 'Maximum reasoning depth for the hardest problems',
}

/**
 * A Codex model catalogue entry for one WorkBuddy model.
 *
 * The entry is cloned from an entry that is already in the catalogue, because
 * Codex expects the full shape (base instructions, tool flags and so on) and a
 * hand-written entry tends to miss one of them.
 *
 * @param {object} model the WorkBuddy model
 * @param {number} index
 * @param {object} [template] an existing catalogue entry to clone
 */
function catalogEntry(model, index, template) {
  const efforts = (model.reasoningEfforts ?? []).filter((effort) =>
    CODEX_EFFORTS.includes(effort),
  )
  const levels = efforts.length > 0 ? efforts : ['high']
  const contextWindow = model.contextWindow || 200_000

  const entry = template
    ? JSON.parse(JSON.stringify(template))
    : {
        base_instructions: '',
        instructions_template: '',
        instructions_variables: {},
        shell_type: 'unified_exec',
        supports_parallel_tool_calls: true,
        supports_reasoning_summaries: true,
        supports_search_tool: false,
        truncation_policy: { limit: 10_000, mode: 'tokens' },
        visibility: 'list',
        web_search_tool_type: 'text_and_image',
        apply_patch_tool_type: 'freeform',
        experimental_supported_tools: [],
        service_tiers: [],
        include_plugin_usage_instructions: true,
        include_skills_usage_instructions: true,
      }

  entry.slug = model.id
  entry.display_name = model.name || model.id
  entry.description = model.description || `WorkBuddy model ${model.id}`
  entry.context_window = contextWindow
  entry.max_context_window = contextWindow
  entry.effective_context_window_percent = 95
  entry.default_reasoning_level = levels.includes('high') ? 'high' : levels[0]
  entry.default_reasoning_summary = 'none'
  entry.default_verbosity = 'low'
  entry.input_modalities = model.supportsImages ? ['text', 'image'] : ['text']
  entry.priority = 1000 - index
  entry.supported_reasoning_levels = levels.map((effort) => ({
    effort,
    description: EFFORT_DESCRIPTIONS[effort] ?? `Reasoning effort: ${effort}`,
  }))

  return entry
}

/**
 * Write the Codex model catalogue.
 *
 * The file may already hold entries for other providers, so existing entries
 * are kept and only ours are replaced.
 *
 * @param {object[]} models
 */
export function writeCodexModelCatalog(models) {
  let existing = []
  if (existsSync(CODEX_MODEL_CATALOG)) {
    try {
      const parsed = JSON.parse(readFileSync(CODEX_MODEL_CATALOG, 'utf8'))
      existing = Array.isArray(parsed) ? parsed : (parsed.models ?? [])
    } catch {
      existing = []
    }
  }

  // Clone the shape of an entry Codex already understands.
  const template = existing[0]

  // Drop the entries we are about to publish, keep everything else. Our own
  // entries are recognised by the `service/model` shape of their slug.
  const ids = new Set(models.map((model) => model.id))
  const kept = existing.filter((entry) => {
    const slug = String(entry.slug ?? '')
    if (ids.has(slug)) return false
    if (slug.startsWith('workbuddy:')) return false
    if (slug.includes('/')) return false
    return true
  })
  const added = models.map((model, index) => catalogEntry(model, index, template))
  const merged = [...added, ...kept]

  mkdirSync(join(CODEX_MODEL_CATALOG, '..'), { recursive: true })
  writeFileSync(CODEX_MODEL_CATALOG, `${JSON.stringify({ models: merged }, null, 2)}\n`)
  return merged.length
}

/**
 * Write the Codex provider into `config.toml`.
 *
 * @param {object} config
 * @param {object[]} models
 * @returns {{configPath: string, backup: string|null}}
 */
export function installCodex(config, models = []) {
  const backup = backupFile(CODEX_CONFIG)
  let text = existsSync(CODEX_CONFIG) ? readFileSync(CODEX_CONFIG, 'utf8') : ''

  const baseUrl = `http://127.0.0.1:${config.codex.port}/v1`
  text = setTopLevel(text, 'model_provider', PROVIDER_NAME)
  text = setTopLevel(text, 'model', config.codex.model)
  if (config.codex.reasoningEffort) {
    text = setTopLevel(text, 'model_reasoning_effort', config.codex.reasoningEffort)
  }

  text = setTable(text, `model_providers.${PROVIDER_NAME}`, [
    `name = "workbuddy"`,
    `base_url = "${baseUrl}"`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    `experimental_bearer_token = "${config.codex.token}"`,
  ])

  writeFileSync(CODEX_CONFIG, text)

  if (models.length > 0) {
    backupFile(CODEX_MODEL_CATALOG)
    writeCodexModelCatalog(models)
  }

  return { configPath: CODEX_CONFIG, backup }
}

/** Remove the WorkBuddy provider from `config.toml`. */
export function uninstallCodex() {
  if (!existsSync(CODEX_CONFIG)) return false
  const backup = backupFile(CODEX_CONFIG)
  const text = readFileSync(CODEX_CONFIG, 'utf8')
  writeFileSync(CODEX_CONFIG, removeTable(text, `model_providers.${PROVIDER_NAME}`))
  return Boolean(backup)
}

/** Read back what Codex currently points at. */
export function readCodexState() {
  if (!existsSync(CODEX_CONFIG)) return null
  const text = readFileSync(CODEX_CONFIG, 'utf8')
  const provider = getTopLevel(text, 'model_provider')
  const model = getTopLevel(text, 'model')
  const baseUrl = readProviderBaseUrl(text, PROVIDER_NAME)
  return { provider, model, baseUrl, installed: provider === PROVIDER_NAME }
}

/**
 * The `base_url` of one provider table.
 *
 * The file can hold several providers, so the table has to be matched by name
 * instead of taking the first one that appears.
 */
function readProviderBaseUrl(text, provider) {
  const lines = text.split(/\r?\n/)
  let inTable = false
  for (const line of lines) {
    const header = /^\s*\[model_providers\.([^\]]+)\]\s*$/.exec(line)
    if (header) {
      inTable = header[1] === provider
      continue
    }
    if (/^\s*\[/.test(line)) {
      inTable = false
      continue
    }
    if (inTable) {
      const match = /^\s*base_url\s*=\s*"([^"]+)"/.exec(line)
      if (match) return match[1]
    }
  }
  return null
}

/** Copy a file aside before it is overwritten. */
export function backupFile(path) {
  if (!existsSync(path)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = `${path}.bak-workbuddy-${stamp}`
  copyFileSync(path, target)
  return target
}
