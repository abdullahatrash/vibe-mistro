import { describe, it, expect } from 'vitest'
import { openStateDb, type StateDb } from '../persistence/sqlite-db'
import { SqliteMetadataStore } from '../persistence/sqlite-metadata-store'
import { SqliteTranscriptStore } from '../persistence/sqlite-transcript-store'
import { STATE_MIGRATIONS } from '../persistence/state-migrations'
import { acpEventEntry, userPromptEntry } from '../persistence/transcript'
import { groupThreadsByWorkspace } from '../persistence/metadata-store'
import type { TranscriptEntry } from '../../shared/ipc'
import { ftsProseByThread } from './fts-prose'
import { searchThreads, tokenizeQuery } from './search-threads'
import { proseEntries } from './transcript-prose'

/**
 * The FTS prose feeder (#296): one indexed query replaces the per-query
 * transcript scan, feeding the SAME pure `searchThreads` ranking. Includes a
 * parity check: for word-boundary tokens, FTS-fed hits equal scan-fed hits.
 */

function chunkEntry(text: string, messageId: string): TranscriptEntry {
  return acpEventEntry({
    method: 'session/update',
    params: {
      sessionId: 'sess-1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
    },
  })
}

interface Fixture {
  stateDb: StateDb
  meta: SqliteMetadataStore
  store: SqliteTranscriptStore
}

async function fixture(): Promise<Fixture> {
  const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
  return {
    stateDb,
    meta: new SqliteMetadataStore({ stateDb }),
    store: new SqliteTranscriptStore({ stateDb }),
  }
}

describe('ftsProseByThread', () => {
  it('returns matching items grouped per Thread, in replay order, with entry_index + itemId', async () => {
    const { stateDb, meta, store } = await fixture()
    const ws = await meta.upsertWorkspace({ dir: '/proj/a' })
    const t1 = (await meta.upsertThread({ workspaceId: ws.id })).id
    await store.append(t1, userPromptEntry('u1', 'where is the eviction policy'))
    await store.append(t1, chunkEntry('The eviction policy lives in the pool.', 'm1'))
    const t2 = (await meta.upsertThread({ workspaceId: ws.id })).id
    await store.append(t2, userPromptEntry('u2', 'unrelated question'))

    const prose = ftsProseByThread(stateDb.db, tokenizeQuery('eviction'))

    expect([...prose.keys()]).toEqual([t1]) // t2 has no match
    const entries = prose.get(t1) ?? []
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ index: 0, itemId: 'u1' }) // replay order
    expect(entries[1]).toMatchObject({ index: 1, itemId: 'assistant:m1' })
    stateDb.close()
  })

  it('matches case- and accent-insensitively and on word prefixes', async () => {
    const { stateDb, meta, store } = await fixture()
    const ws = await meta.upsertWorkspace({ dir: '/proj/b' })
    const t = (await meta.upsertThread({ workspaceId: ws.id })).id
    await store.append(t, userPromptEntry('u1', 'Réviser la Configuration complète'))

    expect(ftsProseByThread(stateDb.db, tokenizeQuery('reviser')).size).toBe(1)
    expect(ftsProseByThread(stateDb.db, tokenizeQuery('CONFIG')).size).toBe(1) // prefix
    expect(ftsProseByThread(stateDb.db, tokenizeQuery('missing')).size).toBe(0)
    stateDb.close()
  })

  it('feeds OR-of-tokens so scattered-across-items matching still works downstream', async () => {
    const { stateDb, meta, store } = await fixture()
    const ws = await meta.upsertWorkspace({ dir: '/proj/c' })
    const t = (await meta.upsertThread({ workspaceId: ws.id, title: null })).id
    // 'alpha' and 'omega' live in DIFFERENT items — no single strong entry.
    await store.append(t, userPromptEntry('u1', 'alpha first'))
    await store.append(t, chunkEntry('omega later', 'm1'))

    const tokens = tokenizeQuery('alpha omega')
    const prose = ftsProseByThread(stateDb.db, tokens)
    expect(prose.get(t)).toHaveLength(2) // OR query returned both items

    const snapshot = groupThreadsByWorkspace({
      workspaces: [{ id: ws.id, dir: '/proj/c', displayName: 'c', lastOpenedAt: 1 }],
      threads: [{ id: t, workspaceId: ws.id, sessionId: null, title: null, createdAt: 1, lastActiveAt: 1 }],
    })
    const hits = searchThreads(snapshot, 'alpha omega', 20, prose)
    expect(hits.map((h) => h.threadId)).toEqual([t]) // scattered match still hits
    expect(hits[0]?.snippet).toBeUndefined() // no single strong entry -> no snippet
    stateDb.close()
  })

  it('empty tokens return an empty map (the resting palette does no FTS work)', async () => {
    const { stateDb } = await fixture()
    expect(ftsProseByThread(stateDb.db, []).size).toBe(0)
    stateDb.close()
  })

  it('quotes exotic tokens defensively (no MATCH syntax injection)', async () => {
    const { stateDb, meta, store } = await fixture()
    const ws = await meta.upsertWorkspace({ dir: '/proj/d' })
    const t = (await meta.upsertThread({ workspaceId: ws.id })).id
    await store.append(t, userPromptEntry('u1', 'weird "quoted" AND NOT tokens'))

    // Raw FTS operators and quotes must be treated as literal-ish tokens, not syntax.
    expect(() => ftsProseByThread(stateDb.db, tokenizeQuery('"quoted" AND NOT'))).not.toThrow()
    expect(ftsProseByThread(stateDb.db, tokenizeQuery('quoted')).size).toBe(1)
    stateDb.close()
  })
})

describe('FTS-fed vs scan-fed parity (the #296 baseline)', () => {
  it('produces identical SearchHits for word-boundary queries', async () => {
    const { stateDb, meta, store } = await fixture()
    const ws = await meta.upsertWorkspace({ dir: '/proj/parity', displayName: 'Parity' })
    const t1 = (await meta.upsertThread({ workspaceId: ws.id, title: 'eviction thread' })).id
    await store.append(t1, userPromptEntry('u1', 'how does the eviction policy work'))
    await store.append(t1, chunkEntry('The eviction policy is LRU with idle sweep.', 'm1'))
    const t2 = (await meta.upsertThread({ workspaceId: ws.id, title: 'other' })).id
    await store.append(t2, userPromptEntry('u2', 'eviction mentioned once here'))
    const t3 = (await meta.upsertThread({ workspaceId: ws.id, title: 'silent' })).id
    await store.append(t3, userPromptEntry('u3', 'nothing relevant'))

    const snapshot = groupThreadsByWorkspace(meta.snapshot())
    const query = 'eviction policy'
    const tokens = tokenizeQuery(query)

    // The legacy feed: read every transcript, extract all prose (the old scan).
    const scanFed = new Map(
      await Promise.all(
        snapshot
          .flatMap((w) => w.threads)
          .map(async (th) => [th.id, proseEntries(await store.read(th.id))] as const),
      ),
    )
    // The new feed: one FTS query.
    const ftsFed = ftsProseByThread(stateDb.db, tokens)

    const scanHits = searchThreads(snapshot, query, 20, scanFed)
    const ftsHits = searchThreads(snapshot, query, 20, ftsFed)

    expect(ftsHits.map((h) => h.threadId)).toEqual(scanHits.map((h) => h.threadId))
    expect(ftsHits.map((h) => h.snippet)).toEqual(scanHits.map((h) => h.snippet))
    expect(ftsHits.map((h) => h.jumpItemId)).toEqual(scanHits.map((h) => h.jumpItemId))
    expect(ftsHits.map((h) => h.hitCount)).toEqual(scanHits.map((h) => h.hitCount))
    stateDb.close()
  })
})
