import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMetadataStore } from './create-metadata-store'
import { METADATA_SCHEMA_VERSION, MetadataStore } from './metadata-store'
import { SqliteMetadataStore } from './sqlite-metadata-store'

/**
 * The engine-selection construction seam (ADR-0019): SQLite normally, legacy
 * JSON behind the escape hatch or when the db can't open, with the one-time
 * import wired in. Real temp-dir `userData` layouts, no Electron.
 */

const root = mkdtempSync(join(tmpdir(), 'vibe-create-store-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let seq = 0
function freshUserData(): string {
  const dir = join(root, `userdata-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('createMetadataStore', () => {
  it('selects SQLite, creates state.sqlite, and the store round-trips', async () => {
    const userDataDir = freshUserData()
    const result = await createMetadataStore({ userDataDir })

    expect(result.engine).toBe('sqlite')
    expect(result.store).toBeInstanceOf(SqliteMetadataStore)
    expect(result.stateDb).not.toBeNull()
    expect(existsSync(join(userDataDir, 'state.sqlite'))).toBe(true)

    const ws = await result.store.upsertWorkspace({ dir: '/proj/x' })
    expect(result.store.snapshot().workspaces.map((w) => w.id)).toEqual([ws.id])
    result.stateDb?.close()
  })

  it('imports a legacy metadata.json on first launch and renames it to .bak', async () => {
    const userDataDir = freshUserData()
    writeFileSync(
      join(userDataDir, 'metadata.json'),
      JSON.stringify({
        schemaVersion: METADATA_SCHEMA_VERSION,
        workspaces: [{ id: 'w1', dir: '/legacy', displayName: 'L', lastOpenedAt: 5 }],
        threads: [
          { id: 't1', workspaceId: 'w1', sessionId: 'sess', title: 'kept', createdAt: 1, lastActiveAt: 2 },
        ],
      }),
    )

    const result = await createMetadataStore({ userDataDir })

    expect(result.engine).toBe('sqlite')
    expect(result.store.snapshot().threads[0]).toMatchObject({ id: 't1', title: 'kept' })
    expect(existsSync(join(userDataDir, 'metadata.json'))).toBe(false)
    expect(existsSync(join(userDataDir, 'metadata.json.bak'))).toBe(true)

    // Second launch: steady state — no legacy file, data served from SQLite.
    result.stateDb?.close()
    const again = await createMetadataStore({ userDataDir })
    expect(again.engine).toBe('sqlite')
    expect(again.store.snapshot().threads.map((t) => t.id)).toEqual(['t1'])
    again.stateDb?.close()
  })

  it('honors the VIBE_MISTRO_FORCE_JSON escape hatch (legacy engine, no db created)', async () => {
    const userDataDir = freshUserData()
    const result = await createMetadataStore({ userDataDir, forceJson: true })

    expect(result.engine).toBe('json')
    expect(result.store).toBeInstanceOf(MetadataStore)
    expect(result.stateDb).toBeNull()
    expect(existsSync(join(userDataDir, 'state.sqlite'))).toBe(false)
  })

  it('falls back to the legacy JSON store when state.sqlite cannot open', async () => {
    const userDataDir = freshUserData()
    // Occupy the db path with a DIRECTORY so the open throws.
    mkdirSync(join(userDataDir, 'state.sqlite'))

    const result = await createMetadataStore({ userDataDir })

    expect(result.engine).toBe('json')
    expect(result.store).toBeInstanceOf(MetadataStore)
    // The legacy store still works for the session.
    await result.store.load()
    const ws = await result.store.upsertWorkspace({ dir: '/proj/fallback' })
    expect(result.store.snapshot().workspaces.map((w) => w.id)).toEqual([ws.id])
  })
})
