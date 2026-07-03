import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { groupThreadsByWorkspace } from './metadata-store'
import { openStateDb, readUserVersion } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The SQLite metadata store (ADR-0019) behind `MetadataStoreApi` — the SAME
 * behavior spec metadata-store.test.ts pins for the JSON engine, re-pointed at
 * `:memory:` databases (plus a temp-dir file where reopen durability is the
 * point). Where the JSON suite asserted "no disk write" via injected fs seams,
 * this one asserts the observable equivalent: no state change.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-sqlite-meta-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function memoryStore(now?: () => number): SqliteMetadataStore {
  return new SqliteMetadataStore({
    stateDb: openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS }),
    ...(now ? { now } : {}),
  })
}

function fileStore(file: string, now?: () => number): SqliteMetadataStore {
  return new SqliteMetadataStore({
    stateDb: openStateDb({ path: join(dir, file), migrations: STATE_MIGRATIONS }),
    ...(now ? { now } : {}),
  })
}

describe('SqliteMetadataStore round-trip', () => {
  it('persists Workspaces + Threads and reads them back through a new instance', async () => {
    const store = fileStore('roundtrip.sqlite')
    await store.load()
    const ws = await store.upsertWorkspace({ dir: '/proj/alpha', displayName: 'alpha' })
    await store.upsertThread({ workspaceId: ws.id, sessionId: 'sess-1', title: 'first' })

    const reopened = fileStore('roundtrip.sqlite')
    await reopened.load()
    const snap = reopened.snapshot()

    expect(snap.workspaces).toHaveLength(1)
    expect(snap.workspaces[0]).toMatchObject({ dir: '/proj/alpha', displayName: 'alpha' })
    expect(snap.threads).toHaveLength(1)
    expect(snap.threads[0]).toMatchObject({ workspaceId: ws.id, sessionId: 'sess-1', title: 'first' })
  })

  it('mints a Thread id distinct from its ACP sessionId, and allows a null sessionId', async () => {
    const store = memoryStore()
    const ws = await store.upsertWorkspace({ dir: '/proj/beta' })

    const bound = await store.upsertThread({ workspaceId: ws.id, sessionId: 'acp-session-xyz' })
    expect(bound.id).not.toBe(bound.sessionId)
    expect(bound.id.length).toBeGreaterThan(0)

    const cold = await store.upsertThread({ workspaceId: ws.id })
    expect(cold.sessionId).toBeNull()
    expect(cold.id).not.toBe(bound.id)
  })

  it('upserts a Workspace by dir (no duplicate), refreshing lastOpenedAt and re-ordering', async () => {
    let clock = 1000
    const store = memoryStore(() => clock)
    const a = await store.upsertWorkspace({ dir: '/proj/a' })
    clock = 2000
    await store.upsertWorkspace({ dir: '/proj/b' })
    clock = 3000
    const aAgain = await store.upsertWorkspace({ dir: '/proj/a' })

    expect(aAgain.id).toBe(a.id)
    expect(aAgain.lastOpenedAt).toBe(3000)
    const dirs = store.snapshot().workspaces.map((w) => w.dir)
    expect(dirs).toEqual(['/proj/a', '/proj/b'])
  })

  it('preserves a Workspace displayName across a re-open upsert that omits it', async () => {
    const store = memoryStore()
    await store.upsertWorkspace({ dir: '/proj/named', displayName: 'Nice Name' })
    const again = await store.upsertWorkspace({ dir: '/proj/named' })
    expect(again.displayName).toBe('Nice Name')
  })

  it('upserts a Thread by id (no duplicate), refreshing lastActiveAt and re-ordering', async () => {
    let clock = 1000
    const store = memoryStore(() => clock)
    const ws = await store.upsertWorkspace({ dir: '/proj/c' })

    clock = 1100
    const t1 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1' })
    clock = 1200
    const t2 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's2' })
    clock = 1300
    const t1Again = await store.upsertThread({ id: t1.id, workspaceId: ws.id, sessionId: 's1b' })

    expect(t1Again.id).toBe(t1.id)
    expect(t1Again.createdAt).toBe(1100)
    expect(t1Again.lastActiveAt).toBe(1300)
    expect(t1Again.sessionId).toBe('s1b')
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([t1.id, t2.id])
  })

  it('touchThread bumps lastActiveAt, re-heads the order, and is durable across reopen', async () => {
    let clock = 1000
    const store = fileStore('touch.sqlite', () => clock)
    const ws = await store.upsertWorkspace({ dir: '/proj/touch' })
    clock = 1100
    const t1 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1', title: 'old' })
    clock = 1200
    const t2 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's2' })

    clock = 1300
    await store.touchThread(t1.id)

    const t1After = store.snapshot().threads.find((t) => t.id === t1.id)
    expect(t1After?.lastActiveAt).toBe(1300)
    expect(t1After?.createdAt).toBe(1100)
    expect(t1After?.title).toBe('old')
    expect(t1After?.sessionId).toBe('s1')
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([t1.id, t2.id])

    const reopened = fileStore('touch.sqlite')
    expect(reopened.snapshot().threads.find((t) => t.id === t1.id)?.lastActiveAt).toBe(1300)
  })

  it('touchThread is a no-op for an unknown id', async () => {
    const store = memoryStore()
    await expect(store.touchThread('nope')).resolves.toBeUndefined()
    expect(store.snapshot().threads).toEqual([])
  })

  it('setThreadTitle renames in place: sets title, holds position, does NOT bump lastActiveAt', async () => {
    let clock = 1000
    const store = memoryStore(() => clock)
    const ws = await store.upsertWorkspace({ dir: '/proj/rename' })
    clock = 1100
    const t1 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1' })
    clock = 1200
    const t2 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's2', pinned: true })

    clock = 9999
    expect(await store.setThreadTitle(t1.id, 'Renamed thread')).toBe(true)

    const t1After = store.snapshot().threads.find((t) => t.id === t1.id)
    expect(t1After?.title).toBe('Renamed thread')
    expect(t1After?.lastActiveAt).toBe(1100)
    expect(t1After?.sessionId).toBe('s1')
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([t2.id, t1.id])
    expect(store.snapshot().threads.find((t) => t.id === t2.id)?.pinned).toBe(true)
  })

  it('setThreadTitle returns false (no change) for an unknown id or unchanged title', async () => {
    const store = memoryStore()
    const ws = await store.upsertWorkspace({ dir: '/proj/noop' })
    const t = await store.upsertThread({ workspaceId: ws.id, title: 'Same' })

    expect(await store.setThreadTitle('no-such-thread', 'X')).toBe(false)
    expect(await store.setThreadTitle(t.id, 'Same')).toBe(false) // absorbs the echo
    expect(store.snapshot().threads.find((x) => x.id === t.id)?.title).toBe('Same')
  })

  it('sets a Thread title by id (auto-title capture) preserving session + createdAt', async () => {
    let clock = 500
    const store = fileStore('title-set.sqlite', () => clock)
    const ws = await store.upsertWorkspace({ dir: '/proj/title' })
    clock = 600
    const t = await store.upsertThread({ workspaceId: ws.id, sessionId: 'sess-x' })
    expect(t.title).toBeNull()

    clock = 700
    const titled = await store.upsertThread({ id: t.id, workspaceId: ws.id, title: 'Fix @auth.py bug' })

    expect(titled.id).toBe(t.id)
    expect(titled.title).toBe('Fix @auth.py bug')
    expect(titled.sessionId).toBe('sess-x')
    expect(titled.createdAt).toBe(600)

    const reopened = fileStore('title-set.sqlite')
    expect(reopened.snapshot().threads.find((x) => x.id === t.id)?.title).toBe('Fix @auth.py bug')
  })

  it('presents an empty index on a fresh database', async () => {
    const store = memoryStore()
    await expect(store.load()).resolves.toBeUndefined()
    expect(store.snapshot()).toEqual({ workspaces: [], threads: [] })
    expect(store.isEmpty()).toBe(true)
  })
})

describe('SqliteMetadataStore fail-closed (ADR-0019, carried from ADR-0005)', () => {
  it('a newer-build database loads empty, locks, and never writes', async () => {
    const path = join(dir, 'future-meta.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 99')
    raw.exec("CREATE TABLE future_data (x); INSERT INTO future_data VALUES ('newer')")
    raw.close()

    const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
    const store = new SqliteMetadataStore({ stateDb })
    await store.load()

    expect(store.isLocked()).toBe(true)
    expect(store.snapshot()).toEqual({ workspaces: [], threads: [] })

    // Mutations are non-durable no-ops; the newer data + version are preserved.
    await store.upsertWorkspace({ dir: '/proj/should-not-persist' })
    await store.touchThread('any')
    expect(await store.setThreadTitle('any', 'x')).toBe(false)
    expect(await store.removeWorkspace('any')).toEqual([])
    expect(store.findThreadIdBySessionId('any')).toBeNull()
    stateDb.close()

    const verify = new DatabaseSync(path)
    expect(readUserVersion(verify)).toBe(99)
    const rows = verify.prepare('SELECT x FROM future_data').all() as unknown as { x: string }[]
    expect(rows).toEqual([{ x: 'newer' }])
    const tables = verify
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
      .all()
    expect(tables).toHaveLength(0) // no schema was created on the locked file
    verify.close()
  })
})

describe('SqliteMetadataStore.deleteThread', () => {
  it('removes a Thread record so it no longer lists, leaving siblings intact (durable)', async () => {
    const store = fileStore('delete-thread.sqlite')
    const ws = await store.upsertWorkspace({ dir: '/proj/del' })
    const keep = await store.upsertThread({ workspaceId: ws.id, sessionId: 'keep' })
    const drop = await store.upsertThread({ workspaceId: ws.id, sessionId: 'drop' })

    await store.deleteThread(drop.id)
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([keep.id])

    const reopened = fileStore('delete-thread.sqlite')
    expect(reopened.snapshot().threads.map((t) => t.id)).toEqual([keep.id])
  })

  it('is a no-op for an unknown id (idempotent, no throw)', async () => {
    const store = memoryStore()
    const ws = await store.upsertWorkspace({ dir: '/proj/del-unknown' })
    const t = await store.upsertThread({ workspaceId: ws.id })

    await expect(store.deleteThread('no-such-thread')).resolves.toBeUndefined()
    await store.deleteThread(t.id)
    await expect(store.deleteThread(t.id)).resolves.toBeUndefined()
    expect(store.snapshot().threads).toEqual([])
  })
})

describe('SqliteMetadataStore.removeWorkspace', () => {
  it('removes the Workspace + all its Threads (FK cascade) and returns their ids', async () => {
    const store = fileStore('remove-ws.sqlite')
    const ws = await store.upsertWorkspace({ dir: '/proj/rm' })
    const t1 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1' })
    const t2 = await store.upsertThread({ workspaceId: ws.id, sessionId: 's2' })

    const removed = await store.removeWorkspace(ws.id)

    expect(removed).toEqual(expect.arrayContaining([t1.id, t2.id]))
    expect(removed).toHaveLength(2)
    expect(store.snapshot()).toEqual({ workspaces: [], threads: [] })

    const reopened = fileStore('remove-ws.sqlite')
    expect(reopened.snapshot()).toEqual({ workspaces: [], threads: [] })
  })

  it('leaves other Workspaces and their Threads intact', async () => {
    const store = memoryStore()
    const drop = await store.upsertWorkspace({ dir: '/proj/drop' })
    const keep = await store.upsertWorkspace({ dir: '/proj/keep' })
    const dropThread = await store.upsertThread({ workspaceId: drop.id })
    const keepThread = await store.upsertThread({ workspaceId: keep.id })

    const removed = await store.removeWorkspace(drop.id)

    expect(removed).toEqual([dropThread.id])
    expect(store.snapshot().workspaces.map((w) => w.id)).toEqual([keep.id])
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([keepThread.id])
  })

  it('is a no-op for an unknown id — returns [] and changes nothing', async () => {
    const store = memoryStore()
    await store.upsertWorkspace({ dir: '/proj/present' })
    await expect(store.removeWorkspace('no-such-workspace')).resolves.toEqual([])
    expect(store.snapshot().workspaces).toHaveLength(1)
  })
})

describe('SqliteMetadataStore.setThreadFlags (#132 pin / #133 archive)', () => {
  it('patches only the passed flag, leaving the other untouched, and round-trips', async () => {
    const store = fileStore('flags.sqlite')
    const ws = await store.upsertWorkspace({ dir: '/proj/flags' })
    const t = await store.upsertThread({ workspaceId: ws.id, sessionId: 's1' })

    await store.setThreadFlags(t.id, { pinned: true })
    let rec = store.snapshot().threads.find((x) => x.id === t.id)
    expect(rec?.pinned).toBe(true)
    expect(rec?.archived).toBeUndefined() // never set — stays undefined, not false

    await store.setThreadFlags(t.id, { archived: true })
    rec = store.snapshot().threads.find((x) => x.id === t.id)
    expect(rec?.pinned).toBe(true)
    expect(rec?.archived).toBe(true)

    const reopened = fileStore('flags.sqlite')
    const back = reopened.snapshot().threads.find((x) => x.id === t.id)
    expect(back?.pinned).toBe(true)
    expect(back?.archived).toBe(true)

    // Unpin clears just that flag — and an explicit false reads back as false.
    await reopened.setThreadFlags(t.id, { pinned: false })
    expect(reopened.snapshot().threads.find((x) => x.id === t.id)?.pinned).toBe(false)
    expect(reopened.snapshot().threads.find((x) => x.id === t.id)?.archived).toBe(true)
  })

  it('holds the record list POSITION (a flag toggle is not activity)', async () => {
    let clock = 1000
    const store = memoryStore(() => clock)
    const ws = await store.upsertWorkspace({ dir: '/proj/flags-order' })
    clock = 1100
    const t1 = await store.upsertThread({ workspaceId: ws.id })
    clock = 1200
    const t2 = await store.upsertThread({ workspaceId: ws.id })

    await store.setThreadFlags(t1.id, { pinned: true })
    expect(store.snapshot().threads.map((t) => t.id)).toEqual([t2.id, t1.id])
  })

  it('is a no-op for an unknown id (no throw)', async () => {
    const store = memoryStore()
    await expect(store.setThreadFlags('no-such-thread', { pinned: true })).resolves.toBeUndefined()
    expect(store.snapshot().threads).toEqual([])
  })

  it('upsertThread PRESERVES pinned/archived across a routine activity re-target', async () => {
    const store = memoryStore()
    const ws = await store.upsertWorkspace({ dir: '/proj/flags-preserve' })
    const t = await store.upsertThread({ workspaceId: ws.id })
    await store.setThreadFlags(t.id, { pinned: true, archived: true })

    const again = await store.upsertThread({ id: t.id, workspaceId: ws.id, sessionId: 's-new' })
    expect(again.pinned).toBe(true)
    expect(again.archived).toBe(true)
  })
})

describe('findThreadIdBySessionId (transcript routing)', () => {
  it('resolves the minted Thread id from its bound ACP sessionId, else null', async () => {
    const store = memoryStore()
    const ws = await store.upsertWorkspace({ dir: '/proj/route' })
    const bound = await store.upsertThread({ workspaceId: ws.id, sessionId: 'sess-route' })
    await store.upsertThread({ workspaceId: ws.id }) // null session — must not match

    expect(store.findThreadIdBySessionId('sess-route')).toBe(bound.id)
    expect(store.findThreadIdBySessionId('no-such-session')).toBeNull()
    expect(store.findThreadIdBySessionId(null)).toBeNull()
  })
})

describe('SqliteMetadataStore.importSnapshot (one-time legacy import)', () => {
  it('imports records VERBATIM — ids, timestamps, flags, nulls preserved', async () => {
    const store = memoryStore()
    store.importSnapshot({
      workspaces: [{ id: 'w1', dir: '/legacy', displayName: 'L', lastOpenedAt: 5 }],
      threads: [
        { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 2 },
        {
          id: 't2',
          workspaceId: 'w1',
          sessionId: 'sess-2',
          title: 'kept',
          createdAt: 3,
          lastActiveAt: 4,
          pinned: true,
        },
      ],
    })

    const snap = store.snapshot()
    expect(snap.workspaces).toEqual([{ id: 'w1', dir: '/legacy', displayName: 'L', lastOpenedAt: 5 }])
    expect(snap.threads.map((t) => t.id)).toEqual(['t2', 't1']) // recent-first
    const t2 = snap.threads.find((t) => t.id === 't2')
    expect(t2).toMatchObject({ sessionId: 'sess-2', title: 'kept', createdAt: 3, pinned: true })
    expect(t2?.archived).toBeUndefined()
    expect(store.isEmpty()).toBe(false)
    // The renderer's grouped launch list works off the imported rows.
    expect(groupThreadsByWorkspace(snap)[0].threads).toHaveLength(2)
  })

  it('drops orphan Threads (Workspace record lost) instead of failing the import', async () => {
    const store = memoryStore()
    store.importSnapshot({
      workspaces: [{ id: 'w1', dir: '/a', displayName: 'a', lastOpenedAt: 1 }],
      threads: [
        { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 1 },
        { id: 'tOrphan', workspaceId: 'gone', sessionId: null, title: null, createdAt: 2, lastActiveAt: 2 },
      ],
    })
    expect(store.snapshot().threads.map((t) => t.id)).toEqual(['t1'])
  })

  it('rolls back to an empty database when the import fails mid-way', async () => {
    const store = memoryStore()
    expect(() =>
      store.importSnapshot({
        workspaces: [{ id: 'w1', dir: '/a', displayName: 'a', lastOpenedAt: 1 }],
        threads: [
          { id: 'dup', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 1 },
          { id: 'dup', workspaceId: 'w1', sessionId: null, title: null, createdAt: 2, lastActiveAt: 2 },
        ],
      }),
    ).toThrow()
    expect(store.isEmpty()).toBe(true) // the transaction rolled everything back
  })
})
