import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStateDb, readUserVersion, type Migration } from './sqlite-db'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The state-db opener + forward-only migration runner (ADR-0019). Exercised on
 * `:memory:` databases plus a real temp-dir file where reopen/durability is the
 * point — no `userData`, mirroring metadata-store.test.ts.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-sqlite-db-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A tiny migration writing a marker row, for runner-order tests. */
function marker(id: number): Migration {
  return {
    id,
    name: `marker-${id}`,
    creates: ['applied'],
    up: (db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS applied (id INTEGER)`)
      db.exec(`INSERT INTO applied (id) VALUES (${id})`)
    },
  }
}

describe('openStateDb migration runner', () => {
  it('brings a fresh database to the latest version, applying migrations in order', () => {
    const state = openStateDb({ path: ':memory:', migrations: [marker(1), marker(2), marker(3)] })
    expect(state.locked).toBe(false)
    expect(readUserVersion(state.db)).toBe(3)
    const applied = state.db.prepare('SELECT id FROM applied ORDER BY rowid').all() as unknown as {
      id: number
    }[]
    expect(applied.map((r) => r.id)).toEqual([1, 2, 3])
    state.close()
  })

  it('applies only the PENDING migrations on an already-migrated database', () => {
    const path = join(dir, 'pending.sqlite')
    openStateDb({ path, migrations: [marker(1)] }).close()

    // Reopen with a longer history: only 2 and 3 run.
    const state = openStateDb({ path, migrations: [marker(1), marker(2), marker(3)] })
    expect(readUserVersion(state.db)).toBe(3)
    const applied = state.db.prepare('SELECT id FROM applied ORDER BY rowid').all() as unknown as {
      id: number
    }[]
    expect(applied.map((r) => r.id)).toEqual([1, 2, 3])
    state.close()

    // A third open with the same history is a no-op (no duplicate markers).
    const again = openStateDb({ path, migrations: [marker(1), marker(2), marker(3)] })
    const rows = again.db.prepare('SELECT COUNT(*) AS n FROM applied').get() as { n: number }
    expect(rows.n).toBe(3)
    again.close()
  })

  it('FAILS CLOSED on a database from a newer build: locked, no migrations run, file preserved', () => {
    const path = join(dir, 'future.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 99')
    raw.exec('CREATE TABLE future_data (x)')
    raw.exec("INSERT INTO future_data VALUES ('written by the future')")
    raw.close()

    const state = openStateDb({ path, migrations: [marker(1)] })
    expect(state.locked).toBe(true)
    // Nothing ran: version untouched, no marker table, future data intact.
    expect(readUserVersion(state.db)).toBe(99)
    const tables = state.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(['future_data'])
    state.close()
  })

  it('rolls back and rethrows when a migration fails mid-way (no partial version bump)', () => {
    const path = join(dir, 'broken.sqlite')
    const broken: Migration = {
      id: 2,
      name: 'boom',
      creates: ['half'],
      up: (db) => {
        db.exec('CREATE TABLE half (x)')
        throw new Error('boom')
      },
    }
    expect(() => openStateDb({ path, migrations: [marker(1), broken] })).toThrow('boom')

    // Version stopped at 1 and the failed migration's table was rolled back.
    const raw = new DatabaseSync(path)
    expect(readUserVersion(raw)).toBe(1)
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'half'")
      .all()
    expect(tables).toHaveLength(0)
    raw.close()
  })

  it('enables WAL journaling and foreign-key enforcement on a file database', () => {
    const path = join(dir, 'pragmas.sqlite')
    const state = openStateDb({ path, migrations: STATE_MIGRATIONS })
    const mode = state.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    expect(mode.journal_mode).toBe('wal')
    const fk = state.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    expect(fk.foreign_keys).toBe(1)
    state.close()
  })
})

describe('STATE_MIGRATIONS registry', () => {
  it('is strictly increasing from 1 (the runner contract)', () => {
    expect(STATE_MIGRATIONS.length).toBeGreaterThan(0)
    STATE_MIGRATIONS.forEach((m, i) => expect(m.id).toBe(i + 1))
  })

  it('creates the metadata tables', () => {
    const state = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
    const tables = state.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(['threads', 'workspaces']))
    state.close()
  })
})

describe('the migration ledger (#475)', () => {
  /** Two branches that each appended a migration, both claiming id 2. */
  const branchA: Migration = {
    id: 2,
    name: 'cli-sessions',
    creates: ['cli_sessions'],
    up: (db) => db.exec('CREATE TABLE cli_sessions (x)'),
  }
  const branchB: Migration = {
    id: 2,
    name: 'bots',
    creates: ['bots'],
    up: (db) => db.exec('CREATE TABLE bots (x)'),
  }

  it('creates the branch-B table on a database branch A already took to the same version', () => {
    // THE REGRESSION TEST. Before the ledger this database looked fully migrated
    // and `bots` was never created — silently, for eight days, in a real profile.
    const path = join(dir, 'divergent.sqlite')
    openStateDb({ path, migrations: [marker(1), branchA] }).close()

    const reopened = openStateDb({ path, migrations: [marker(1), branchB] })
    expect(reopened.locked).toBe(false)
    const tables = reopened.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as unknown as { name: string }[]
    expect(tables.map((t) => t.name)).toContain('bots')
    expect(tables.map((t) => t.name)).toContain('cli_sessions') // the orphan is left alone
    reopened.close()
  })

  it('records every applied migration by name, and does not re-run it on reopen', () => {
    const path = join(dir, 'ledger.sqlite')
    const first = openStateDb({ path, migrations: [marker(1), marker(2)] })
    const names = first.db
      .prepare('SELECT name FROM schema_migrations ORDER BY name')
      .all() as unknown as { name: string }[]
    expect(names.map((n) => n.name)).toEqual(['marker-1', 'marker-2'])
    first.close()

    // `marker` INSERTs a row each time it runs, so a re-run would show up here.
    const again = openStateDb({ path, migrations: [marker(1), marker(2)] })
    const applied = again.db.prepare('SELECT id FROM applied').all() as unknown as { id: number }[]
    expect(applied).toHaveLength(2)
    again.close()
  })

  it('backfills names from user_version for a database written before the ledger existed', () => {
    const path = join(dir, 'backfill.sqlite')
    // A pre-ledger database: migrated, versioned, but with no schema_migrations.
    const raw = new DatabaseSync(path)
    raw.exec('CREATE TABLE applied (id INTEGER)')
    raw.exec('INSERT INTO applied (id) VALUES (1)')
    raw.exec('PRAGMA user_version = 1')
    raw.close()

    const state = openStateDb({ path, migrations: [marker(1), marker(2)] })
    const names = state.db
      .prepare('SELECT name FROM schema_migrations ORDER BY name')
      .all() as unknown as { name: string }[]
    expect(names.map((n) => n.name)).toEqual(['marker-1', 'marker-2'])
    // marker-1 was backfilled, not re-run, so still exactly one pre-existing row + marker-2's.
    const applied = state.db.prepare('SELECT id FROM applied ORDER BY rowid').all() as unknown as {
      id: number
    }[]
    expect(applied.map((r) => r.id)).toEqual([1, 2])
    state.close()
  })

  it('never lowers user_version when repairing a database that is already past it', () => {
    const path = join(dir, 'no-regress.sqlite')
    openStateDb({ path, migrations: [marker(1), branchA, marker(3)] }).close()
    expect(readUserVersion(new DatabaseSync(path))).toBe(3)

    const reopened = openStateDb({ path, migrations: [marker(1), branchB] })
    expect(readUserVersion(reopened.db)).toBe(3) // not 2 — going back would re-arm fail-closed
    reopened.close()
  })

  it('locks a database whose migration is only PARTLY present, rather than writing into it', () => {
    const path = join(dir, 'damaged.sqlite')
    const pair: Migration = {
      id: 2,
      name: 'pair',
      creates: ['left', 'right'],
      up: (db) => {
        db.exec('CREATE TABLE left_t (x)')
        db.exec('CREATE TABLE right_t (x)')
      },
    }
    // Declare objects that `up` does not actually make, so the check sees a half.
    const declared: Migration = { ...pair, creates: ['left_t', 'never_made'] }
    openStateDb({ path, migrations: [marker(1), declared] }).close()

    const reopened = openStateDb({ path, migrations: [marker(1), declared] })
    expect(reopened.locked).toBe(true)
    expect(reopened.lockReason).toContain('never_made')
    reopened.close()
  })

  it('the real migration list declares objects that match what it actually creates', () => {
    // Guards the whole mechanism: a `creates` typo would make every launch either
    // re-run a migration or lock the database.
    const state = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
    const objects = new Set(
      (state.db.prepare('SELECT name FROM sqlite_master').all() as unknown as { name: string }[]).map(
        (r) => r.name,
      ),
    )
    for (const migration of STATE_MIGRATIONS) {
      for (const object of migration.creates) {
        expect({ migration: migration.name, object, present: objects.has(object) }).toEqual({
          migration: migration.name,
          object,
          present: true,
        })
      }
    }
    state.close()
  })
})
