import type { TranscriptEntry } from '../../shared/ipc'
import { isTranscriptEntry } from './transcript'
import type { TranscriptStoreApi } from './transcript-store-api'
import type { StateDb } from './sqlite-db'

/**
 * The per-Thread transcript on SQLite (ADR-0019): the `transcript_entries`
 * event log — the source of truth the read projections (FTS prose, fold
 * snapshots; later slices) derive from. A drop-in behind `TranscriptStoreApi`.
 *
 * ORDERING: appends are synchronous single-row inserts in call order, and the
 * global `seq` AUTOINCREMENT is the total order — the legacy store's per-Thread
 * serialized promise chain (which existed to keep fire-and-forget `appendFile`s
 * from racing) has no SQLite equivalent to need.
 *
 * BEST-EFFORT (ADR-0005, unchanged): an append into a locked db, for a Thread
 * whose metadata row is gone (the FK rejects it — e.g. a tee racing a delete,
 * behind the bridge's tombstone guard), or hitting any SQLite error is logged
 * and swallowed — a transcript write failure must never break the live turn.
 *
 * The version-header machinery of the JSONL format has no row equivalent: the
 * schema version of every entry is the database's `user_version` (ADR-0019).
 */

export interface SqliteTranscriptStoreDeps {
  stateDb: StateDb
  now?: () => number
}

export class SqliteTranscriptStore implements TranscriptStoreApi {
  private readonly stateDb: StateDb
  private readonly now: () => number

  constructor(deps: SqliteTranscriptStoreDeps) {
    this.stateDb = deps.stateDb
    this.now = deps.now ?? Date.now
  }

  private get db() {
    return this.stateDb.db
  }

  async append(threadId: string, entry: TranscriptEntry): Promise<void> {
    if (this.stateDb.locked) return
    try {
      this.db
        .prepare('INSERT INTO transcript_entries (thread_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(threadId, entry.t, JSON.stringify(entry), this.now())
    } catch (err) {
      // Non-fatal by design — the conversation proceeds; the entry is lost.
      console.error(`[SqliteTranscriptStore] append failed for Thread ${threadId}:`, err)
    }
  }

  async read(threadId: string): Promise<TranscriptEntry[]> {
    if (this.stateDb.locked) return []
    const rows = this.db
      .prepare('SELECT payload FROM transcript_entries WHERE thread_id = ? ORDER BY seq')
      .all(threadId) as unknown as { payload: string }[]
    const entries: TranscriptEntry[] = []
    for (const row of rows) {
      // Guard each row like a JSONL line (parseTranscript's tolerance): a
      // garbled payload is skipped, never fatal — the valid rest still replays.
      let parsed: unknown
      try {
        parsed = JSON.parse(row.payload)
      } catch {
        continue
      }
      if (isTranscriptEntry(parsed)) entries.push(parsed)
    }
    return entries
  }

  async delete(threadId: string): Promise<void> {
    if (this.stateDb.locked) return
    try {
      // Usually already gone: the metadata delete cascades the entries. This
      // covers the orchestrators' explicit call and any cascade-less path.
      this.db.prepare('DELETE FROM transcript_entries WHERE thread_id = ?').run(threadId)
    } catch (err) {
      console.error(`[SqliteTranscriptStore] delete failed for Thread ${threadId}:`, err)
    }
  }

  /** Whether a Thread already has entries — the importer's per-file skip gate. */
  hasEntries(threadId: string): boolean {
    if (this.stateDb.locked) return false
    const row = this.db
      .prepare('SELECT 1 AS one FROM transcript_entries WHERE thread_id = ? LIMIT 1')
      .get(threadId) as { one: number } | undefined
    return row !== undefined
  }

  /** Whether the Thread's metadata row exists (same db) — the importer's FK pre-check. */
  threadExists(threadId: string): boolean {
    if (this.stateDb.locked) return false
    const row = this.db.prepare('SELECT 1 AS one FROM threads WHERE id = ? LIMIT 1').get(threadId) as
      | { one: number }
      | undefined
    return row !== undefined
  }

  /**
   * One-time legacy import (ADR-0019): insert one Thread's parsed JSONL entries
   * in file order inside a single transaction — a failure rolls the whole file
   * back so the importer can retry it next launch. Only the importer calls this.
   */
  importEntries(threadId: string, entries: readonly TranscriptEntry[]): void {
    if (this.stateDb.locked) throw new Error('cannot import into a locked state db')
    this.db.exec('BEGIN')
    try {
      const insert = this.db.prepare(
        'INSERT INTO transcript_entries (thread_id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
      )
      const ts = this.now()
      for (const entry of entries) {
        insert.run(threadId, entry.t, JSON.stringify(entry), ts)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
