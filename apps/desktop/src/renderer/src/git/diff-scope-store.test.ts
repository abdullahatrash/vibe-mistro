import { describe, it, expect } from 'vitest'
import { DIFF_SCOPE_STORAGE_KEY, readDiffScope, writeDiffScope } from './diff-scope-store'

/**
 * The Review Surface's persisted diff scope (#237): Working tree vs Branch changes +
 * the chosen base ref, PER WORKSPACE (unlike the global diff prefs — which branch you
 * review against is workspace state). Injected-storage seam, DOM-free tests.
 */

function fakeStorage(seed: Record<string, string> = {}): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
} {
  const map = new Map(Object.entries(seed))
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) }
}

describe('readDiffScope', () => {
  it('defaults to the working tree with an Automatic base', () => {
    expect(readDiffScope(fakeStorage(), '/ws')).toEqual({ scope: 'working', baseRef: null })
  })

  it('round-trips per Workspace — another Workspace keeps its own entry', () => {
    const storage = fakeStorage()
    writeDiffScope(storage, '/a', { scope: 'branch', baseRef: 'origin/main' })
    writeDiffScope(storage, '/b', { scope: 'working', baseRef: null })
    expect(readDiffScope(storage, '/a')).toEqual({ scope: 'branch', baseRef: 'origin/main' })
    expect(readDiffScope(storage, '/b')).toEqual({ scope: 'working', baseRef: null })
  })

  it('coerces garbage (bad JSON / wrong shapes) to the default', () => {
    expect(readDiffScope(fakeStorage({ [DIFF_SCOPE_STORAGE_KEY]: 'nope' }), '/ws')).toEqual({
      scope: 'working',
      baseRef: null,
    })
    expect(
      readDiffScope(fakeStorage({ [DIFF_SCOPE_STORAGE_KEY]: '{"/ws":{"scope":"upside-down","baseRef":7}}' }), '/ws'),
    ).toEqual({ scope: 'working', baseRef: null })
  })

  it('is throw-tolerant on both read and write', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('quota')
      },
      setItem: (): void => {
        throw new Error('quota')
      },
    }
    expect(readDiffScope(throwing, '/ws')).toEqual({ scope: 'working', baseRef: null })
    expect(() => writeDiffScope(throwing, '/ws', { scope: 'branch', baseRef: null })).not.toThrow()
  })
})
