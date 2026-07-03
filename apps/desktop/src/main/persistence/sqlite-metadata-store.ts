import { randomUUID } from 'node:crypto'
import type { MetadataStoreApi } from './metadata-store-api'
import type {
  MetadataSnapshot,
  ThreadInput,
  ThreadRecord,
  WorkspaceInput,
  WorkspaceRecord,
} from './metadata-store'
import type { StateDb } from './sqlite-db'

/**
 * The Workspace/Thread metadata store on SQLite (ADR-0019), a drop-in behind
 * `MetadataStoreApi` — the same behaviors the JSON `MetadataStore` pins in its
 * suite, re-pointed at `workspaces`/`threads` rows. Mutations are single-row
 * statements (the per-turn `touchThread` no longer rewrites an index file);
 * every write is synchronous inside the async signatures the seam keeps.
 *
 * LOCKED state (db written by a newer build, `openStateDb`): the store presents
 * empty and every mutation is a no-op — mirroring the JSON store's fail-closed
 * envelope rule — so the caller can surface an honest "upgrade to open your
 * data" notice instead of showing empty as real.
 *
 * Thread flags are stored 0/1/NULL: NULL = never set (reads as `undefined`),
 * 0 = explicitly false, 1 = true. This keeps `setThreadFlags(id, { pinned:
 * false })` reading back `false` while an untouched flag stays `undefined`,
 * exactly like the in-memory shape the renderer's pin/archive logic expects.
 */

interface WorkspaceRow {
  id: string
  dir: string
  display_name: string
  last_opened_at: number
}

interface ThreadRow {
  id: string
  workspace_id: string
  session_id: string | null
  title: string | null
  created_at: number
  last_active_at: number
  pinned: number | null
  archived: number | null
}

export interface SqliteMetadataStoreDeps {
  stateDb: StateDb
  now?: () => number
  mintId?: () => string
}

export class SqliteMetadataStore implements MetadataStoreApi {
  private readonly stateDb: StateDb
  private readonly now: () => number
  private readonly mintId: () => string

  constructor(deps: SqliteMetadataStoreDeps) {
    this.stateDb = deps.stateDb
    this.now = deps.now ?? Date.now
    this.mintId = deps.mintId ?? randomUUID
  }

  private get db() {
    return this.stateDb.db
  }

  /** No-op for SQLite (schema is brought forward at open); seam parity only. */
  async load(): Promise<void> {}

  isLocked(): boolean {
    return this.stateDb.locked
  }

  async upsertWorkspace(input: WorkspaceInput): Promise<WorkspaceRecord> {
    const fallback: WorkspaceRecord = {
      id: this.mintId(),
      dir: input.dir,
      displayName: input.displayName ?? input.dir,
      lastOpenedAt: input.lastOpenedAt ?? this.now(),
    }
    if (this.stateDb.locked) return fallback // non-durable, like the locked JSON store

    const existing = this.db
      .prepare('SELECT * FROM workspaces WHERE dir = ?')
      .get(input.dir) as WorkspaceRow | undefined
    const record: WorkspaceRecord = {
      id: existing?.id ?? fallback.id,
      dir: input.dir,
      displayName: input.displayName ?? existing?.display_name ?? input.dir,
      lastOpenedAt: input.lastOpenedAt ?? this.now(),
    }
    this.db
      .prepare(
        `INSERT INTO workspaces (id, dir, display_name, last_opened_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(dir) DO UPDATE SET display_name = excluded.display_name,
                                        last_opened_at = excluded.last_opened_at`,
      )
      .run(record.id, record.dir, record.displayName, record.lastOpenedAt)
    return record
  }

  async upsertThread(input: ThreadInput): Promise<ThreadRecord> {
    const ts = this.now()
    const existing =
      !this.stateDb.locked && input.id
        ? ((this.db.prepare('SELECT * FROM threads WHERE id = ?').get(input.id) as
            | ThreadRow
            | undefined) ?? undefined)
        : undefined
    const record: ThreadRecord = {
      id: existing?.id ?? input.id ?? this.mintId(),
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? existing?.session_id ?? null,
      title: input.title ?? existing?.title ?? null,
      createdAt: input.createdAt ?? existing?.created_at ?? ts,
      lastActiveAt: input.lastActiveAt ?? ts,
      pinned: input.pinned ?? flagFromColumn(existing?.pinned),
      archived: input.archived ?? flagFromColumn(existing?.archived),
    }
    if (this.stateDb.locked) return record // non-durable, like the locked JSON store

    this.db
      .prepare(
        `INSERT INTO threads (id, workspace_id, session_id, title, created_at, last_active_at, pinned, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET workspace_id = excluded.workspace_id,
                                       session_id = excluded.session_id,
                                       title = excluded.title,
                                       created_at = excluded.created_at,
                                       last_active_at = excluded.last_active_at,
                                       pinned = excluded.pinned,
                                       archived = excluded.archived`,
      )
      .run(
        record.id,
        record.workspaceId,
        record.sessionId,
        record.title,
        record.createdAt,
        record.lastActiveAt,
        flagToColumn(record.pinned),
        flagToColumn(record.archived),
      )
    return record
  }

  async touchThread(id: string): Promise<void> {
    if (this.stateDb.locked) return
    this.db.prepare('UPDATE threads SET last_active_at = ? WHERE id = ?').run(this.now(), id)
  }

  async setThreadFlags(id: string, flags: { pinned?: boolean; archived?: boolean }): Promise<void> {
    if (this.stateDb.locked) return
    const sets: string[] = []
    const params: (number | string)[] = []
    if (flags.pinned !== undefined) {
      sets.push('pinned = ?')
      params.push(flags.pinned ? 1 : 0)
    }
    if (flags.archived !== undefined) {
      sets.push('archived = ?')
      params.push(flags.archived ? 1 : 0)
    }
    if (!sets.length) return
    this.db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
  }

  async setThreadTitle(id: string, title: string | null): Promise<boolean> {
    if (this.stateDb.locked) return false
    // `IS NOT` is NULL-safe, so the unchanged-title no-op (which absorbs the
    // vibe-acp `session_info_update` echo after our own rename) covers nulls too.
    const result = this.db
      .prepare('UPDATE threads SET title = ? WHERE id = ? AND title IS NOT ?')
      .run(title, id, title)
    return result.changes > 0
  }

  async deleteThread(id: string): Promise<void> {
    if (this.stateDb.locked) return
    this.db.prepare('DELETE FROM threads WHERE id = ?').run(id)
  }

  async removeWorkspace(id: string): Promise<string[]> {
    if (this.stateDb.locked) return []
    const rows = this.db
      .prepare('SELECT id FROM threads WHERE workspace_id = ?')
      .all(id) as Array<Pick<ThreadRow, 'id'>>
    // The FK cascade drops the Threads with the Workspace row (one atomic
    // statement); Threads whose Workspace row is already gone (defensive) are
    // swept explicitly so the returned ids always match what was removed.
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM threads WHERE workspace_id = ?').run(id)
    return rows.map((r) => r.id)
  }

  findThreadIdBySessionId(sessionId: string | null | undefined): string | null {
    if (!sessionId || this.stateDb.locked) return null
    const row = this.db
      .prepare('SELECT id FROM threads WHERE session_id = ? ORDER BY last_active_at DESC LIMIT 1')
      .get(sessionId) as Pick<ThreadRow, 'id'> | undefined
    return row?.id ?? null
  }

  snapshot(): MetadataSnapshot {
    if (this.stateDb.locked) return { workspaces: [], threads: [] }
    const workspaces = (
      this.db
        .prepare('SELECT * FROM workspaces ORDER BY last_opened_at DESC, rowid DESC')
        .all() as unknown as WorkspaceRow[]
    ).map(workspaceFromRow)
    const threads = (
      this.db
        .prepare('SELECT * FROM threads ORDER BY last_active_at DESC, rowid DESC')
        .all() as unknown as ThreadRow[]
    ).map(threadFromRow)
    return { workspaces, threads }
  }

  /** Whether the database holds no metadata yet — the one-time import gate. */
  isEmpty(): boolean {
    if (this.stateDb.locked) return false
    const row = this.db
      .prepare('SELECT (SELECT COUNT(*) FROM workspaces) + (SELECT COUNT(*) FROM threads) AS n')
      .get() as { n: number }
    return row.n === 0
  }

  /**
   * One-time legacy import (ADR-0019): insert records VERBATIM — ids, timestamps
   * and flags preserved, nothing minted — inside one transaction so a failure
   * rolls back to the empty database it found. Only the importer calls this.
   */
  importSnapshot(snapshot: MetadataSnapshot): void {
    if (this.stateDb.locked) throw new Error('cannot import into a locked state db')
    // Orphan Threads (their Workspace record was lost) exist only in legacy
    // data — the FK would reject them and fail the whole import, so drop them
    // exactly like `groupThreadsByWorkspace` already drops them from every list.
    const workspaceIds = new Set(snapshot.workspaces.map((w) => w.id))
    const threads = snapshot.threads.filter((t) => workspaceIds.has(t.workspaceId))
    const orphans = snapshot.threads.length - threads.length
    if (orphans > 0) {
      console.error(`[SqliteMetadataStore] import: dropping ${orphans} orphan Thread record(s)`)
    }
    this.db.exec('BEGIN')
    try {
      const insertWorkspace = this.db.prepare(
        'INSERT INTO workspaces (id, dir, display_name, last_opened_at) VALUES (?, ?, ?, ?)',
      )
      for (const w of snapshot.workspaces) {
        insertWorkspace.run(w.id, w.dir, w.displayName, w.lastOpenedAt)
      }
      const insertThread = this.db.prepare(
        `INSERT INTO threads (id, workspace_id, session_id, title, created_at, last_active_at, pinned, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const t of threads) {
        insertThread.run(
          t.id,
          t.workspaceId,
          t.sessionId,
          t.title,
          t.createdAt,
          t.lastActiveAt,
          flagToColumn(t.pinned),
          flagToColumn(t.archived),
        )
      }
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }
}

function workspaceFromRow(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    dir: row.dir,
    displayName: row.display_name,
    lastOpenedAt: row.last_opened_at,
  }
}

function threadFromRow(row: ThreadRow): ThreadRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    title: row.title,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    pinned: flagFromColumn(row.pinned),
    archived: flagFromColumn(row.archived),
  }
}

/** 0/1/NULL column → boolean|undefined flag (NULL = never set). */
function flagFromColumn(value: number | null | undefined): boolean | undefined {
  return value === null || value === undefined ? undefined : value !== 0
}

/** boolean|undefined flag → 0/1/NULL column. */
function flagToColumn(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0
}
