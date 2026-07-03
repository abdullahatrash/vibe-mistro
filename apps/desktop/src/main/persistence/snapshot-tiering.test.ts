import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStateDb, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import { STATE_MIGRATIONS } from './state-migrations'
import { turnCompleteEntry, userPromptEntry } from './transcript'

/**
 * The durable fold-snapshot tiering (ADR-0019, #297): `readWithSnapshot` /
 * `putSnapshot` on the SQLite store — version gating, horizon math, regression
 * refusal, cascade cleanup, fail-closed — plus the legacy engine's trivial
 * no-snapshot behavior behind the same seam.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-snapshot-tiering-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const V = 1 // the reducer version under test

interface Fixture {
  stateDb: StateDb
  meta: SqliteMetadataStore
  store: SqliteTranscriptStore
  threadId: string
}

async function fixture(): Promise<Fixture> {
  const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
  const meta = new SqliteMetadataStore({ stateDb })
  const store = new SqliteTranscriptStore({ stateDb })
  const ws = await meta.upsertWorkspace({ dir: '/proj/x' })
  const thread = await meta.upsertThread({ workspaceId: ws.id })
  return { stateDb, meta, store, threadId: thread.id }
}

describe('SqliteTranscriptStore.readWithSnapshot', () => {
  it('with no stored snapshot: the whole log as the tail, lastSeq = the horizon', async () => {
    const { store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'one'))
    await store.append(threadId, turnCompleteEntry())

    const result = await store.readWithSnapshot(threadId, V)

    expect(result.snapshot).toBeNull()
    expect(result.tail).toEqual([userPromptEntry('u1', 'one'), turnCompleteEntry()])
    expect(result.lastSeq).toBeGreaterThan(0)
  })

  it('an empty log reads { null, [], 0 }', async () => {
    const { store, threadId } = await fixture()
    expect(await store.readWithSnapshot(threadId, V)).toEqual({
      snapshot: null,
      tail: [],
      lastSeq: 0,
    })
  })

  it('put then read: the snapshot returns with an EMPTY tail (the O(1) reopen)', async () => {
    const { store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'one'))
    const first = await store.readWithSnapshot(threadId, V)
    await store.putSnapshot({
      threadId,
      reducerVersion: V,
      lastSeq: first.lastSeq,
      state: '{"folded":true}',
    })

    const result = await store.readWithSnapshot(threadId, V)

    expect(result.snapshot).toEqual({ state: '{"folded":true}', lastSeq: first.lastSeq })
    expect(result.tail).toEqual([]) // nothing beyond the horizon
    expect(result.lastSeq).toBe(first.lastSeq)
  })

  it('entries appended AFTER the snapshot return as the tail beyond its horizon', async () => {
    const { store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'covered'))
    const first = await store.readWithSnapshot(threadId, V)
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: first.lastSeq, state: '{}' })

    await store.append(threadId, userPromptEntry('u2', 'newer'))
    await store.append(threadId, turnCompleteEntry())

    const result = await store.readWithSnapshot(threadId, V)
    expect(result.snapshot?.lastSeq).toBe(first.lastSeq)
    expect(result.tail).toEqual([userPromptEntry('u2', 'newer'), turnCompleteEntry()])
    expect(result.lastSeq).toBeGreaterThan(first.lastSeq)
  })

  it('a version-MISMATCHED snapshot is ignored, DELETED, and the full log returns', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'text'))
    const first = await store.readWithSnapshot(threadId, V)
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: first.lastSeq, state: '{}' })

    const result = await store.readWithSnapshot(threadId, V + 1) // "the app upgraded"

    expect(result.snapshot).toBeNull()
    expect(result.tail).toEqual([userPromptEntry('u1', 'text')]) // full fold path
    // The stale projection is gone — disposable by design.
    const rows = stateDb.db.prepare('SELECT COUNT(*) AS n FROM thread_snapshots').get() as {
      n: number
    }
    expect(rows.n).toBe(0)
  })

  it('forceFull bypasses a valid snapshot (corruption fallback) but KEEPS the row', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'text'))
    const first = await store.readWithSnapshot(threadId, V)
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: first.lastSeq, state: '{}' })

    const result = await store.readWithSnapshot(threadId, V, true)

    expect(result.snapshot).toBeNull()
    expect(result.tail).toEqual([userPromptEntry('u1', 'text')])
    // Same-version row survives — the next healthy put simply overwrites it.
    const rows = stateDb.db.prepare('SELECT COUNT(*) AS n FROM thread_snapshots').get() as {
      n: number
    }
    expect(rows.n).toBe(1)
  })
})

describe('SqliteTranscriptStore.putSnapshot', () => {
  it('refuses a horizon REGRESSION at the same version (a stale racer cannot clobber)', async () => {
    const { store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'one'))
    const horizon = (await store.readWithSnapshot(threadId, V)).lastSeq
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: horizon, state: '{"new":1}' })

    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: horizon - 1, state: '{"old":1}' })

    const result = await store.readWithSnapshot(threadId, V)
    expect(result.snapshot?.state).toBe('{"new":1}') // the newer horizon won
  })

  it('accepts a DIFFERENT-version put regardless of horizon (the bump path)', async () => {
    const { store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'one'))
    const horizon = (await store.readWithSnapshot(threadId, V)).lastSeq
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: horizon, state: '{"v1":1}' })

    await store.putSnapshot({ threadId, reducerVersion: V + 1, lastSeq: horizon, state: '{"v2":1}' })

    expect((await store.readWithSnapshot(threadId, V + 1)).snapshot?.state).toBe('{"v2":1}')
  })

  it('swallows a put for an unknown Thread (FK) and refuses empty/negative args', async () => {
    const { store, threadId } = await fixture()
    await expect(
      store.putSnapshot({ threadId: 'nope', reducerVersion: V, lastSeq: 1, state: '{}' }),
    ).resolves.toBeUndefined()
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: -1, state: '{}' })
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: 1, state: '' })
    expect((await store.readWithSnapshot(threadId, V)).snapshot).toBeNull()
  })
})

describe('snapshot cleanup + fail-closed', () => {
  it('deleting the Thread metadata row cascades the snapshot away', async () => {
    const { stateDb, meta, store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'x'))
    const h = (await store.readWithSnapshot(threadId, V)).lastSeq
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: h, state: '{}' })

    await meta.deleteThread(threadId)

    const rows = stateDb.db.prepare('SELECT COUNT(*) AS n FROM thread_snapshots').get() as {
      n: number
    }
    expect(rows.n).toBe(0)
  })

  it("the store's own delete clears the snapshot too", async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'x'))
    const h = (await store.readWithSnapshot(threadId, V)).lastSeq
    await store.putSnapshot({ threadId, reducerVersion: V, lastSeq: h, state: '{}' })

    await store.delete(threadId)

    const rows = stateDb.db.prepare('SELECT COUNT(*) AS n FROM thread_snapshots').get() as {
      n: number
    }
    expect(rows.n).toBe(0)
  })

  it('a locked (newer-build) db reads empty and swallows puts', async () => {
    const path = join(dir, 'locked.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 99')
    raw.close()
    const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
    const store = new SqliteTranscriptStore({ stateDb })

    expect(await store.readWithSnapshot('t1', V)).toEqual({ snapshot: null, tail: [], lastSeq: 0 })
    await expect(
      store.putSnapshot({ threadId: 't1', reducerVersion: V, lastSeq: 1, state: '{}' }),
    ).resolves.toBeUndefined()
    stateDb.close()
  })
})
