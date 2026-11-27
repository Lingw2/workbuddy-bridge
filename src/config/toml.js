/**
 * A very small TOML reader/writer for the Codex config file.
 *
 * Codex's `config.toml` is hand-edited by users and by other tools, so this
 * module never rewrites the file from a parsed model. It edits the text in
 * place: top-level keys are set in the leading block, and named tables are
 * created or replaced as whole blocks. Everything else is left byte-for-byte
 * alone.
 */

/** Split a TOML document into its top-level block and its tables. */
export function parseToml(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const tables = new Map()
  let current = null
  let prelude = []

  for (const line of lines) {
    const match = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (match) {
      current = match[1]
      if (!tables.has(current)) tables.set(current, [])
      continue
    }
    if (current === null) prelude.push(line)
    else tables.get(current).push(line)
  }

  return { prelude, tables }
}

/** Read a top-level scalar value. */
export function getTopLevel(text, key) {
  const { prelude } = parseToml(text)
  for (const line of prelude) {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`).exec(line)
    if (match) return match[1].replace(/^["']|["']$/g, '')
  }
  return undefined
}

/** Set a top-level scalar, replacing the existing line when present. */
export function setTopLevel(text, key, value) {
  const { prelude, tables } = parseToml(text)
  const rendered = `${key} = ${formatValue(value)}`
  const index = prelude.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line))

  if (index === -1) {
    // Insert after the last leading comment or blank line, before any table.
    let insertAt = 0
    for (let i = 0; i < prelude.length; i += 1) {
      const line = prelude[i].trim()
      if (line === '' || line.startsWith('#')) insertAt = i + 1
    }
    prelude.splice(insertAt, 0, rendered)
  } else {
    prelude[index] = rendered
  }

  const body = tablesToText(prelude, tables)
  return body
}

/** Replace or create a named table. */
export function setTable(text, name, lines) {
  const { prelude, tables } = parseToml(text)
  tables.set(name, lines)
  return tablesToText(prelude, tables)
}

/** Remove a named table. */
export function removeTable(text, name) {
  const { prelude, tables } = parseToml(text)
  tables.delete(name)
  return tablesToText(prelude, tables)
}

/** Render a TOML value. */
export function formatValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Rebuild the document from its parts. */
function tablesToText(prelude, tables) {
  const parts = []
  const head = prelude.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()
  if (head.length > 0) parts.push(head)

  for (const [name, lines] of tables) {
    const body = lines.join('\n').trimEnd()
    parts.push(`[${name}]\n${body.length > 0 ? `${body}\n` : ''}`)
  }

  return `${parts.join('\n\n')}\n`
}
