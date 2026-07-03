import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLegacyMetadata } from './import-legacy-metadata'
import { METADATA_SCHEMA_VERSION } from './metadata-store'
import { openStateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The one-time `metadata.json` -> SQLite import (ADR-0019). Exercised over real
 * temp-dir files (the legacy JSON + `:memory:` target stores), covering the
 * self-gating branches: absent, newer-schema lock, non-empty db, failure
 * rollback, and the `.bak` rename (including its crash-retry).
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-import-meta-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
function legacyFileWith(content: unknown): string {
  const path = join(dir, `metadata-${++seq}.json`)
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content))
  return path
}

function memoryStore(): SqliteMetadataStore {
  return new SqliteMetadataStore({
    stateDb: openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS }),
  })
}

const LEGACY_FIXTURE = {
  schemaVersion: METADATA_SCHEMA_VERSION,
  workspaces: [
    { id: 'w1', dir: '/proj/a', displayName: 'A', lastOpenedAt: 100 },
    { id: 'w2', dir: '/proj/b', displayName: 'B', lastOpenedAt: 300 },
  ],
  threads: [
    { id: 't1', workspaceId: 'w1', sessionId: 'sess-1', title: 'one', createdAt: 1, lastActiveAt: 10, pinned: true },
    { id: 't2', workspaceId: 'w1', sessionId: null, title: null, createdAt: 2, lastActiveAt: 50, archived: true },
    { id: 't3', workspaceId: 'w2', sessionId: 'sess-3', title: 'three', createdAt: 3, lastActiveAt: 20 },
  ],
}

describe('importLegacyMetadata', () => {
  it('imports the legacy index verbatim and renames the file to .bak (kept, not deleted)', async () => {
    const filePath = legacyFileWith(LEGACY_FIXTURE)
    const store = memoryStore()

    const result = await importLegacyMetadata({ filePath, store })

    expect(result).toBe('imported')
    const snap = store.snapshot()
    expect(snap.workspaces.map((w) => w.id)).toEqual(['w2', 'w1'])
    const t1 = snap.threads.find((t) => t.id === 't1')
    expect(t1).toMatchObject({ sessionId: 'sess-1', title: 'one', createdAt: 1, pinned: true })
    expect(snap.threads.find((t) => t.id === 't2')?.archived).toBe(true)
    expect(snap.threads.find((t) => t.id === 't2')?.sessionId).toBeNull()

    // The original is gone; the .bak holds the pre-import bytes (rollback path).
    expect(existsSync(filePath)).toBe(false)
    expect(JSON.parse(readFileSync(`${filePath}.bak`, 'utf8'))).toEqual(LEGACY_FIXTURE)
  })

  it('skips when the legacy file is absent (the steady state after migration)', async () => {
    const store = memoryStore()
    const result = await importLegacyMetadata({ filePath: join(dir, 'never-existed.json'), store })
    expect(result).toBe('skipped-absent')
    expect(store.isEmpty()).toBe(true)
  })

  it('leaves a NEWER-schema legacy file untouched (fail-closed carries into the import)', async () => {
    const future = { schemaVersion: METADATA_SCHEMA_VERSION + 99, workspaces: [], threads: [] }
    const filePath = legacyFileWith(future)
    const store = memoryStore()

    const result = await importLegacyMetadata({ filePath, store })

    expect(result).toBe('skipped-locked')
    expect(store.isEmpty()).toBe(true)
    expect(existsSync(filePath)).toBe(true) // not renamed, byte-for-byte preserved
    expect(JSON.parse(readFileSync(filePath, 'utf8'))).toEqual(future)
  })

  it('never merges into a non-empty database — only retries the .bak rename', async () => {
    const filePath = legacyFileWith(LEGACY_FIXTURE)
    const store = memoryStore()
    // Real SQLite data already present (e.g. a crash after commit, before rename).
    const ws = await store.upsertWorkspace({ dir: '/proj/existing' })
    await store.upsertThread({ workspaceId: ws.id, title: 'existing' })

    const result = await importLegacyMetadata({ filePath, store })

    expect(result).toBe('skipped-nonempty')
    // Nothing merged: the existing rows are exactly what the store holds.
    expect(store.snapshot().workspaces.map((w) => w.dir)).toEqual(['/proj/existing'])
    // The rename retry landed: original gone, .bak present.
    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(`${filePath}.bak`)).toBe(true)
  })

  it('a corrupt legacy file imports as empty (degrade-to-empty parity) and is .bak-ed', async () => {
    const filePath = legacyFileWith('{ not valid json ]')
    const store = memoryStore()

    const result = await importLegacyMetadata({ filePath, store })

    expect(result).toBe('imported')
    expect(store.isEmpty()).toBe(true)
    expect(existsSync(`${filePath}.bak`)).toBe(true)
  })

  it("returns 'failed' and leaves the db empty + the file in place when the insert throws", async () => {
    // Duplicate Thread ids both pass the legacy per-record guards, then violate
    // the PRIMARY KEY inside the import transaction — the classic mid-way failure.
    const filePath = legacyFileWith({
      schemaVersion: METADATA_SCHEMA_VERSION,
      workspaces: [{ id: 'w1', dir: '/a', displayName: 'a', lastOpenedAt: 1 }],
      threads: [
        { id: 'dup', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 1 },
        { id: 'dup', workspaceId: 'w1', sessionId: null, title: null, createdAt: 2, lastActiveAt: 2 },
      ],
    })
    const store = memoryStore()

    const result = await importLegacyMetadata({ filePath, store })

    expect(result).toBe('failed')
    expect(store.isEmpty()).toBe(true) // rolled back — retry next launch
    expect(existsSync(filePath)).toBe(true) // still in place for that retry
    expect(existsSync(`${filePath}.bak`)).toBe(false)
  })

  it("still returns 'imported' when only the .bak rename fails, and the next run retries it", async () => {
    const filePath = legacyFileWith(LEGACY_FIXTURE)
    const store = memoryStore()

    const result = await importLegacyMetadata({
      filePath,
      store,
      renameFile: async () => {
        throw new Error('EACCES')
      },
    })

    expect(result).toBe('imported') // the data is safely committed
    expect(existsSync(filePath)).toBe(true) // rename failed — file remains

    // Next launch: non-empty db + file present → rename retried (real fs now).
    const again = await importLegacyMetadata({ filePath, store })
    expect(again).toBe('skipped-nonempty')
    expect(existsSync(filePath)).toBe(false)
    expect(existsSync(`${filePath}.bak`)).toBe(true)
    // And the retry never duplicated the imported records.
    expect(store.snapshot().threads).toHaveLength(3)
  })
})
