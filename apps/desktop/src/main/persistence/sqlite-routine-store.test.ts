import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ROUTINES_PER_BOT } from '../../shared/routine-limits'
import type { RoutineSchedule } from '../../shared/schedule'
import { openStateDb, readUserVersion, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteBotStore } from './sqlite-bot-store'
import { SqliteRoutineStore } from './sqlite-routine-store'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The Routine store (#467, ADR-0028) on the same `state.sqlite` as everything
 * else — mirroring `sqlite-bot-store.test.ts`: `:memory:` databases for
 * behaviour, a temp-dir file where reopen durability is the point.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-sqlite-routines-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const DAILY: RoutineSchedule = { kind: 'daily', at: '09:00', timezone: 'America/New_York' }

interface Fixture {
  stateDb: StateDb
  meta: SqliteMetadataStore
  bots: SqliteBotStore
  routines: SqliteRoutineStore
}

function openFixture(path = ':memory:', now?: () => number): Fixture {
  const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
  const clock = now ? { now } : {}
  return {
    stateDb,
    meta: new SqliteMetadataStore({ stateDb }),
    bots: new SqliteBotStore({ stateDb, ...clock }),
    routines: new SqliteRoutineStore({ stateDb, ...clock }),
  }
}

/** A Workspace + a Thread + the Bot row a Routine hangs off. */
async function seedBot(f: Fixture, dirPath = '/proj/alpha', name = 'Rex') {
  const ws = await f.meta.upsertWorkspace({ dir: dirPath })
  const thread = await f.meta.upsertThread({ workspaceId: ws.id })
  f.bots.insert({
    threadId: thread.id,
    workspaceId: ws.id,
    profileId: `mistro-bot-${thread.id}`,
    name,
    colour: '#e8734a',
    description: '',
    instructions: '',
  })
  return { workspaceId: ws.id, threadId: thread.id }
}

function insertRoutine(
  f: Fixture,
  threadId: string,
  id = 'routine-1',
  overrides: Partial<{ name: string; schedule: RoutineSchedule; allowedCommands: string[] }> = {},
) {
  return f.routines.insert({
    id,
    threadId,
    name: overrides.name ?? 'Morning triage',
    prompt: 'Triage this repo’s issues and say what changed.',
    schedule: overrides.schedule ?? DAILY,
    allowedCommands: overrides.allowedCommands ?? ['gh issue list --state open'],
    active: true,
  })
}

describe('the routines migration', () => {
  it('brings a fresh database to the latest user_version with a routines table', () => {
    const f = openFixture()
    expect(readUserVersion(f.stateDb.db)).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1].id)
    expect(() => f.stateDb.db.prepare('SELECT * FROM routines').all()).not.toThrow()
  })

  it('is appended, never reordered — ids stay strictly increasing from 1', () => {
    expect(STATE_MIGRATIONS.map((m) => m.id)).toEqual(STATE_MIGRATIONS.map((_, i) => i + 1))
  })

  it('has NO next-run column — the next fire is derived, never stored (ADR-0028 part 6)', () => {
    const f = openFixture()
    const columns = (
      f.stateDb.db.prepare('PRAGMA table_info(routines)').all() as unknown as { name: string }[]
    ).map((column) => column.name)
    expect(columns).not.toContain('next_run_at')
    expect(columns).toEqual(
      expect.arrayContaining(['last_run_at', 'last_outcome', 'last_error', 'active']),
    )
  })
})

describe('SqliteRoutineStore round-trip', () => {
  it('persists a Routine and reads it back through a new instance', async () => {
    const path = join(dir, 'roundtrip.sqlite')
    const f = openFixture(path)
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId)

    const reopened = openFixture(path)
    const [routine] = reopened.routines.list()
    expect(routine).toMatchObject({
      id: 'routine-1',
      threadId: bot.threadId,
      name: 'Morning triage',
      schedule: DAILY,
      allowedCommands: ['gh issue list --state open'],
      active: true,
      lastRunAt: null,
      lastOutcome: null,
      lastError: null,
    })
  })

  it('round-trips a weekly schedule with its weekday intact', async () => {
    const weekly: RoutineSchedule = {
      kind: 'weekly',
      at: '17:00',
      weekday: 5,
      timezone: 'Europe/Berlin',
    }
    const f = openFixture()
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId, 'weekly-1', { schedule: weekly })
    expect(f.routines.get('weekly-1')?.schedule).toEqual(weekly)
  })

  it('stamps createdAt/updatedAt from the injected clock', async () => {
    let clock = 1000
    const f = openFixture(':memory:', () => clock)
    const bot = await seedBot(f)
    expect(insertRoutine(f, bot.threadId)).toMatchObject({ createdAt: 1000, updatedAt: 1000 })

    clock = 2000
    expect(f.routines.update('routine-1', { name: 'Renamed' })).toMatchObject({
      createdAt: 1000,
      updatedAt: 2000,
    })
  })
})

describe('SqliteRoutineStore CRUD', () => {
  it('lists one Bot’s Routines oldest-first, and only that Bot’s', async () => {
    let clock = 1000
    const f = openFixture(':memory:', () => clock)
    const a = await seedBot(f, '/proj/a', 'Rex')
    insertRoutine(f, a.threadId, 'a1', { name: 'First' })
    clock = 2000
    insertRoutine(f, a.threadId, 'a2', { name: 'Second' })
    clock = 3000
    const b = await seedBot(f, '/proj/b', 'Scribe')
    insertRoutine(f, b.threadId, 'b1', { name: 'Other' })

    expect(f.routines.listByBot(a.threadId).map((r) => r.name)).toEqual(['First', 'Second'])
    expect(f.routines.listByBot(b.threadId).map((r) => r.name)).toEqual(['Other'])
    expect(f.routines.listByBot('nope')).toEqual([])
    expect(f.routines.list()).toHaveLength(3)
  })

  it('patches only the fields given', async () => {
    const f = openFixture()
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId)

    const paused = f.routines.update('routine-1', { active: false })
    expect(paused).toMatchObject({
      active: false,
      name: 'Morning triage',
      schedule: DAILY,
      allowedCommands: ['gh issue list --state open'],
    })
    expect(f.routines.get('routine-1')?.active).toBe(false)
  })

  it('records how a run ended, and clears the failure a success recovered from', async () => {
    const f = openFixture()
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId)

    const blocked = f.routines.recordRun('routine-1', {
      lastRunAt: 1700,
      lastOutcome: 'blocked',
      lastError: 'rm -rf build is not an allowed command',
    })
    expect(blocked).toMatchObject({
      lastRunAt: 1700,
      lastOutcome: 'blocked',
      lastError: 'rm -rf build is not an allowed command',
    })

    const recovered = f.routines.recordRun('routine-1', { lastRunAt: 1800, lastOutcome: 'ok' })
    expect(recovered).toMatchObject({ lastRunAt: 1800, lastOutcome: 'ok', lastError: null })
  })

  it('reports an unknown Routine rather than throwing', async () => {
    const f = openFixture()
    expect(f.routines.get('nope')).toBeNull()
    expect(f.routines.update('nope', { active: false })).toBeNull()
    expect(f.routines.recordRun('nope', { lastRunAt: 1, lastOutcome: 'ok' })).toBeNull()
    expect(f.routines.delete('nope')).toBe(false)
  })

  it('deletes one Routine and leaves the Bot and its other Routines standing', async () => {
    const f = openFixture()
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId, 'keep', { name: 'Keep' })
    insertRoutine(f, bot.threadId, 'drop', { name: 'Drop' })

    expect(f.routines.delete('drop')).toBe(true)
    expect(f.routines.listByBot(bot.threadId).map((r) => r.name)).toEqual(['Keep'])
    expect(f.bots.get(bot.threadId)?.name).toBe('Rex')
  })

  it('refuses a Routine on a Thread that is not a Bot (the FK), reported not thrown', async () => {
    const f = openFixture()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ws = await f.meta.upsertWorkspace({ dir: '/proj/plain' })
    const plain = await f.meta.upsertThread({ workspaceId: ws.id })
    expect(insertRoutine(f, plain.id)).toBeNull()
    expect(insertRoutine(f, 'ghost-thread', 'ghost')).toBeNull()
    spy.mockRestore()
  })

  it('skips a row whose stored schedule is unreadable rather than inventing one', async () => {
    const f = openFixture()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId, 'good')
    insertRoutine(f, bot.threadId, 'garbled')
    // Only a hand-edited database produces this; the store must not carry it.
    f.stateDb.db.prepare('UPDATE routines SET schedule = ? WHERE id = ?').run('{oops', 'garbled')

    expect(f.routines.list().map((r) => r.id)).toEqual(['good'])
    expect(f.routines.get('garbled')).toBeNull()
    spy.mockRestore()
  })
})

describe(`the ${MAX_ROUTINES_PER_BOT}-per-Bot cap (ADR-0028 part 1)`, () => {
  it(`accepts ${MAX_ROUTINES_PER_BOT} and refuses the next one`, async () => {
    const f = openFixture()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bot = await seedBot(f)
    for (let i = 0; i < MAX_ROUTINES_PER_BOT; i += 1) {
      expect(insertRoutine(f, bot.threadId, `r${i}`, { name: `Routine ${i}` })).not.toBeNull()
    }
    expect(insertRoutine(f, bot.threadId, 'one-too-many')).toBeNull()
    expect(f.routines.listByBot(bot.threadId)).toHaveLength(MAX_ROUTINES_PER_BOT)
    spy.mockRestore()
  })

  it('counts per Bot, not globally, and frees a slot when one is deleted', async () => {
    const f = openFixture()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await seedBot(f, '/proj/a', 'Rex')
    const b = await seedBot(f, '/proj/b', 'Scribe')
    for (let i = 0; i < MAX_ROUTINES_PER_BOT; i += 1) insertRoutine(f, a.threadId, `a${i}`)

    // A different Bot is unaffected by the first one being full.
    expect(insertRoutine(f, b.threadId, 'b0')).not.toBeNull()
    expect(insertRoutine(f, a.threadId, 'a-extra')).toBeNull()

    f.routines.delete('a0')
    expect(insertRoutine(f, a.threadId, 'a-extra')).not.toBeNull()
    spy.mockRestore()
  })
})

describe('SqliteRoutineStore cascades', () => {
  it('drops a Bot’s Routines when the BOT is deleted (the Thread survives)', async () => {
    const f = openFixture()
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId)

    // `bots:delete` drops the Bot row and archives the Thread — the Routines
    // must go with the teammate, not linger on the archived conversation.
    expect(f.bots.delete(bot.threadId)).toBe(true)
    expect(f.routines.list()).toEqual([])
    expect(f.meta.snapshot().threads.map((t) => t.id)).toContain(bot.threadId)
  })

  it('drops them with the Thread', async () => {
    const f = openFixture()
    const bot = await seedBot(f)
    insertRoutine(f, bot.threadId)

    await f.meta.deleteThread(bot.threadId)
    expect(f.routines.list()).toEqual([])
  })

  it('drops them with the WORKSPACE, leaving another Project’s untouched', async () => {
    const f = openFixture()
    const doomed = await seedBot(f, '/proj/doomed', 'Rex')
    const kept = await seedBot(f, '/proj/kept', 'Scribe')
    insertRoutine(f, doomed.threadId, 'doomed-1')
    insertRoutine(f, kept.threadId, 'kept-1')

    await f.meta.removeWorkspace(doomed.workspaceId)
    expect(f.routines.list().map((r) => r.id)).toEqual(['kept-1'])
  })
})

describe('SqliteRoutineStore on a LOCKED database', () => {
  function lockedFixture(): Fixture {
    const path = join(dir, 'locked.sqlite')
    const seeded = openStateDb({ path, migrations: STATE_MIGRATIONS })
    seeded.db.exec(`PRAGMA user_version = ${STATE_MIGRATIONS.length + 50}`)
    seeded.close()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixture = openFixture(path)
    spy.mockRestore()
    return fixture
  }

  it('presents empty and writes nothing — a Routine that cannot be read must not fire', () => {
    const f = lockedFixture()
    expect(f.stateDb.locked).toBe(true)
    expect(f.routines.list()).toEqual([])
    expect(f.routines.listByBot('t')).toEqual([])
    expect(f.routines.get('r')).toBeNull()
    expect(
      f.routines.insert({
        id: 'r',
        threadId: 't',
        name: 'Morning triage',
        prompt: 'go',
        schedule: DAILY,
        allowedCommands: [],
        active: true,
      }),
    ).toBeNull()
    expect(f.routines.update('r', { active: false })).toBeNull()
    expect(f.routines.recordRun('r', { lastRunAt: 1, lastOutcome: 'ok' })).toBeNull()
    expect(f.routines.delete('r')).toBe(false)
  })
})
