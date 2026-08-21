import type { RoutineOutcome, RoutineRecord } from '../../shared/ipc'
import { MAX_ROUTINES_PER_BOT } from '../../shared/routine-limits'
import { isRoutineSchedule } from '../../shared/schedule'
import type {
  RoutineInsert,
  RoutinePatch,
  RoutineRunResult,
  RoutineStoreApi,
} from './routine-store-api'
import type { StateDb } from './sqlite-db'

/**
 * The **Routine** store on SQLite (#467, ADR-0028) — the `routines` table behind
 * `RoutineStoreApi`, on the SAME `state.sqlite` as the metadata, transcript and
 * Bot stores (never split-brain).
 *
 * A Routine row is keyed to its **Bot** and cascades with it, so deleting a Bot,
 * deleting its Thread or removing its Workspace can never leave a schedule
 * pointing at a teammate that is gone.
 *
 * LOCKED state (db written by a newer build, `openStateDb`): reads present EMPTY
 * and every mutation is a no-op, mirroring `SqliteBotStore` — a Routine that
 * cannot be read is a Routine that must not fire.
 *
 * Best-effort per ADR-0019: a failing statement is logged and reported as a
 * failed write (`null` / `false`); it never rejects into the live flow.
 */

interface RoutineRow {
  id: string
  thread_id: string
  name: string
  prompt: string
  schedule: string
  allowed_commands: string
  active: number
  last_run_at: number | null
  last_outcome: string | null
  last_error: string | null
  created_at: number
  updated_at: number
}

const OUTCOMES: readonly RoutineOutcome[] = ['ok', 'failed', 'blocked', 'deferred']

export interface SqliteRoutineStoreDeps {
  stateDb: StateDb
  now?: () => number
}

export class SqliteRoutineStore implements RoutineStoreApi {
  private readonly stateDb: StateDb
  private readonly now: () => number

  constructor(deps: SqliteRoutineStoreDeps) {
    this.stateDb = deps.stateDb
    this.now = deps.now ?? Date.now
  }

  private get db() {
    return this.stateDb.db
  }

  list(): RoutineRecord[] {
    if (this.stateDb.locked) return []
    try {
      const rows = this.db
        .prepare('SELECT * FROM routines ORDER BY created_at, rowid')
        .all() as unknown as RoutineRow[]
      return readable(rows)
    } catch (err) {
      console.error('[SqliteRoutineStore] list failed:', err)
      return []
    }
  }

  listByBot(threadId: string): RoutineRecord[] {
    if (this.stateDb.locked) return []
    try {
      const rows = this.db
        .prepare('SELECT * FROM routines WHERE thread_id = ? ORDER BY created_at, rowid')
        .all(threadId) as unknown as RoutineRow[]
      return readable(rows)
    } catch (err) {
      console.error('[SqliteRoutineStore] listByBot failed:', err)
      return []
    }
  }

  get(id: string): RoutineRecord | null {
    if (this.stateDb.locked) return null
    try {
      const row = this.db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as
        | RoutineRow
        | undefined
      return row ? routineFromRow(row) : null
    } catch (err) {
      console.error('[SqliteRoutineStore] get failed:', err)
      return null
    }
  }

  insert(input: RoutineInsert): RoutineRecord | null {
    if (this.stateDb.locked) return null
    // The cap is enforced HERE as well as in the lifecycle (which owns the
    // message the user reads), because it is a property of the data rather than
    // of one code path: a Bot is single-threaded, so the deferral queue that
    // forms when Routines collide is what this bounds (ADR-0028 part 1).
    if (this.countForBot(input.threadId) >= MAX_ROUTINES_PER_BOT) {
      console.error(
        `[SqliteRoutineStore] refusing a ${MAX_ROUTINES_PER_BOT + 1}th routine on Bot ${input.threadId}`,
      )
      return null
    }
    const ts = this.now()
    const record: RoutineRecord = {
      ...input,
      lastRunAt: null,
      lastOutcome: null,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    }
    try {
      this.db
        .prepare(
          `INSERT INTO routines (id, thread_id, name, prompt, schedule, allowed_commands, active,
                                 last_run_at, last_outcome, last_error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          record.id,
          record.threadId,
          record.name,
          record.prompt,
          JSON.stringify(record.schedule),
          JSON.stringify(record.allowedCommands),
          record.active ? 1 : 0,
          record.createdAt,
          record.updatedAt,
        )
      return record
    } catch (err) {
      // A `threadId` that is not a Bot (the FK), a duplicate id, or a broken
      // disk — logged, reported, never thrown into the create flow.
      console.error('[SqliteRoutineStore] insert failed:', err)
      return null
    }
  }

  update(id: string, patch: RoutinePatch): RoutineRecord | null {
    if (this.stateDb.locked) return null
    const existing = this.get(id)
    if (!existing) return null
    const next: RoutineRecord = {
      ...existing,
      name: patch.name ?? existing.name,
      prompt: patch.prompt ?? existing.prompt,
      schedule: patch.schedule ?? existing.schedule,
      allowedCommands: patch.allowedCommands ?? existing.allowedCommands,
      active: patch.active ?? existing.active,
      updatedAt: this.now(),
    }
    try {
      this.db
        .prepare(
          `UPDATE routines SET name = ?, prompt = ?, schedule = ?, allowed_commands = ?,
                               active = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.name,
          next.prompt,
          JSON.stringify(next.schedule),
          JSON.stringify(next.allowedCommands),
          next.active ? 1 : 0,
          next.updatedAt,
          id,
        )
      return next
    } catch (err) {
      console.error('[SqliteRoutineStore] update failed:', err)
      return null
    }
  }

  recordRun(id: string, result: RoutineRunResult): RoutineRecord | null {
    if (this.stateDb.locked) return null
    const existing = this.get(id)
    if (!existing) return null
    // A successful run clears the failure it recovered from; anything else keeps
    // the detail that makes it fixable.
    const lastError =
      result.lastOutcome === 'ok' ? null : (result.lastError ?? existing.lastError ?? null)
    const next: RoutineRecord = {
      ...existing,
      lastRunAt: result.lastRunAt,
      lastOutcome: result.lastOutcome,
      lastError,
      updatedAt: this.now(),
    }
    try {
      this.db
        .prepare(
          `UPDATE routines SET last_run_at = ?, last_outcome = ?, last_error = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(next.lastRunAt, next.lastOutcome, next.lastError, next.updatedAt, id)
      return next
    } catch (err) {
      console.error('[SqliteRoutineStore] recordRun failed:', err)
      return null
    }
  }

  delete(id: string): boolean {
    if (this.stateDb.locked) return false
    try {
      return this.db.prepare('DELETE FROM routines WHERE id = ?').run(id).changes > 0
    } catch (err) {
      console.error('[SqliteRoutineStore] delete failed:', err)
      return false
    }
  }

  /** How many Routines this Bot already holds — the cap's own reading. */
  private countForBot(threadId: string): number {
    try {
      const row = this.db
        .prepare('SELECT COUNT(*) AS n FROM routines WHERE thread_id = ?')
        .get(threadId) as { n?: number } | undefined
      return typeof row?.n === 'number' ? row.n : 0
    } catch (err) {
      console.error('[SqliteRoutineStore] count failed:', err)
      // Unreadable means unbounded, and unbounded is the one answer the cap
      // exists to prevent — so a failed count refuses the insert.
      return MAX_ROUTINES_PER_BOT
    }
  }
}

/**
 * The rows that can be carried as records. A row whose `schedule` JSON is not a
 * schedule is LOGGED and left out: it can be neither fired nor rendered, and
 * inventing a schedule for it would be worse than admitting it is unreadable.
 * Only a hand-edited database produces one.
 */
function readable(rows: RoutineRow[]): RoutineRecord[] {
  const records: RoutineRecord[] = []
  for (const row of rows) {
    const record = routineFromRow(row)
    if (record) records.push(record)
  }
  return records
}

function routineFromRow(row: RoutineRow): RoutineRecord | null {
  const schedule = parseJson(row.schedule)
  if (!isRoutineSchedule(schedule)) {
    console.error(`[SqliteRoutineStore] routine ${row.id} has an unreadable schedule; skipping it`)
    return null
  }
  return {
    id: row.id,
    threadId: row.thread_id,
    name: row.name,
    prompt: row.prompt,
    schedule,
    allowedCommands: parseCommands(row.allowed_commands),
    active: row.active !== 0,
    lastRunAt: row.last_run_at,
    lastOutcome: isOutcome(row.last_outcome) ? row.last_outcome : null,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** The allowed commands, or none — an unreadable list must never widen into one. */
function parseCommands(json: string): string[] {
  const parsed = parseJson(json)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((entry): entry is string => typeof entry === 'string')
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function isOutcome(value: string | null): value is RoutineOutcome {
  return value !== null && (OUTCOMES as readonly string[]).includes(value)
}
