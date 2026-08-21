import { describe, it, expect } from 'vitest'
import { planMigrations } from './migration-plan'
import type { Migration } from './sqlite-db'

/**
 * The migration planner (#475). Every case here is one the integer
 * `user_version` could not tell apart, which is why the ledger exists.
 */

function migration(id: number, name: string, creates: string[]): Migration {
  return { id, name, creates, up: () => {} }
}

const CORE = migration(1, 'core', ['workspaces'])
const LOG = migration(2, 'log', ['entries', 'idx_entries'])
const BOTS = migration(3, 'bots', ['bots', 'idx_bots'])

const ALL = [CORE, LOG, BOTS]

function plan(args: Partial<Parameters<typeof planMigrations>[0]> = {}) {
  return planMigrations({
    migrations: ALL,
    applied: new Set<string>(),
    ledgerEmpty: true,
    userVersion: 0,
    existingObjects: new Set<string>(),
    ...args,
  })
}

describe('a fresh database', () => {
  it('runs every migration and backfills nothing', () => {
    const result = plan()
    expect(result.run.map((m) => m.name)).toEqual(['core', 'log', 'bots'])
    expect(result.backfill).toEqual([])
    expect(result.repaired).toEqual([])
    expect(result.inconsistent).toEqual([])
  })
})

describe('the first open after the ledger was introduced', () => {
  it('backfills the names user_version vouches for and runs the rest', () => {
    const result = plan({
      userVersion: 2,
      existingObjects: new Set(['workspaces', 'entries', 'idx_entries']),
    })
    expect(result.backfill).toEqual(['core', 'log'])
    expect(result.run.map((m) => m.name)).toEqual(['bots'])
    expect(result.repaired).toEqual([])
  })

  it('does not backfill a name it is also about to run — a claim precedes nothing', () => {
    // `bots` is claimed by user_version but no bots object exists, so it must be
    // RUN. Recording it as backfilled too would assert it ran before it did.
    const result = plan({ userVersion: 3, existingObjects: new Set(['workspaces', 'entries', 'idx_entries']) })
    expect(result.run.map((m) => m.name)).toEqual(['bots'])
    expect(result.backfill).not.toContain('bots')
  })
})

describe('the divergent-branch case — the bug #475 was filed for', () => {
  it('re-applies a migration whose objects are entirely absent, and says so', () => {
    // A database another branch took to user_version 3 with ITS OWN third
    // migration: the integer says "bots ran", the schema says otherwise.
    const result = plan({
      userVersion: 3,
      existingObjects: new Set(['workspaces', 'entries', 'idx_entries', 'cli_sessions']),
    })
    expect(result.run.map((m) => m.name)).toEqual(['bots'])
    expect(result.repaired).toEqual([{ name: 'bots', missing: ['bots', 'idx_bots'] }])
    expect(result.inconsistent).toEqual([])
  })

  it('repairs an EARLY migration before the later ones that depend on it', () => {
    const result = plan({
      applied: new Set(['core', 'log', 'bots']),
      ledgerEmpty: false,
      userVersion: 3,
      existingObjects: new Set(['bots', 'idx_bots']),
    })
    expect(result.run.map((m) => m.name)).toEqual(['core', 'log'])
    expect(result.repaired.map((d) => d.name)).toEqual(['core', 'log'])
  })
})

describe('a damaged schema', () => {
  it('refuses a migration whose objects are only PARTLY there', () => {
    const result = plan({
      applied: new Set(['core', 'log']),
      ledgerEmpty: false,
      existingObjects: new Set(['workspaces', 'entries']), // idx_entries gone
    })
    expect(result.inconsistent).toEqual([{ name: 'log', missing: ['idx_entries'] }])
    expect(result.run.map((m) => m.name)).toEqual(['bots'])
    expect(result.repaired).toEqual([])
  })
})

describe('the steady state', () => {
  it('does nothing when the ledger and the schema agree', () => {
    const result = plan({
      applied: new Set(['core', 'log', 'bots']),
      ledgerEmpty: false,
      userVersion: 3,
      existingObjects: new Set(['workspaces', 'entries', 'idx_entries', 'bots', 'idx_bots']),
    })
    expect(result.run).toEqual([])
    expect(result.backfill).toEqual([])
    expect(result.repaired).toEqual([])
    expect(result.inconsistent).toEqual([])
  })

  it('ignores user_version entirely once the ledger exists', () => {
    // A divergent database sits at a HIGHER number than this build's list. The
    // ledger, not the integer, decides — the newer-build refusal is a separate
    // check in `openStateDb`.
    const result = plan({
      applied: new Set(['core']),
      ledgerEmpty: false,
      userVersion: 99,
      existingObjects: new Set(['workspaces']),
    })
    expect(result.run.map((m) => m.name)).toEqual(['log', 'bots'])
  })
})
