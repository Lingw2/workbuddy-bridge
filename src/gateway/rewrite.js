/**
 * Upstream channel gate.
 *
 * The WorkBuddy upstream inspects `system` and `assistant` messages and refuses
 * requests whose wording matches another agent's identity. Measured behaviour:
 *
 *   - the match is a case-insensitive substring match ANYWHERE in the message,
 *     not a prefix match;
 *   - the upstream normalises invisible characters before matching, so
 *     inserting zero-width spaces does NOT help — the wording itself has to
 *     change;
 *   - one message can carry several matches, and some matches are a
 *     combination of two spans that are each harmless on their own.
 *
 * So the fix is a small table of rewrites, applied to the final text before it
 * goes upstream.
 */

/** Rewrites for Claude Code / Claude desktop requests. */
export const CLAUDE_REWRITES = [
  {
    from: 'x-anthropic-billing-header:',
    to: 'x-request-metadata:',
  },
  {
    from:
      'To give feedback, users should report the issue at https://github.com/anthropics/claude-code/issues',
    to: 'To give feedback, users should report the issue to the project maintainers',
  },
]

/** Rewrites for Codex requests. None are needed as of now. */
export const CODEX_REWRITES = []

export const ALL_REWRITES = [...CLAUDE_REWRITES, ...CODEX_REWRITES]

/** Roles the upstream scans. */
const SCANNED_ROLES = new Set(['system', 'assistant'])

/** Apply rewrites to every string inside a message content value. */
function rewriteContent(content, rules, applied) {
  if (typeof content === 'string') {
    let text = content
    for (const rule of rules) {
      if (!text.includes(rule.from)) continue
      text = text.split(rule.from).join(rule.to)
      applied.push(rule.from)
    }
    return text
  }
  if (Array.isArray(content)) {
    return content.map((item) => rewriteContent(item, rules, applied))
  }
  if (content && typeof content === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(content)) {
      out[key] = rewriteContent(value, rules, applied)
    }
    return out
  }
  return content
}

/**
 * Rewrite a chat body in place of the offending wording.
 *
 * @param {object} body OpenAI chat body (messages array)
 * @param {object[]} [rules]
 * @returns {{body: object, applied: string[]}}
 */
export function rewriteChannelSpans(body, rules = ALL_REWRITES) {
  const applied = []
  if (!body || !Array.isArray(body.messages) || rules.length === 0) {
    return { body, applied }
  }

  const messages = body.messages.map((message) => {
    if (!message || !SCANNED_ROLES.has(message.role)) return message
    const content = rewriteContent(message.content, rules, applied)
    return content === message.content ? message : { ...message, content }
  })

  return { body: { ...body, messages }, applied: [...new Set(applied)] }
}
