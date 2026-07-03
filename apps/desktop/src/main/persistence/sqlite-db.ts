import { DatabaseSync } from 'node:sqlite'

/**
 * The one SQLite database for everything we persist (ADR-0019): `state.sqlite`
 * under `userData`, opened by main — the single writer — with WAL journaling.
 *
 * SEAM CONTRACT: this module is the ONLY place a `DatabaseSync` is constructed
 * for the state database. Stores receive the opened `StateDb` injected (tests
 * pass `:memory:` or a temp-dir path) and never derive the path themselves.
 *
 * SCHEMA VERSIONING (fail-closed, carried over from the JSON MetadataStore):
 * the version lives in `PRAGMA user_version`. Migrations are forward-only,
 * statically registered in a numbered array (no filesystem discovery — survives
 * bundling), and run automatically at open, each inside a transaction. A file
 * whose `user_version` is NEWER than this build's latest migration is refused:
 * the db opens LOCKED — no migrations run, stores present empty and write
 * nothing — so an older build can never clobber data written by a newer one.
 */

export interface Migration {
  /** Strictly increasing, starting at 1. Becomes `user_version` once applied. */
  id: number
  name: string
  up: (db: DatabaseSync) => void
}

export interface StateDbDeps {
  /** Absolute db path, or `:memory:` (tests). */
  path: string
  migrations: readonly Migration[]
}

export interface StateDb {
  db: DatabaseSync
  /** True when the file was written by a newer build — see module doc. */
  locked: boolean
  close(): void
}

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
    console.error(
      `[SqliteDb] ${deps.path} is user_version ${current}; this build supports ${latest}. ` +
        `Refusing to migrate or write so a newer build's data is preserved. ` +
        `Upgrade vibe-mistro to open these Workspaces/Threads.`,
    )
    return { db, locked: true, close: () => closeQuietly(db) }
  }

  for (const migration of deps.migrations) {
    if (migration.id <= current) continue
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.id}`)
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      closeQuietly(db)
      throw err
    }
  }

  return { db, locked: false, close: () => closeQuietly(db) }
}

function closeQuietly(db: DatabaseSync): void {
  try {
    db.close()
  } catch {
    // already closed — nothing to release
  }
}
