/**
 * A minimal, PURE `.gitignore` matcher for the Workspace file lister (#188, ADR-0013).
 * We deliberately add NO dependency for ignore parsing (the brief) — this covers the
 * common forms a real repo's ignore files use; anything beyond is documented as out of
 * scope so the security review can reason about exactly what we honor.
 *
 * SUPPORTED forms (one per line):
 *   - `# comment` and blank lines            → skipped
 *   - `name`                                 → matches a file/dir named `name` at ANY depth
 *   - `*.ext`, `pre*`, `f?o`                 → glob (`*` = any run except `/`, `?` = one non-`/`)
 *   - `dir/`                                 → trailing slash ⇒ matches DIRECTORIES only
 *   - `/anchored`, `a/b/c`                   → a `/` (other than a lone trailing one) anchors
 *                                              the pattern to the .gitignore's own directory
 *   - `**` (double-star)                     → spans path segments (leading, trailing, middle)
 *   - `!pattern`                             → negation / re-include (last match wins)
 *   - nested `.gitignore` files              → via {@link isIgnored}'s layered evaluation
 *
 * OUT OF SCOPE (documented gaps): POSIX character classes (`[a-z]`, `[!x]`); backslash
 * escaping of a literal leading `#`/`!` or trailing space; and the subtle git rule that a
 * file cannot be re-included once a PARENT directory is excluded — beyond what directory
 * PRUNING already gives us (the walker never descends an ignored directory, so a negation
 * under it is simply never reached, matching git for the pruned case).
 */

/** A compiled `.gitignore` line. Tested against a path RELATIVE to the rule's base dir. */
export interface GitignoreRule {
  /** A `!`-prefixed re-include rule. */
  negated: boolean
  /** A trailing-slash rule — matches directories only. */
  dirOnly: boolean
  /** Regex over the candidate path (anchored: whole path; else: any trailing segment). */
  regex: RegExp
}

/** One `.gitignore` in the walk, with the directory it lives in (relative to root). */
export interface GitignoreLayer {
  /** Directory containing this `.gitignore`, relative to root (`''` for the root). */
  base: string
  rules: GitignoreRule[]
}

/** Compile a `.gitignore` file's text into ordered rules (top-to-bottom preserved). */
export function compileGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const raw of content.split(/\r?\n/)) {
    const rule = compileLine(raw)
    if (rule) rules.push(rule)
  }
  return rules
}

function compileLine(raw: string): GitignoreRule | null {
  // Strip trailing whitespace (we do NOT support escaped trailing spaces — out of scope).
  let line = raw.replace(/\s+$/, '')
  if (line === '' || line.startsWith('#')) return null

  let negated = false
  if (line.startsWith('!')) {
    negated = true
    line = line.slice(1)
  }

  let dirOnly = false
  if (line.endsWith('/')) {
    dirOnly = true
    line = line.slice(0, -1)
  }
  if (line === '') return null

  // A slash anywhere (other than the trailing one we just stripped) anchors the pattern
  // to the .gitignore's directory; a leading slash anchors it too (and is dropped).
  let anchored = line.includes('/')
  if (line.startsWith('/')) {
    anchored = true
    line = line.replace(/^\/+/, '')
  }
  if (line === '') return null

  return { negated, dirOnly, regex: globToRegExp(line, anchored) }
}

function escapeRegExpChar(c: string): string {
  return /[.*+?^${}()|[\]\\]/.test(c) ? `\\${c}` : c
}

/** Convert a gitignore glob to a regex body (handles `*`, `?`, and `**`). */
function globBody(glob: string): string {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?' // `**/` — zero or more leading directories
        } else {
          out += '.*' // `**` — any run, crossing `/`
        }
      } else {
        out += '[^/]*' // `*` — any run within a single segment
      }
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += escapeRegExpChar(c)
    }
  }
  return out
}

function globToRegExp(glob: string, anchored: boolean): RegExp {
  const body = globBody(glob)
  // Anchored: the whole path (relative to base) must match. Non-anchored (no internal
  // slash): match the pattern as ANY trailing segment, i.e. at any depth.
  return anchored ? new RegExp(`^${body}$`) : new RegExp(`^(?:.*/)?${body}$`)
}

/** Whether `rule` matches `relPath` (relative to the rule's base) of the given kind. */
export function matchesRule(rule: GitignoreRule, relPath: string, isDir: boolean): boolean {
  if (rule.dirOnly && !isDir) return false
  return rule.regex.test(relPath)
}

/**
 * Decide whether `relPath` (relative to root, forward-slash) of kind `isDir` is ignored,
 * evaluating `layers` OUTERMOST→INNERMOST and each layer's rules TOP→BOTTOM so the LAST
 * match wins — a deeper `.gitignore` overrides a shallower one, and a `!negation`
 * re-includes. Each layer's rules are tested against `relPath` re-based to that layer's
 * directory. The walker hard-skips `.git` itself, so it is not represented here.
 */
export function isIgnored(layers: readonly GitignoreLayer[], relPath: string, isDir: boolean): boolean {
  let ignored = false
  for (const layer of layers) {
    // A layer's base is always an ancestor directory of the entry (walk invariant), so
    // re-basing is a plain prefix strip.
    const rebased = layer.base === '' ? relPath : relPath.slice(layer.base.length + 1)
    for (const rule of layer.rules) {
      if (matchesRule(rule, rebased, isDir)) ignored = !rule.negated
    }
  }
  return ignored
}
