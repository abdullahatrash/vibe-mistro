import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openStateDb, readUserVersion, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import { STATE_MIGRATIONS } from './state-migrations'
import {
  acpEventEntry,
  agentReboundEntry,
  resolvePermissionEntry,
  turnCompleteEntry,
  turnErrorEntry,
  userPromptEntry,
} from './transcript'

/**
 * The SQLite transcript event log (ADR-0019) behind `TranscriptStoreApi` — the
 * behavior spec transcript.test.ts pins for the JSONL engine (append ordering,
 * all six entry kinds, image refs, torn-record tolerance, idempotent delete),
 * re-pointed at `:memory:` databases, plus the SQLite-specific pieces: the FK
 * cascade from the metadata delete and the fail-closed locked db.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-sqlite-transcript-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

interface Fixture {
  stateDb: StateDb
  meta: SqliteMetadataStore
  store: SqliteTranscriptStore
  /** A bound Thread id (metadata row present, FK satisfied). */
  threadId: string
  workspaceId: string
}

async function fixture(path = ':memory:'): Promise<Fixture> {
  const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
  const meta = new SqliteMetadataStore({ stateDb })
  const store = new SqliteTranscriptStore({ stateDb })
  const ws = await meta.upsertWorkspace({ dir: '/proj/x' })
  const thread = await meta.upsertThread({ workspaceId: ws.id, sessionId: 'sess-1' })
  return { stateDb, meta, store, threadId: thread.id, workspaceId: ws.id }
}

describe('SqliteTranscriptStore append/read round-trip', () => {
  it('persists all six entry kinds in call order and reads them back', async () => {
    const { store, threadId } = await fixture()
    const entries = [
      userPromptEntry('u1', 'fix the bug', [{ file: 'img.png', mimeType: 'image/png' }]),
      acpEventEntry({ method: 'session/update', params: { sessionId: 'sess-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'On it' } } } }),
      resolvePermissionEntry(7, 'allow', null),
      agentReboundEntry(),
      turnErrorEntry('boom'),
      turnCompleteEntry(),
    ]
    for (const e of entries) await store.append(threadId, e)

    const back = await store.read(threadId)
    expect(back).toEqual(entries) // exact order, exact shapes (image refs included)
  })

  it('keeps interleaved Threads separate (the global seq orders, the thread_id partitions)', async () => {
    const { store, meta, workspaceId, threadId: a } = await fixture()
    const b = (await meta.upsertThread({ workspaceId, sessionId: 'sess-2' })).id

    await store.append(a, userPromptEntry('u1', 'first in A'))
    await store.append(b, userPromptEntry('u2', 'first in B'))
    await store.append(a, turnCompleteEntry())

    expect(await store.read(a)).toEqual([userPromptEntry('u1', 'first in A'), turnCompleteEntry()])
    expect(await store.read(b)).toEqual([userPromptEntry('u2', 'first in B')])
  })

  it('an unwritten Thread reads back empty', async () => {
    const { store } = await fixture()
    expect(await store.read('never-written')).toEqual([])
  })

  it('is durable across a close + reopen of the same file db', async () => {
    const path = join(dir, 'durable.sqlite')
    const first = await fixture(path)
    await first.store.append(first.threadId, userPromptEntry('u1', 'survives'))
    first.stateDb.close()

    const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
    const reopened = new SqliteTranscriptStore({ stateDb })
    expect(await reopened.read(first.threadId)).toEqual([userPromptEntry('u1', 'survives')])
    stateDb.close()
  })

  it('skips a garbled payload row on read (torn-record tolerance parity), never throws', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'good'))
    stateDb.db
      .prepare('INSERT INTO transcript_entries (thread_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(threadId, 'acp-event', '{ torn json', 0)
    stateDb.db
      .prepare('INSERT INTO transcript_entries (thread_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(threadId, 'foreign', JSON.stringify({ t: 'not-an-entry' }), 0)
    await store.append(threadId, turnCompleteEntry())

    expect(await store.read(threadId)).toEqual([userPromptEntry('u1', 'good'), turnCompleteEntry()])
  })

  it('an append for a Thread with no metadata row (FK) is swallowed, not thrown', async () => {
    const { store } = await fixture()
    await expect(store.append('no-such-thread', turnCompleteEntry())).resolves.toBeUndefined()
    expect(await store.read('no-such-thread')).toEqual([])
  })
})

describe('SqliteTranscriptStore delete + cascade', () => {
  it('delete drops only that Thread and is idempotent', async () => {
    const { store, meta, workspaceId, threadId: a } = await fixture()
    const b = (await meta.upsertThread({ workspaceId })).id
    await store.append(a, userPromptEntry('u1', 'in A'))
    await store.append(b, userPromptEntry('u2', 'in B'))

    await store.delete(a)
    await expect(store.delete(a)).resolves.toBeUndefined() // idempotent
    expect(await store.read(a)).toEqual([])
    expect(await store.read(b)).toEqual([userPromptEntry('u2', 'in B')])
  })

  it('deleting the Thread metadata row CASCADES its entries away', async () => {
    const { store, meta, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'text'))
    await meta.deleteThread(threadId)
    expect(await store.read(threadId)).toEqual([])
  })

  it('removing the Workspace CASCADES every hosted Thread’s entries away', async () => {
    const { store, meta, workspaceId, threadId } = await fixture()
    const other = (await meta.upsertThread({ workspaceId })).id
    await store.append(threadId, userPromptEntry('u1', 'one'))
    await store.append(other, userPromptEntry('u2', 'two'))

    await meta.removeWorkspace(workspaceId)

    expect(await store.read(threadId)).toEqual([])
    expect(await store.read(other)).toEqual([])
  })
})

describe('SqliteTranscriptStore fail-closed (locked db)', () => {
  it('reads empty and swallows writes on a newer-build database', async () => {
    const path = join(dir, 'locked.sqlite')
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version = 99')
    raw.close()

    const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
    expect(stateDb.locked).toBe(true)
    const store = new SqliteTranscriptStore({ stateDb })

    await expect(store.append('t1', turnCompleteEntry())).resolves.toBeUndefined()
    expect(await store.read('t1')).toEqual([])
    await expect(store.delete('t1')).resolves.toBeUndefined()
    expect(store.hasEntries('t1')).toBe(false)
    expect(() => store.importEntries('t1', [])).toThrow()
    stateDb.close()

    const verify = new DatabaseSync(path)
    expect(readUserVersion(verify)).toBe(99) // untouched
    verify.close()
  })
})

describe('SqliteTranscriptStore.importEntries (one-time legacy import)', () => {
  it('inserts a file’s entries in order inside one transaction', async () => {
    const { store, threadId } = await fixture()
    const entries = [userPromptEntry('u1', 'from jsonl'), turnCompleteEntry()]
    store.importEntries(threadId, entries)
    expect(await store.read(threadId)).toEqual(entries)
    expect(store.hasEntries(threadId)).toBe(true)
  })

  it('rolls the whole file back when an insert fails (FK: orphan thread)', async () => {
    const { store } = await fixture()
    expect(() => store.importEntries('orphan-thread', [turnCompleteEntry()])).toThrow()
    expect(await store.read('orphan-thread')).toEqual([])
    expect(store.hasEntries('orphan-thread')).toBe(false)
  })

  it('threadExists mirrors the metadata rows (the importer’s FK pre-check)', async () => {
    const { store, threadId } = await fixture()
    expect(store.threadExists(threadId)).toBe(true)
    expect(store.threadExists('nope')).toBe(false)
  })
})
