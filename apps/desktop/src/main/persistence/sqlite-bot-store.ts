import type { BotRecord } from '../../shared/ipc'
import type { BotInsert, BotPatch, BotStoreApi } from './bot-store-api'
import type { StateDb } from './sqlite-db'

/**
 * The Mistro Bot store on SQLite (#445, ADR-0027) — the `bots` table behind
 * `BotStoreApi`, on the SAME `state.sqlite` as the metadata and transcript
 * stores (never split-brain). A Bot row is keyed by its Thread and cascades
 * with it, so deleting a Thread or removing a Workspace can never leave a
 * dangling record.
 *
 * LOCKED state (db written by a newer build, `openStateDb`): reads present
 * EMPTY and every mutation is a no-op, mirroring `SqliteMetadataStore` — the
 * caller surfaces the honest "upgrade to open your data" notice instead of
 * showing empty as real.
 *
 * Best-effort per ADR-0019: a failing statement is logged and reported as a
 * failed write (`null` / `false`); it never rejects into the live flow.
 */

interface BotRow {
  thread_id: string
  workspace_id: string
  profile_id: string
  name: string
  colour: string
  description: string
  instructions: string
  created_at: number
  updated_at: number
}

export interface SqliteBotStoreDeps {
  stateDb: StateDb
  now?: () => number
}

export class SqliteBotStore implements BotStoreApi {
  private readonly stateDb: StateDb
  private readonly now: () => number

  constructor(deps: SqliteBotStoreDeps) {
    this.stateDb = deps.stateDb
    this.now = deps.now ?? Date.now
  }

  private get db() {
    return this.stateDb.db
  }

  list(): BotRecord[] {
    if (this.stateDb.locked) return []
    try {
      const rows = this.db
        .prepare('SELECT * FROM bots ORDER BY updated_at DESC, rowid DESC')
        .all() as unknown as BotRow[]
      return rows.map(botFromRow)
    } catch (err) {
      console.error('[SqliteBotStore] list failed:', err)
      return []
    }
  }

  listByWorkspace(workspaceId: string): BotRecord[] {
    if (this.stateDb.locked) return []
    try {
      const rows = this.db
        .prepare('SELECT * FROM bots WHERE workspace_id = ? ORDER BY updated_at DESC, rowid DESC')
        .all(workspaceId) as unknown as BotRow[]
      return rows.map(botFromRow)
    } catch (err) {
      console.error('[SqliteBotStore] listByWorkspace failed:', err)
      return []
    }
  }

  get(threadId: string): BotRecord | null {
    if (this.stateDb.locked) return null
    try {
      const row = this.db.prepare('SELECT * FROM bots WHERE thread_id = ?').get(threadId) as
        | BotRow
        | undefined
      return row ? botFromRow(row) : null
    } catch (err) {
      console.error('[SqliteBotStore] get failed:', err)
      return null
    }
  }

  insert(input: BotInsert): BotRecord | null {
    if (this.stateDb.locked) return null
    const ts = this.now()
    const record: BotRecord = { ...input, createdAt: ts, updatedAt: ts }
    try {
      this.db
        .prepare(
          `INSERT INTO bots (thread_id, workspace_id, profile_id, name, colour, description,
                             instructions, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.threadId,
          record.workspaceId,
          record.profileId,
          record.name,
          record.colour,
          record.description,
          record.instructions,
          record.createdAt,
          record.updatedAt,
        )
      return record
    } catch (err) {
      // A missing Thread/Workspace (FK), a duplicate profile id, or a broken
      // disk — logged, reported, never thrown into the create flow.
      console.error('[SqliteBotStore] insert failed:', err)
      return null
    }
  }

  update(threadId: string, patch: BotPatch): BotRecord | null {
    if (this.stateDb.locked) return null
    const existing = this.get(threadId)
    if (!existing) return null
    // `profile_id` is NOT in this statement, deliberately: a rename rewrites
    // `display_name` only, never the id the live session has selected (ADR-0027).
    const next: BotRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      colour: patch.colour ?? existing.colour,
      description: patch.description ?? existing.description,
      instructions: patch.instructions ?? existing.instructions,
      updatedAt: this.now(),
    }
    try {
      this.db
        .prepare(
          `UPDATE bots SET name = ?, colour = ?, description = ?, instructions = ?, updated_at = ?
           WHERE thread_id = ?`,
        )
        .run(next.name, next.colour, next.description, next.instructions, next.updatedAt, threadId)
      return next
    } catch (err) {
      console.error('[SqliteBotStore] update failed:', err)
      return null
    }
  }

  delete(threadId: string): boolean {
    if (this.stateDb.locked) return false
    try {
      return this.db.prepare('DELETE FROM bots WHERE thread_id = ?').run(threadId).changes > 0
    } catch (err) {
      console.error('[SqliteBotStore] delete failed:', err)
      return false
    }
  }
}

function botFromRow(row: BotRow): BotRecord {
  return {
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    name: row.name,
    colour: row.colour,
    description: row.description,
    instructions: row.instructions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}
