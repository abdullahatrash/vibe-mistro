import { describe, it, expect } from 'vitest'
import {
  groupThreadsByWorkspace,
  METADATA_SCHEMA_VERSION,
  parseLegacyMetadata,
} from './metadata-store'

/**
 * The engine-independent metadata pieces (#298 — the JSON engine itself is
 * gone): `parseLegacyMetadata`, the one-time importer's tolerant envelope
 * reader (behaviors carried verbatim from the removed engine's `load()`), and
 * the pure `groupThreadsByWorkspace` launch-list shape.
 */

describe('parseLegacyMetadata', () => {
  it('reads a versioned envelope', () => {
    const { snapshot, locked } = parseLegacyMetadata(
      JSON.stringify({
        schemaVersion: METADATA_SCHEMA_VERSION,
        workspaces: [{ id: 'w1', dir: '/a', displayName: 'a', lastOpenedAt: 5 }],
        threads: [
          { id: 't1', workspaceId: 'w1', sessionId: 's', title: 'T', createdAt: 1, lastActiveAt: 2 },
        ],
      }),
    )
    expect(locked).toBe(false)
    expect(snapshot.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(snapshot.threads[0]).toMatchObject({ id: 't1', sessionId: 's', title: 'T' })
  })

  it('reads a legacy header-less file (no schemaVersion) as the current version', () => {
    const { snapshot, locked } = parseLegacyMetadata(
      JSON.stringify({
        workspaces: [{ id: 'w1', dir: '/legacy', displayName: 'L', lastOpenedAt: 5 }],
        threads: [],
      }),
    )
    expect(locked).toBe(false)
    expect(snapshot.workspaces.map((w) => w.id)).toEqual(['w1'])
  })

  it('degrades unparseable JSON to an EMPTY snapshot without locking (no trustworthy version)', () => {
    const { snapshot, locked } = parseLegacyMetadata('{ this is not: valid json ]')
    expect(locked).toBe(false)
    expect(snapshot).toEqual({ workspaces: [], threads: [] })
  })

  it('FAILS CLOSED on a newer schemaVersion (the importer leaves the file untouched)', () => {
    const { snapshot, locked } = parseLegacyMetadata(
      JSON.stringify({ schemaVersion: METADATA_SCHEMA_VERSION + 99, workspaces: [], threads: [] }),
    )
    expect(locked).toBe(true)
    expect(snapshot).toEqual({ workspaces: [], threads: [] })
  })

  it('drops malformed records, keeping the valid subset (one bad row cannot poison the import)', () => {
    const { snapshot } = parseLegacyMetadata(
      JSON.stringify({
        workspaces: [
          { id: 'w1', dir: '/ok', displayName: 'ok', lastOpenedAt: 100 },
          { id: 'wBad', dir: 123 }, // dir not a string, no timestamp → dropped
        ],
        threads: [
          null, // dropped, must not crash
          { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 10 },
          { id: 'tBad', workspaceId: 'w1' }, // missing numeric timestamps → dropped
        ],
      }),
    )
    expect(snapshot.workspaces.map((w) => w.id)).toEqual(['w1'])
    expect(snapshot.threads.map((t) => t.id)).toEqual(['t1'])
    expect(() => groupThreadsByWorkspace(snapshot)).not.toThrow()
  })

  it('coerces a stored non-boolean flag to undefined (defensive normalize)', () => {
    const { snapshot } = parseLegacyMetadata(
      JSON.stringify({
        schemaVersion: METADATA_SCHEMA_VERSION,
        workspaces: [{ id: 'w1', dir: '/c', displayName: 'c', lastOpenedAt: 1 }],
        threads: [
          // pinned is a truthy STRING, archived is a real boolean — only the boolean survives.
          { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 1, pinned: 'yes', archived: true },
        ],
      }),
    )
    const rec = snapshot.threads[0]
    expect(rec?.pinned).toBeUndefined()
    expect(rec?.archived).toBe(true)
  })
})

describe('groupThreadsByWorkspace (pure)', () => {
  it('nests Threads under their Workspace, both most-recent-first, dropping orphans', () => {
    const grouped = groupThreadsByWorkspace({
      workspaces: [
        { id: 'w1', dir: '/a', displayName: 'a', lastOpenedAt: 100 },
        { id: 'w2', dir: '/b', displayName: 'b', lastOpenedAt: 300 },
      ],
      threads: [
        { id: 't1', workspaceId: 'w1', sessionId: null, title: null, createdAt: 1, lastActiveAt: 10 },
        { id: 't2', workspaceId: 'w1', sessionId: 's2', title: 'two', createdAt: 2, lastActiveAt: 50 },
        { id: 't3', workspaceId: 'w2', sessionId: null, title: null, createdAt: 3, lastActiveAt: 20 },
        // Orphan: its Workspace is gone — must be dropped, not crash.
        { id: 't4', workspaceId: 'gone', sessionId: null, title: null, createdAt: 4, lastActiveAt: 99 },
      ],
    })

    expect(grouped.map((w) => w.id)).toEqual(['w2', 'w1'])
    const w1 = grouped.find((w) => w.id === 'w1')
    expect(w1?.threads.map((t) => t.id)).toEqual(['t2', 't1'])
    expect(grouped.flatMap((w) => w.threads).map((t) => t.id)).not.toContain('t4')
  })
})
