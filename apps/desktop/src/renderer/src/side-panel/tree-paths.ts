import type { FileEntry } from '../../../shared/ipc'

/**
 * Pure mapping between the `files:list` entries and `@pierre/trees` (#188, ADR-0013). The
 * tree consumes a flat array of string paths where a DIRECTORY carries a trailing `/`
 * (t3code's `FileBrowserPanel` convention), so these helpers do the suffixing and the
 * inverse (a selected tree id → the relative file path to open). Kept DOM-free so the
 * load-bearing mapping is unit-tested without rendering the widget (which we don't test).
 */

/** Map listing entries to tree paths: a directory gets a trailing `/`, a file does not. */
export function toTreePaths(entries: readonly FileEntry[]): string[] {
  return entries.map((entry) => (entry.kind === 'directory' ? `${entry.path}/` : entry.path))
}

/** Index entries by relative path → kind, for resolving a selection back to a file. */
export function indexEntryKinds(entries: readonly FileEntry[]): Map<string, FileEntry['kind']> {
  return new Map(entries.map((entry) => [entry.path, entry.kind]))
}

/**
 * Resolve a tree selection to the relative path of a FILE to open, or `null` when the
 * selection is a directory / unknown / empty. `@pierre/trees` reports a directory id with
 * the trailing `/` we added in {@link toTreePaths}, so it is stripped before the kind
 * lookup. Only the LAST selected path matters (single-open intent).
 */
export function selectedFilePath(
  selectedPaths: readonly string[],
  kinds: ReadonlyMap<string, FileEntry['kind']>,
): string | null {
  const last = selectedPaths.at(-1)
  if (last === undefined) return null
  const path = last.replace(/\/$/, '')
  return kinds.get(path) === 'file' ? path : null
}
