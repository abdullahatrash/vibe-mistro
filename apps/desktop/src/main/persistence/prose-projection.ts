import type { DatabaseSync } from 'node:sqlite'
import type { TranscriptEntry } from '../../shared/ipc'
import { extractProse } from '../search/transcript-prose'

/**
 * The prose write-path projection (ADR-0019, #296): fold a transcript entry's
 * searchable prose into `prose_items` as the entry lands, one row per
 * CONVERSATION ITEM — a user prompt is one row; an agent message's streamed
 * chunks UPSERT-CONCATENATE onto their item's row (keyed by the reducer item id
 * `assistant:<messageId>`), one row per message regardless of chunk count. A
 * chunk with no derivable item id gets its own un-jumpable row (item_id NULL).
 *
 * What counts as prose — user prompts + agent message chunks, never reasoning
 * or tool payloads — is `extractProse`'s decision (#174), unchanged.
 *
 * The FTS index over these rows is maintained by triggers (see migration 3),
 * so this module only touches `prose_items`. Callers run it INSIDE the same
 * transaction as the entry insert — the projection can never drift from the log.
 */

export function projectEntryProse(
  db: DatabaseSync,
  threadId: string,
  seq: number | bigint,
  entry: TranscriptEntry,
): void {
  const prose = extractProse(entry)
  if (!prose) return

  if (prose.itemId !== null) {
    const existing = db
      .prepare('SELECT rowid FROM prose_items WHERE thread_id = ? AND item_id = ?')
      .get(threadId, prose.itemId) as { rowid: number } | undefined
    if (existing) {
      db.prepare('UPDATE prose_items SET text = text || ? WHERE rowid = ?').run(
        prose.text,
        existing.rowid,
      )
      return
    }
  }
  db.prepare(
    'INSERT INTO prose_items (thread_id, item_id, first_seq, text) VALUES (?, ?, ?, ?)',
  ).run(threadId, prose.itemId, seq, prose.text)
}
