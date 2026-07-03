import type { DatabaseSync } from 'node:sqlite'
import type { ProseEntry } from './transcript-prose'

/**
 * The FTS-backed prose feeder (#296): replace the read-every-transcript scan
 * with one indexed query, keeping `searchThreads` — the pinned ranking brain —
 * untouched. The MATCH is an OR of PREFIX tokens (`"fix"* OR "bug"*`), i.e.
 * every item containing ANY query token, because `searchThreads` implements
 * BOTH match modes over what it's fed: "strong" (all tokens in one item — it
 * re-checks with its own folded-substring test, which every FTS prefix hit
 * passes) and "scattered" (tokens spread across title/Workspace/items). An
 * AND query would starve the scattered mode.
 *
 * Semantics delta vs the scan (accepted in #296): FTS matches word PREFIXES
 * (unicode61, diacritics folded like `foldSearchText`), so a token matching
 * only the MIDDLE of a word (`gent` → "agent") no longer hits prose. Titles
 * and Workspace names keep full substring matching in `searchThreads`.
 *
 * Rows return per Thread in `first_seq` order — replay order — so "the FIRST
 * strong entry seeds the snippet" behaves exactly as the scan did. `index` is
 * the entry's position in the Thread's replayed array (what jump-to-message
 * scrolls by), computed from the log; `itemId` rides straight from the row.
 */
export function ftsProseByThread(
  db: DatabaseSync,
  tokens: readonly string[],
): Map<string, ProseEntry[]> {
  const prose = new Map<string, ProseEntry[]>()
  if (tokens.length === 0) return prose

  const match = tokens.map((token) => `"${token.replaceAll('"', '""')}"*`).join(' OR ')
  let rows: { thread_id: string; item_id: string | null; text: string; entry_index: number }[]
  try {
    rows = db
      .prepare(
        `SELECT p.thread_id, p.item_id, p.text,
                (SELECT COUNT(*) FROM transcript_entries te
                  WHERE te.thread_id = p.thread_id AND te.seq < p.first_seq) AS entry_index
           FROM prose_fts
           JOIN prose_items p ON p.rowid = prose_fts.rowid
          WHERE prose_fts MATCH ?
          ORDER BY p.thread_id, p.first_seq`,
      )
      .all(match) as unknown as typeof rows
  } catch (err) {
    // A malformed MATCH (defensive — tokens are quoted) or a missing index
    // degrades to title-only search, never a failed query (best-effort).
    console.error('[fts-prose] MATCH failed — degrading to title-only search:', err)
    return prose
  }

  for (const row of rows) {
    let list = prose.get(row.thread_id)
    if (!list) {
      list = []
      prose.set(row.thread_id, list)
    }
    list.push({ index: row.entry_index, itemId: row.item_id, text: row.text })
  }
  return prose
}
