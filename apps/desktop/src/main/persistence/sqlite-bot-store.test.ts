import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStateDb, readUserVersion, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteBotStore } from './sqlite-bot-store'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The Mistro Bot store (#445, ADR-0027) on the same `state.sqlite` as everything
 * else — mirroring `sqlite-metadata-store.test.ts`: `:memory:` databases for
 * behaviour, a temp-dir file where reopen durability is the point.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-sqlite-bots-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const PROFILE_ID = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

interface Fixture {
  stateDb: StateDb
  meta: SqliteMetadataStore
  bots: SqliteBotStore
}

function openFixture(path = ':memory:', now?: () => number): Fixture {
  const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
  return {
    stateDb,
    meta: new SqliteMetadataStore({ stateDb }),
    bots: new SqliteBotStore({ stateDb, ...(now ? { now } : {}) }),
  }
}

/** A Workspace + a Thread for a Bot to be keyed to. */
async function seedThread(f: Fixture, dirPath = '/proj/alpha') {
  const ws = await f.meta.upsertWorkspace({ dir: dirPath })
  const thread = await f.meta.upsertThread({ workspaceId: ws.id })
  return { workspaceId: ws.id, threadId: thread.id }
}

function insertBot(f: Fixture, ids: { workspaceId: string; threadId: string }, name = 'Rex') {
  return f.bots.insert({
    ...ids,
    profileId: `${PROFILE_ID.slice(0, -1)}${name.length}`,
    name,
    colour: '#e8734a',
    description: 'Reviews my diffs',
    instructions: 'Read the diff first.',
  })
}

describe('the bots migration', () => {
  it('brings a fresh database to the latest user_version with a bots table', () => {
    const f = openFixture()
    expect(readUserVersion(f.stateDb.db)).toBe(STATE_MIGRATIONS[STATE_MIGRATIONS.length - 1].id)
    expect(() => f.stateDb.db.prepare('SELECT * FROM bots').all()).not.toThrow()
  })

  it('is appended, never reordered — ids stay strictly increasing from 1', () => {
    expect(STATE_MIGRATIONS.map((m) => m.id)).toEqual(STATE_MIGRATIONS.map((_, i) => i + 1))
  })
})

describe('SqliteBotStore round-trip', () => {
  it('persists a Bot and reads it back through a new instance', async () => {
    const path = join(dir, 'roundtrip.sqlite')
    const f = openFixture(path)
    const ids = await seedThread(f)
    insertBot(f, ids)

    const reopened = openFixture(path)
    const [bot] = reopened.bots.list()
    expect(bot).toMatchObject({
      threadId: ids.threadId,
      workspaceId: ids.workspaceId,
      name: 'Rex',
      colour: '#e8734a',
      description: 'Reviews my diffs',
      instructions: 'Read the diff first.',
    })
  })

  it('returns the DURABLE profile_id with the Bot — without it a reopened Bot has no persona', async () => {
    const path = join(dir, 'profile-id.sqlite')
    const f = openFixture(path)
    const ids = await seedThread(f)
    const created = insertBot(f, ids)

    const reopened = openFixture(path)
    expect(reopened.bots.get(ids.threadId)?.profileId).toBe(created?.profileId)
  })

  it('stamps createdAt/updatedAt from the injected clock', async () => {
    let clock = 1000
    const f = openFixture(':memory:', () => clock)
    const ids = await seedThread(f)
    const created = insertBot(f, ids)
    expect(created).toMatchObject({ createdAt: 1000, updatedAt: 1000 })

    clock = 2000
    const updated = f.bots.update(ids.threadId, { name: 'Rexina' })
    expect(updated).toMatchObject({ createdAt: 1000, updatedAt: 2000 })
  })
})

describe('SqliteBotStore CRUD', () => {
  it('reads one Bot by its Thread, and null for a Thread that is not a Bot', async () => {
    const f = openFixture()
    const ids = await seedThread(f)
    insertBot(f, ids)
    const plain = await f.meta.upsertThread({ workspaceId: ids.workspaceId })

    expect(f.bots.get(ids.threadId)?.name).toBe('Rex')
    expect(f.bots.get(plain.id)).toBeNull()
    expect(f.bots.get('nope')).toBeNull()
  })

  it('lists a Project’s Bots, most-recently-updated first', async () => {
    let clock = 1000
    const f = openFixture(':memory:', () => clock)
    const a = await seedThread(f, '/proj/a')
    insertBot(f, a, 'Rex')
    clock = 2000
    const b = await f.meta.upsertThread({ workspaceId: a.workspaceId })
    insertBot(f, { workspaceId: a.workspaceId, threadId: b.id }, 'Scribe')
    clock = 3000
    const other = await seedThread(f, '/proj/other')
    insertBot(f, other, 'Mise')

    expect(f.bots.listByWorkspace(a.workspaceId).map((x) => x.name)).toEqual(['Scribe', 'Rex'])
    expect(f.bots.listByWorkspace(other.workspaceId).map((x) => x.name)).toEqual(['Mise'])
    expect(f.bots.listByWorkspace('nope')).toEqual([])
  })

  it('patches only the fields given, and NEVER the profile id', async () => {
    const f = openFixture()
    const ids = await seedThread(f)
    const created = insertBot(f, ids)

    const renamed = f.bots.update(ids.threadId, { name: 'Rexina' })
    expect(renamed).toMatchObject({
      name: 'Rexina',
      colour: '#e8734a',
      description: 'Reviews my diffs',
      profileId: created?.profileId,
    })
    expect(f.bots.get(ids.threadId)?.profileId).toBe(created?.profileId)
  })

  it('reports an unknown Bot on update/delete rather than throwing', async () => {
    const f = openFixture()
    expect(f.bots.update('nope', { name: 'x' })).toBeNull()
    expect(f.bots.delete('nope')).toBe(false)
  })

  it('deletes the Bot row while leaving its Thread standing (the conversation survives)', async () => {
    const f = openFixture()
    const ids = await seedThread(f)
    insertBot(f, ids)

    expect(f.bots.delete(ids.threadId)).toBe(true)
    expect(f.bots.get(ids.threadId)).toBeNull()
    expect(f.meta.snapshot().threads.map((t) => t.id)).toContain(ids.threadId)
  })

  it('refuses a Bot on a Thread that does not exist (the FK), reported not thrown', async () => {
    const f = openFixture()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(insertBot(f, { workspaceId: 'ghost-ws', threadId: 'ghost-thread' })).toBeNull()
    spy.mockRestore()
  })

  it('refuses a duplicate profile id — two Bots can never name the same files', async () => {
    const f = openFixture()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await seedThread(f, '/proj/a')
    const second = await f.meta.upsertThread({ workspaceId: a.workspaceId })
    f.bots.insert({ ...a, profileId: PROFILE_ID, name: 'Rex', colour: '#fff', description: '', instructions: '' })
    const clash = f.bots.insert({
      workspaceId: a.workspaceId,
      threadId: second.id,
      profileId: PROFILE_ID,
      name: 'Scribe',
      colour: '#fff',
      description: '',
      instructions: '',
    })
    expect(clash).toBeNull()
    spy.mockRestore()
  })
})

describe('SqliteBotStore cascades', () => {
  it('drops the Bot row with its Thread', async () => {
    const f = openFixture()
    const ids = await seedThread(f)
    insertBot(f, ids)

    await f.meta.deleteThread(ids.threadId)
    expect(f.bots.get(ids.threadId)).toBeNull()
    expect(f.bots.list()).toEqual([])
  })

  it('drops every Bot row with its Workspace, and reports the Thread ids that took them', async () => {
    const f = openFixture()
    const ids = await seedThread(f)
    insertBot(f, ids)
    const kept = await seedThread(f, '/proj/kept')
    insertBot(f, kept, 'Scribe')

    // The read that must happen BEFORE the removal — afterwards the rows are gone.
    const doomed = f.bots.listByWorkspace(ids.workspaceId)
    const removedThreadIds = await f.meta.removeWorkspace(ids.workspaceId)

    expect(doomed.map((b) => b.threadId)).toEqual([ids.threadId])
    expect(removedThreadIds).toContain(ids.threadId)
    expect(f.bots.list().map((b) => b.name)).toEqual(['Scribe'])
  })
})

describe('deleting a Bot keeps its conversation (#447, ADR-0027)', () => {
  it('drops the Bot row and ARCHIVES its Thread rather than deleting it', async () => {
    // The real stores, not the lifecycle's fakes: the guarantee that matters is
    // that weeks of irreplaceable history survive the loss of a teammate, and that
    // is a property of the ROWS. `deleteBot` performs exactly these two writes.
    const f = openFixture()
    const ids = await seedThread(f)
    insertBot(f, ids)

    expect(f.bots.delete(ids.threadId)).toBe(true)
    await f.meta.setThreadFlags(ids.threadId, { archived: true })

    expect(f.bots.get(ids.threadId)).toBeNull()
    const thread = f.meta.snapshot().threads.find((t) => t.id === ids.threadId)
    expect(thread).toBeDefined()
    expect(thread?.archived).toBe(true)
  })
})

describe('"Start over" retires only the session cursor (#447)', () => {
  it('clears session_id and leaves the Thread, its title and its Bot row intact', async () => {
    const f = openFixture()
    const ws = await f.meta.upsertWorkspace({ dir: '/proj/start-over' })
    const thread = await f.meta.upsertThread({ workspaceId: ws.id, sessionId: 'sess-old' })
    await f.meta.setThreadTitle(thread.id, 'Weeks of history')
    insertBot(f, { workspaceId: ws.id, threadId: thread.id })

    await f.meta.clearThreadSession(thread.id)

    const after = f.meta.snapshot().threads.find((t) => t.id === thread.id)
    expect(after?.sessionId).toBeNull()
    expect(after?.title).toBe('Weeks of history')
    expect(f.bots.get(thread.id)?.name).toBe('Rex')
  })
})

describe('SqliteBotStore on a LOCKED database', () => {
  function lockedFixture(): Fixture {
    // A db written by a NEWER build: bump user_version past our latest, reopen.
    const path = join(dir, 'locked.sqlite')
    const seeded = openStateDb({ path, migrations: STATE_MIGRATIONS })
    seeded.db.exec(`PRAGMA user_version = ${STATE_MIGRATIONS.length + 50}`)
    seeded.close()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fixture = openFixture(path)
    spy.mockRestore()
    return fixture
  }

  it('presents empty and writes nothing, exactly like the metadata store', () => {
    const f = lockedFixture()
    expect(f.stateDb.locked).toBe(true)
    expect(f.bots.list()).toEqual([])
    expect(f.bots.listByWorkspace('ws')).toEqual([])
    expect(f.bots.get('t')).toBeNull()
    expect(
      f.bots.insert({
        threadId: 't',
        workspaceId: 'ws',
        profileId: PROFILE_ID,
        name: 'Rex',
        colour: '#fff',
        description: '',
        instructions: '',
      }),
    ).toBeNull()
    expect(f.bots.update('t', { name: 'x' })).toBeNull()
    expect(f.bots.delete('t')).toBe(false)
  })
})
