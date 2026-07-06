/**
 * Pure item-derivation for the ONE virtualized Review viewer (#388, PRD #387). The
 * two Review scopes (working-tree `AllFilesDiffView`, branch-range `BranchDiffView`)
 * both feed every changed file to a single `@pierre/diffs` `CodeView` as controlled
 * items. This module owns the DOM-free half of that: which files become items, each
 * item's stable id (its path), and its per-item VERSION HASH — an FNV-1a fold over the
 * bits that must force a single item to re-render (patch content via `diffHash`,
 * collapse state, an open review-comment draft, per-file truncation, and the
 * working-tree header's status glyph + churn). Display prefs (Stacked/Split, Wrap) are
 * viewer-level OPTIONS, not item state, so they are deliberately absent — flipping them
 * must relayout without re-versioning items (PRD #387: toggles are not remounts).
 *
 * Kept free of `@pierre/diffs`/DOM imports so it is unit-tested in the node env; the
 * viewer component pairs each model with its parsed `FileDiffMetadata` and renders.
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193

/** FNV-1a 32-bit over `input` — a fast, stable, non-cryptographic content fold. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS_32 >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0
  }
  return hash >>> 0
}

/**
 * A parse cache key for `parsePatchFiles(patch, key)` — the length plus an FNV fold, so
 * two identical patches share worker-highlight cache entries and a changed patch never
 * collides with the old parse. `scope` namespaces callers that reuse the same content.
 */
export function buildPatchCacheKey(patch: string, scope = 'review-diff'): string {
  return `${scope}:${patch.length}:${fnv1a32(patch).toString(36)}`
}

/** The working-tree header extras (status glyph + churn) — absent for a branch range. */
export interface ReviewDiffFileMeta {
  glyph: string
  insertions: number
  deletions: number
}

/** One file's diff payload as it arrives from `gitFullDiff` / `gitRangeDiff`. */
export interface ReviewDiffFileInput {
  path: string
  diffHash: string
  truncated: boolean
}

/** The derived per-item model the viewer merges with its parsed `FileDiffMetadata`. */
export interface ReviewDiffItemModel {
  /** Stable item id — the file's path (`data-diff-path` parity with the old sections). */
  id: string
  path: string
  diffHash: string
  truncated: boolean
  collapsed: boolean
  /** True when the open review-comment draft anchors to this file — re-renders only it. */
  hasDraft: boolean
  meta: ReviewDiffFileMeta | undefined
  /** FNV fold of everything that must force THIS item (and only it) to re-render. */
  version: number
}

/** Inputs that steer derivation but don't belong to a single file. */
export interface ReviewDiffItemContext {
  /** Paths whose section is collapsed (body hidden). */
  collapsed: ReadonlySet<string>
  /** Working-tree status extras by path; omitted for the branch range. */
  metaByPath?: ReadonlyMap<string, ReviewDiffFileMeta>
  /** The path of the file with an open review-comment draft, if any. */
  draftPath?: string | null
}

/** The version fold for one item — exported so tests pin the exact re-render triggers. */
export function reviewDiffItemVersion(input: {
  diffHash: string
  collapsed: boolean
  truncated: boolean
  hasDraft: boolean
  meta: ReviewDiffFileMeta | undefined
}): number {
  const meta = input.meta ? `${input.meta.glyph}:${input.meta.insertions}:${input.meta.deletions}` : ''
  return fnv1a32(
    `${input.collapsed ? '1' : '0'}:${input.truncated ? '1' : '0'}:${input.hasDraft ? '1' : '0'}:${input.diffHash}:${meta}`,
  )
}

/**
 * Derive the ordered per-item models from the scope's file entries. Order is preserved
 * verbatim (the caller sorts to the changed-files list / range order); an item is minted
 * for every entry, and the viewer skips those whose patch didn't parse.
 */
export function buildReviewDiffItemModels(
  files: readonly ReviewDiffFileInput[],
  context: ReviewDiffItemContext,
): ReviewDiffItemModel[] {
  return files.map((file) => {
    const collapsed = context.collapsed.has(file.path)
    const hasDraft = context.draftPath === file.path
    const meta = context.metaByPath?.get(file.path)
    return {
      id: file.path,
      path: file.path,
      diffHash: file.diffHash,
      truncated: file.truncated,
      collapsed,
      hasDraft,
      meta,
      version: reviewDiffItemVersion({
        diffHash: file.diffHash,
        collapsed,
        truncated: file.truncated,
        hasDraft,
        meta,
      }),
    }
  })
}
