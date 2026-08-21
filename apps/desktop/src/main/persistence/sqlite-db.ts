import { DatabaseSync } from 'node:sqlite'
import { planMigrations } from './migration-plan'

/**
 * The one SQLite database for everything we persist (ADR-0019): `state.sqlite`
 * under `userData`, opened by main — the single writer — with WAL journaling.
 *
 * SEAM CONTRACT: this module is the ONLY place a `DatabaseSync` is constructed
 * for the state database. Stores receive the opened `StateDb` injected (tests
 * pass `:memory:` or a temp-dir path) and never derive the path themselves.
 *
 * SCHEMA VERSIONING (fail-closed, carried over from the JSON MetadataStore):
 * migrations are forward-only, statically registered in a numbered array (no
 * filesystem discovery — survives bundling), and run automatically at open, each
 * inside a transaction. A file whose `user_version` is NEWER than this build's
 * latest migration is refused: the db opens LOCKED — no migrations run, stores
 * present empty and write nothing — so an older build can never clobber data
 * written by a newer one.
 *
 * WHICH migrations have run is recorded BY NAME in `schema_migrations`, not by
 * `user_version` alone (#475). An integer is a position, so two branches that
 * each append a migration both claim the same number and each skips the other's
 * forever; a name cannot collide that way. `user_version` is still written and
 * still drives the newer-build refusal above — it just no longer decides what to
 * run. Every migration declares the schema objects it creates, so a ledger row
 * that is not backed by real tables is caught instead of believed.
 */

export interface Migration {
  /** Strictly increasing, starting at 1. Drives ORDER and `user_version`. */
  id: number
  /** The identity a migration is recorded under. Never reuse or rename one. */
  name: string
  /**
   * Every schema object `up` creates — tables, indexes, triggers, virtual tables
   * — exactly as `sqlite_master.name` spells them.
   *
   * REQUIRED, so that adding a migration forces the question, and so a ledger row
   * can be checked against the schema it claims to have made (#475). Shadow
   * tables an FTS5 virtual table creates for itself are NOT listed: the virtual
   * table is the object we made.
   */
  creates: readonly string[]
  up: (db: DatabaseSync) => void
}

export interface StateDbDeps {
  /** Absolute db path, or `:memory:` (tests). */
  path: string
  migrations: readonly Migration[]
}

export interface StateDb {
  db: DatabaseSync
  /**
   * True when this database must not be migrated or written: either a newer
   * build wrote it, or its schema is damaged in a way re-running cannot fix.
   * `lockReason` says which, in words a user could act on.
   */
  locked: boolean
  /** Why it is locked, or null when it is not. */
  lockReason: string | null
  close(): void
}

/** The ledger of applied migrations, by name (#475). Meta, so not a migration. */
const SCHEMA_LEDGER = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  );
`

/** Read `PRAGMA user_version` (0 on a fresh database). */
export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return typeof row?.user_version === 'number' ? row.user_version : 0
}

/**
 * Open (creating if absent) the state database, apply pragmas, and bring the
 * schema forward. Throws on an unopenable path — the caller (the construction
 * seam in `create-metadata-store.ts`) catches and falls back to the legacy
 * JSON stores rather than wedging launch.
 */
export function openStateDb(deps: StateDbDeps): StateDb {
  const db = new DatabaseSync(deps.path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')

  const latest = deps.migrations.length ? deps.migrations[deps.migrations.length - 1].id : 0
  const current = readUserVersion(db)
  if (current > latest) {
    const reason =
      `This database was written by a newer version of Vibe Mistro (schema ${current}; ` +
      `this build understands ${latest}). It has been opened read-only so that nothing ` +
      `is overwritten. Update Vibe Mistro to use these Projects and Threads.`
    console.error(`[SqliteDb] ${deps.path}: ${reason}`)
    return { db, locked: true, lockReason: reason, close: () => closeQuietly(db) }
  }

  db.exec(SCHEMA_LEDGER)
  const plan = planMigrations({
    migrations: deps.migrations,
    applied: readAppliedNames(db),
    ledgerEmpty: countLedgerRows(db) === 0,
    userVersion: current,
    existingObjects: readSchemaObjects(db),
  })

  if (plan.inconsistent.length > 0) {
    // Half a migration's objects exist and half do not. Re-running `up` would
    // fail on the half that IS there, and writing into a schema we cannot
    // describe risks the data we do have — so stop, loudly, with the detail
    // needed to repair it by hand.
    const detail = plan.inconsistent
      .map((d) => `${d.name} (missing: ${d.missing.join(', ')})`)
      .join('; ')
    const reason =
      `This database's schema is incomplete and cannot be repaired automatically: ${detail}. ` +
      `It has been opened read-only so nothing is lost. Please report this with the details above.`
    console.error(`[SqliteDb] ${deps.path}: ${reason}`)
    return { db, locked: true, lockReason: reason, close: () => closeQuietly(db) }
  }

  for (const discrepancy of plan.repaired) {
    // NOT swallowed: this is the failure #475 was filed for, and it went unseen
    // for eight days precisely because nothing said it out loud.
    console.warn(
      `[SqliteDb] ${deps.path}: migration '${discrepancy.name}' was recorded as applied but ` +
        `created nothing (missing: ${discrepancy.missing.join(', ')}). Re-applying it. This ` +
        `database was probably migrated by a different build or branch.`,
    )
  }

  const now = Date.now()
  if (plan.backfill.length > 0) recordApplied(db, plan.backfill, now)

  for (const migration of plan.run) {
    db.exec('BEGIN')
    try {
      migration.up(db)
      recordApplied(db, [migration.name], now)
      // NEVER lower it: a divergent database is already past this id, and going
      // backwards would re-arm the fail-closed check against its own data.
      db.exec(`PRAGMA user_version = ${Math.max(readUserVersion(db), migration.id)}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      closeQuietly(db)
      throw err
    }
  }

  return { db, locked: false, lockReason: null, close: () => closeQuietly(db) }
}

/** The migration names the ledger holds. */
function readAppliedNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM schema_migrations').all() as { name?: unknown }[]
  return new Set(rows.map((row) => String(row.name)))
}

function countLedgerRows(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c?: number }
  return typeof row?.c === 'number' ? row.c : 0
}

/** Every name in `sqlite_master` — tables, indexes and triggers alike. */
function readSchemaObjects(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM sqlite_master').all() as { name?: unknown }[]
  return new Set(rows.map((row) => String(row.name)))
}

function recordApplied(db: DatabaseSync, names: readonly string[], atMs: number): void {
  const insert = db.prepare(
    'INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING',
  )
  for (const name of names) insert.run(name, atMs)
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // already closed — nothing to release
  }
}
