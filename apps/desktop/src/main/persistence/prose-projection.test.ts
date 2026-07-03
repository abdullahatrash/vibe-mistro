import { describe, it, expect } from 'vitest'
import { openStateDb, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import { STATE_MIGRATIONS } from './state-migrations'
import { acpEventEntry, turnCompleteEntry, userPromptEntry } from './transcript'
import type { TranscriptEntry } from '../../shared/ipc'

/**
 * The prose write-path projection + FTS index (ADR-0019, #296): what lands in
 * `prose_items`/`prose_fts` as entries append — one row per conversation item,
 * chunks concatenated — plus the migration-3 backfill for databases that
 * imported their entries before this slice existed.
 */

function chunkEntry(text: string, messageId?: string): TranscriptEntry {
  return acpEventEntry({
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
        ...(messageId ? { messageId } : {}),
      },
    },
  })
}

function thoughtEntry(text: string): TranscriptEntry {
  return acpEventEntry({
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } },
    },
  })
}

interface Fixture {
  stateDb: StateDb
  store: SqliteTranscriptStore
  meta: SqliteMetadataStore
  threadId: string
}

async function fixture(): Promise<Fixture> {
  const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
  const meta = new SqliteMetadataStore({ stateDb })
  const store = new SqliteTranscriptStore({ stateDb })
  const ws = await meta.upsertWorkspace({ dir: '/proj/x' })
  const thread = await meta.upsertThread({ workspaceId: ws.id })
  return { stateDb, store, meta, threadId: thread.id }
}

function proseRows(stateDb: StateDb, threadId: string) {
  return stateDb.db
    .prepare('SELECT item_id, first_seq, text FROM prose_items WHERE thread_id = ? ORDER BY first_seq')
    .all(threadId) as unknown as { item_id: string | null; first_seq: number; text: string }[]
}

function ftsCount(stateDb: StateDb, match: string): number {
  return (
    stateDb.db.prepare('SELECT COUNT(*) AS n FROM prose_fts WHERE prose_fts MATCH ?').get(match) as {
      n: number
    }
  ).n
}

describe('prose projection on append', () => {
  it('projects a user prompt as one row keyed by the prompt id', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'fix the login bug'))

    expect(proseRows(stateDb, threadId)).toEqual([
      expect.objectContaining({ item_id: 'u1', text: 'fix the login bug' }),
    ])
    expect(ftsCount(stateDb, '"login"*')).toBe(1)
  })

  it('CONCATENATES streamed chunks into ONE row per message (keyed assistant:<messageId>)', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, chunkEntry('The pool ', 'm1'))
    await store.append(threadId, chunkEntry('evicts idle ', 'm1'))
    await store.append(threadId, chunkEntry('agents.', 'm1'))
    await store.append(threadId, chunkEntry('A new message.', 'm2'))

    const rows = proseRows(stateDb, threadId)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ item_id: 'assistant:m1', text: 'The pool evicts idle agents.' })
    expect(rows[1]).toMatchObject({ item_id: 'assistant:m2', text: 'A new message.' })
    // Tokens SPANNING a chunk boundary now match within the item (the #296
    // concatenation decision) — 'idle agents' lives across two chunks.
    expect(ftsCount(stateDb, '"idle" "agents"')).toBe(1)
    // first_seq stays the FIRST chunk's seq (the jump target is the message start).
    expect(rows[0].first_seq).toBeLessThan(rows[1].first_seq)
  })

  it('a chunk with no messageId gets its own un-jumpable row (item_id NULL)', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, chunkEntry('anonymous chunk one'))
    await store.append(threadId, chunkEntry('anonymous chunk two'))

    const rows = proseRows(stateDb, threadId)
    expect(rows).toHaveLength(2) // NOT concatenated — no key to concatenate on
    expect(rows.every((r) => r.item_id === null)).toBe(true)
    expect(ftsCount(stateDb, '"anonymous"*')).toBe(2)
  })

  it('reasoning and non-prose entries are NOT indexed (the #174 exclusion)', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, thoughtEntry('secret reasoning about grep'))
    await store.append(threadId, turnCompleteEntry())
    await store.append(
      threadId,
      acpEventEntry({
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: { sessionUpdate: 'tool_call', rawInput: { command: 'grep secret' } },
        },
      }),
    )

    expect(proseRows(stateDb, threadId)).toEqual([])
    expect(ftsCount(stateDb, '"secret"*')).toBe(0)
  })

  it('importEntries projects prose exactly like the live append', async () => {
    const { stateDb, store, threadId } = await fixture()
    store.importEntries(threadId, [
      userPromptEntry('u1', 'imported prompt'),
      chunkEntry('imported ', 'm1'),
      chunkEntry('reply', 'm1'),
    ])

    const rows = proseRows(stateDb, threadId)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ item_id: 'assistant:m1', text: 'imported reply' })
    expect(ftsCount(stateDb, '"imported"*')).toBe(2)
  })
})

describe('prose cleanup', () => {
  it('deleting the Thread metadata row cascades prose AND the FTS index', async () => {
    const { stateDb, store, meta, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'cascade me away'))
    expect(ftsCount(stateDb, '"cascade"*')).toBe(1)

    await meta.deleteThread(threadId)

    expect(proseRows(stateDb, threadId)).toEqual([])
    expect(ftsCount(stateDb, '"cascade"*')).toBe(0) // the delete trigger cleaned FTS
  })

  it('removing the Workspace cascades every hosted Thread’s prose away', async () => {
    const { stateDb, store, meta, threadId } = await fixture()
    const wsId = (
      stateDb.db.prepare('SELECT workspace_id AS w FROM threads WHERE id = ?').get(threadId) as {
        w: string
      }
    ).w
    await store.append(threadId, userPromptEntry('u1', 'workspace teardown'))

    await meta.removeWorkspace(wsId)

    expect(ftsCount(stateDb, '"teardown"*')).toBe(0)
  })

  it('the store’s own delete clears prose + FTS too (cascade-less path)', async () => {
    const { stateDb, store, threadId } = await fixture()
    await store.append(threadId, userPromptEntry('u1', 'explicit delete'))

    await store.delete(threadId)

    expect(proseRows(stateDb, threadId)).toEqual([])
    expect(ftsCount(stateDb, '"explicit"*')).toBe(0)
  })
})

describe('migration 3 backfill', () => {
  it('re-folds pre-existing entries into the projection when the migration lands', async () => {
    // A database exactly as slice 3 left it: migrations 1-2, entries imported.
    const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS.slice(0, 2) })
    const meta = new SqliteMetadataStore({ stateDb })
    const ws = await meta.upsertWorkspace({ dir: '/proj/old' })
    const thread = await meta.upsertThread({ workspaceId: ws.id })
    // Seed entries the way a v2-era build wrote them: raw inserts, no projection
    // (the current store assumes the migrated schema, as production always has).
    const insert = stateDb.db.prepare(
      'INSERT INTO transcript_entries (thread_id, kind, payload, created_at) VALUES (?, ?, ?, ?)',
    )
    for (const entry of [
      userPromptEntry('u1', 'pre-existing prompt'),
      chunkEntry('backfilled ', 'm1'),
      chunkEntry('answer', 'm1'),
      thoughtEntry('not indexed'),
    ]) {
      insert.run(thread.id, entry.t, JSON.stringify(entry), 0)
    }
    // Slice 3's schema has no prose tables yet.
    expect(
      stateDb.db
        .prepare("SELECT name FROM sqlite_master WHERE name = 'prose_items'")
        .all(),
    ).toHaveLength(0)

    // "Upgrade the app": migration 3 runs on the same database.
    // (:memory: can't reopen, so run the pending migration's up() directly —
    //  same code path the runner takes.)
    const migration3 = STATE_MIGRATIONS[2]
    stateDb.db.exec('BEGIN')
    migration3.up(stateDb.db)
    stateDb.db.exec('COMMIT')

    const rows = stateDb.db
      .prepare('SELECT item_id, text FROM prose_items WHERE thread_id = ? ORDER BY first_seq')
      .all(thread.id) as unknown as { item_id: string | null; text: string }[]
    expect(rows).toEqual([
      { item_id: 'u1', text: 'pre-existing prompt' },
      { item_id: 'assistant:m1', text: 'backfilled answer' }, // concatenated in seq order
    ])
    expect(ftsCount({ ...stateDb }, '"backfilled"*')).toBe(1)
    stateDb.close()
  })

  it('a file db upgrades 2 -> 3 through the real runner and backfills once', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'vibe-prose-backfill-'))
    const path = join(dir, 'state.sqlite')
    try {
      const v2 = openStateDb({ path, migrations: STATE_MIGRATIONS.slice(0, 2) })
      const meta = new SqliteMetadataStore({ stateDb: v2 })
      const ws = await meta.upsertWorkspace({ dir: '/proj/upgrade' })
      const thread = await meta.upsertThread({ workspaceId: ws.id })
      const entry = userPromptEntry('u1', 'upgraded content')
      v2.db
        .prepare('INSERT INTO transcript_entries (thread_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
        .run(thread.id, entry.t, JSON.stringify(entry), 0)
      v2.close()

      const v3 = openStateDb({ path, migrations: STATE_MIGRATIONS })
      expect(ftsCount(v3, '"upgraded"*')).toBe(1)
      v3.close()

      // Reopening again is a no-op (user_version gate) — no duplicate rows.
      const again = openStateDb({ path, migrations: STATE_MIGRATIONS })
      expect(
        (again.db.prepare('SELECT COUNT(*) AS n FROM prose_items').get() as { n: number }).n,
      ).toBe(1)
      again.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
