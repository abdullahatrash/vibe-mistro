/**
 * `@` file-path autocomplete logic (#190, ADR-0013 decision 5): the pure core of the
 * composer's path popover. It mirrors the `/` slash-command core (command-autocomplete.ts)
 * — trigger detection, filtering, the insertion transform, and selection wrapping — but
 * over the shared `files:list` listing (FileEntry[]) rather than the Vibe-streamed
 * commands, and with the Vibe CLI PathCompleter's semantics.
 *
 * The KEY difference from `/`: this trigger is NOT start-anchored. `@` fires MID-SENTENCE
 * — the active fragment is whatever follows the LAST `@` before the caret, as long as it
 * is space-free (whitespace after the `@` closes the token, matching the CLI). This lets a
 * user drop a `@path` reference anywhere in a prompt.
 *
 * Accepting inserts PLAIN TEXT `@<path>` with NO client-side expansion (ADR-0002): a FILE
 * gets a trailing space (`@path `, token closed, caret past it); a DIRECTORY gets a
 * trailing slash (`@dir/`). The agent resolves the literal `@path` itself server-side
 * (render_path_prompt).
 *
 * Deliberately DOM-free and side-effect-free so it unit-tests as plain data
 * (path-autocomplete.test.ts) while `Conversation.tsx` keeps the thin JSX + keyboard
 * wiring. `moveSelection` is shared with the `/` core (identical wrapping), re-exported here.
 */

import type { FileEntry } from '../../../shared/ipc'

export { moveSelection } from './command-autocomplete'

/**
 * The result of probing the composer value + caret for an active `@` trigger. `active`
 * gates the popover; `query` is the fragment after the `@` up to the caret (lower-cased
 * matching happens in `filterPaths`); `start` is the index of the `@` so `applyPath` knows
 * where the token begins.
 */
export interface PathTrigger {
  active: boolean
  query: string
  start: number
}

/** An inactive probe result — the single shape returned when no trigger qualifies. */
const NO_TRIGGER: PathTrigger = { active: false, query: '', start: -1 }

/** Whitespace closes an `@`-token: a caret past one of these is no longer inside it. */
const TOKEN_WHITESPACE = /\s/

/** The popup is capped so it stays fast + scannable over a ~20k-entry listing. */
export const MAX_PATH_RESULTS = 10

/**
 * Detect an `@`-path trigger at the caret. Unlike the `/` core this is NOT start-anchored:
 * the token opens at the LAST `@` before the caret (`@` allowed mid-sentence), and is
 * active only while the fragment from that `@` up to the caret contains no whitespace (the
 * token is still open). Returns the query (text after the `@`, up to the caret) and the
 * `@`'s index on a hit.
 *
 * `caret` is clamped defensively — a caller may hand us a DOM `selectionStart` that a
 * controlled re-render has momentarily desynced from `value`.
 */
export function getPathQuery(value: string, caret: number): PathTrigger {
  const pos = Math.max(0, Math.min(caret, value.length))
  // The last `@` strictly before the caret opens the token; a caret resting ON the `@`
  // (pos <= at) isn't inside it yet, so no trigger.
  const at = value.lastIndexOf('@', pos - 1)
  if (at < 0 || pos <= at) return NO_TRIGGER
  const query = value.slice(at + 1, pos)
  // Whitespace anywhere between the `@` and the caret closes the token (e.g. `@src foo`
  // with the caret past the space), so the popover must not show.
  if (TOKEN_WHITESPACE.test(query)) return NO_TRIGGER
  return { active: true, query, start: at }
}

/** True when every char of `needle` appears in `hay` in order (fuzzy subsequence match). */
function isSubsequence(needle: string, hay: string): boolean {
  let i = 0
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++
  }
  return i === needle.length
}

/**
 * Rank listing entries against a query over their relative paths, case-insensitively:
 * substring matches first (in listing order), then the remaining subsequence (fuzzy)
 * matches (also in listing order), capped at {@link MAX_PATH_RESULTS}. Directories are
 * included (the caller shows a dir/file icon and `applyPath` slash-vs-space keys off
 * `kind`). An empty query keeps the listing head (every path contains ''), so the popover
 * opens showing the first entries right after a bare `@`.
 */
export function filterPaths(entries: readonly FileEntry[], query: string): FileEntry[] {
  const needle = query.toLowerCase()
  const substring: FileEntry[] = []
  const subsequence: FileEntry[] = []
  for (const entry of entries) {
    const hay = entry.path.toLowerCase()
    if (hay.includes(needle)) substring.push(entry)
    else if (isSubsequence(needle, hay)) subsequence.push(entry)
  }
  return [...substring, ...subsequence].slice(0, MAX_PATH_RESULTS)
}

/** The value + caret produced by accepting a completion, applied to the composer. */
export interface PathInsertion {
  value: string
  caret: number
}

/**
 * Replace the `@query` token (from `start` up to `caret`) with the plain-text `@<path>`
 * plus a trailing separator: a SPACE for a file (`@path `, token closed, caret past it) or
 * a SLASH for a directory (`@dir/`, no space, so re-deriving continues into the dir). Text
 * after the caret is kept, so accepting mid-sentence splices the reference in without
 * eating what follows.
 *
 * KNOWN LIMITATION (matches the Vibe CLI PathCompleter; plain-text design, ADR-0002): a
 * path containing a SPACE inserts as `@my file.ts ` — a token the space-free trigger can't
 * re-derive, and which the agent likely reads only up to the space. We neither quote nor
 * drop such paths (quoting is unverified against the agent's `render_path_prompt`; dropping
 * would silently hide real files) — spaced paths are simply not usefully referenceable here.
 */
export function applyPath(
  value: string,
  start: number,
  caret: number,
  entry: FileEntry,
): PathInsertion {
  const suffix = entry.kind === 'directory' ? '/' : ' '
  const insert = `@${entry.path}${suffix}`
  const nextValue = value.slice(0, start) + insert + value.slice(caret)
  return { value: nextValue, caret: start + insert.length }
}
