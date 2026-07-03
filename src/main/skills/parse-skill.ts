/**
 * Minimal `SKILL.md` frontmatter parsing (#259) — deliberately NOT a YAML
 * dependency: the three fields the browser needs (`name`, `description`,
 * `user-invocable`) are plain scalars, and Vibe's own contract (mistral-vibe
 * `parser.py:15-39` + `SkillMetadata`) is what we mirror: the file must BEGIN
 * with a `---` fence, frontmatter runs to the next `---` line, `name` and
 * `description` are required, `user-invocable` defaults to true. A file that
 * doesn't parse is skipped by the scanner (Vibe skips it too), never a throw.
 */

export interface SkillFrontmatter {
  name: string
  description: string
  userInvocable: boolean
}

/** Vibe's skill-name shape (`SkillMetadata.name`): lowercase alnum + hyphens, 1–64. */
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Strip one layer of matching single/double quotes. */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1)
  }
  return value
}

/** Parse a `SKILL.md`'s frontmatter, or null when it isn't a loadable skill. */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const lines = content.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return null
  const closing = lines.findIndex((line, i) => i > 0 && line.trim() === '---')
  if (closing === -1) return null

  // Real-world descriptions are frequently MULTI-LINE — YAML block scalars
  // (`description: >-` + indented lines) or plain scalars continued on indented
  // lines — so each top-level key consumes its following INDENTED lines:
  // block/plain values fold them in (joined with spaces — display-fidelity is
  // all we need); an EMPTY value (a nested dict like `metadata:`) skips them.
  const fields = new Map<string, string>()
  let i = 1
  while (i < closing) {
    const line = lines[i] as string
    i += 1
    if (!line.trim() || line.trim().startsWith('#') || /^\s/.test(line)) continue
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const rawValue = line.slice(colon + 1).trim()

    const continuation: string[] = []
    while (i < closing) {
      const next = lines[i] as string
      if (next.trim() !== '' && !/^\s/.test(next)) break // next top-level key
      i += 1
      if (next.trim()) continuation.push(next.trim())
    }

    if (rawValue === '') continue // nested block (e.g. `metadata:`) — not a scalar field
    const isBlockScalar = /^[>|][+-]?$/.test(rawValue)
    const value = isBlockScalar
      ? continuation.join(' ')
      : [unquote(rawValue), ...continuation].join(' ')
    fields.set(key, value)
  }

  const name = fields.get('name') ?? ''
  const description = fields.get('description') ?? ''
  if (!NAME_PATTERN.test(name) || name.length > 64) return null
  if (!description) return null
  // Vibe's default is true; only an explicit false-y scalar turns it off.
  const invocableRaw = fields.get('user-invocable')?.toLowerCase()
  const userInvocable = !(invocableRaw === 'false' || invocableRaw === 'no' || invocableRaw === 'off')
  return { name, description, userInvocable }
}
