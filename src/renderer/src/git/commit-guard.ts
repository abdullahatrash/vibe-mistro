/**
 * Pure seams for slice 3 (#238, PRD #233): the commit flow's guard rails — the
 * heuristic auto commit message, the default-branch predicate, and the escape-hatch
 * branch-name suggestion. All renderer-side pure functions (unit-tested DOM-free);
 * `ChangesPanel` wires them to the dialog + textarea. The heuristic deliberately lives
 * HERE, not main: the same string shows as the textarea's placeholder BEFORE the
 * commit and is substituted for a blank message at submit — what you see is exactly
 * what gets committed (no agent involvement, ADR-0002 thin-orchestrator).
 */

import type { GitBranch } from '../../../shared/ipc'

/** The verb for a view glyph: Add (A/U), Delete (D), Rename (R), else Update. */
const GLYPH_VERB: Record<string, string> = { A: 'Add', U: 'Add', D: 'Delete', R: 'Rename' }

/** Verb precedence for ties — Update first (the unsurprising default), then by weight. */
const VERB_ORDER = ['Update', 'Add', 'Delete', 'Rename']

/**
 * A deterministic commit message from the SELECTED files (the view's sorted order):
 * dominant verb + the first matching file's basename + "and N more". Empty selection →
 * empty string (the caller keeps its disabled state).
 */
export function autoCommitMessage(files: readonly { path: string; glyph: string }[]): string {
  if (files.length === 0) return ''
  const counts = new Map<string, number>()
  for (const file of files) {
    const verb = GLYPH_VERB[file.glyph] ?? 'Update'
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  let dominant = 'Update'
  let best = -1
  for (const verb of VERB_ORDER) {
    const n = counts.get(verb) ?? 0
    if (n > best) {
      dominant = verb
      best = n
    }
  }
  const headline = files.find((file) => (GLYPH_VERB[file.glyph] ?? 'Update') === dominant) ?? files[0]
  const basename = headline.path.split('/').at(-1) ?? headline.path
  const others = files.length - 1
  return others === 0 ? `${dominant} ${basename}` : `${dominant} ${basename} and ${others} more`
}

/**
 * Whether the checked-out branch is the repository's LOCAL default (#238's guard
 * predicate). Deliberately strict: an unresolved default (origin/HEAD unset — the
 * branches module then flags nothing) or a detached HEAD (`branch` null) yields false,
 * so the guard NEVER fires on uncertainty — a wrongly-shown dialog nags, a wrongly-
 * skipped one just restores today's behavior.
 */
export function isDefaultBranch(branch: string | null, branches: readonly GitBranch[]): boolean {
  if (branch === null) return false
  return branches.some((b) => b.isDefault && !b.isRemote && b.name === branch)
}

/**
 * The escape hatch's prefilled branch name (#238): the commit message slugified —
 * lowercase, runs of non-alphanumerics collapse to one dash, trimmed, capped at 40
 * chars (branch names want to stay short). An unusable message falls back to
 * `changes` so the input is never prefilled empty.
 */
export function suggestBranchName(message: string): string {
  const slug = message
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'changes'
}
