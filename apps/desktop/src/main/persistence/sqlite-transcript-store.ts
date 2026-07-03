import type { ReadTranscriptResult, ThreadSnapshotPutArgs, TranscriptEntry } from '../../shared/ipc'
import { projectEntryProse } from './prose-projection'
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
    // Entry + its prose projection land in ONE transaction (ADR-0019, #296) so
    // the search index can never drift from the event log.
    this.db.exec('BEGIN')
    try {
      const inserted = this.db
        .prepare('INSERT INTO transcript_entries (thread_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(threadId, entry.t, JSON.stringify(entry), this.now())
      projectEntryProse(this.db, threadId, inserted.lastInsertRowid, entry)
      this.db.exec('COMMIT')
    } catch (err) {
      // Non-fatal by design — the conversation proceeds; the entry is lost.
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // BEGIN itself failed — nothing to roll back
      }
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

  /**
   * The tiered reopen read (ADR-0019, #297). A stored snapshot whose
   * `reducer_version` matches the renderer's (and no `forceFull` corruption
   * fallback) returns with only the entry TAIL beyond its horizon; a stale
   * (version-mismatched) snapshot is DELETED — it's a disposable projection —
   * and the whole log returns as the tail for one full fold. `lastSeq` is the
   * horizon this reply covers, echoed back verbatim by the next `putSnapshot`.
   */
  async readWithSnapshot(
    threadId: string,
    reducerVersion: number,
    forceFull?: boolean,
  ): Promise<ReadTranscriptResult> {
    if (this.stateDb.locked) return { snapshot: null, tail: [], lastSeq: 0 }
    const row = this.db
      .prepare('SELECT reducer_version, last_seq, state FROM thread_snapshots WHERE thread_id = ?')
      .get(threadId) as { reducer_version: number; last_seq: number; state: string } | undefined

    let fromSeq = 0
    let snapshot: ReadTranscriptResult['snapshot'] = null
    if (row && !forceFull && row.reducer_version === reducerVersion) {
      snapshot = { state: row.state, lastSeq: row.last_seq }
      fromSeq = row.last_seq
    } else if (row && row.reducer_version !== reducerVersion) {
      // A projection for a reducer shape this build no longer runs — disposable.
      try {
        this.db.prepare('DELETE FROM thread_snapshots WHERE thread_id = ?').run(threadId)
      } catch {
        // best-effort — a surviving stale row just re-triggers this branch
      }
    }

    const rows = this.db
      .prepare('SELECT seq, payload FROM transcript_entries WHERE thread_id = ? AND seq > ? ORDER BY seq')
      .all(threadId, fromSeq) as unknown as { seq: number; payload: string }[]
    const tail: TranscriptEntry[] = []
    let lastSeq = fromSeq
    for (const r of rows) {
      lastSeq = r.seq
      let parsed: unknown
      try {
        parsed = JSON.parse(r.payload)
      } catch {
        continue // garbled row — same tolerance as read()
      }
      if (isTranscriptEntry(parsed)) tail.push(parsed)
    }
    return { snapshot, tail, lastSeq }
  }

  /**
   * Store the renderer's folded view (ADR-0019, #297). The blob is OPAQUE —
   * main never parses it (ADR-0001); this only upserts the row. Best-effort:
   * refused on a locked db, an unknown Thread (FK), or a horizon REGRESSION
   * (an older read racing a newer stored snapshot must not clobber it).
   */
  async putSnapshot(args: ThreadSnapshotPutArgs): Promise<void> {
    if (this.stateDb.locked) return
    if (!args.state || args.lastSeq < 0) return
    try {
      this.db
        .prepare(
          `INSERT INTO thread_snapshots (thread_id, reducer_version, last_seq, state, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             reducer_version = excluded.reducer_version,
             last_seq = excluded.last_seq,
             state = excluded.state,
             updated_at = excluded.updated_at
           WHERE excluded.last_seq >= thread_snapshots.last_seq
              OR excluded.reducer_version <> thread_snapshots.reducer_version`,
        )
        .run(args.threadId, args.reducerVersion, args.lastSeq, args.state, this.now())
    } catch (err) {
      console.error(`[SqliteTranscriptStore] putSnapshot failed for Thread ${args.threadId}:`, err)
    }
  }

  async delete(threadId: string): Promise<void> {
    if (this.stateDb.locked) return
    try {
      // Usually already gone: the metadata delete cascades entries AND prose.
      // This covers the orchestrators' explicit call and any cascade-less path
      // (the prose delete fires the FTS trigger, so the index stays clean).
      this.db.prepare('DELETE FROM transcript_entries WHERE thread_id = ?').run(threadId)
      this.db.prepare('DELETE FROM prose_items WHERE thread_id = ?').run(threadId)
      this.db.prepare('DELETE FROM thread_snapshots WHERE thread_id = ?').run(threadId)
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
        const inserted = insert.run(threadId, entry.t, JSON.stringify(entry), ts)
        projectEntryProse(this.db, threadId, inserted.lastInsertRowid, entry)
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}
