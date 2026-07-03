import { describe, it, expect } from 'vitest'
import { DIFF_PREFS_STORAGE_KEY, readDiffPrefs, writeDiffPrefs, type DiffPrefs } from './diff-prefs-store'

/**
 * The all-files diff view's persisted toggles (#235): Stacked/Split, word wrap,
 * ignore-whitespace. Tested through the injected-storage seam (the `side-panel-store`
 * pattern) — no jsdom; a Map-backed fake satisfies the storage slice.
 */

function fakeStorage(seed: Record<string, string> = {}): {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  map: Map<string, string>
} {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
  }
}

describe('readDiffPrefs', () => {
  it('returns the defaults on an empty storage', () => {
    expect(readDiffPrefs(fakeStorage())).toEqual({ diffStyle: 'unified', wrap: false, ignoreWhitespace: false })
  })

  it('returns the defaults on garbage (unparseable or wrong-shaped) storage', () => {
    expect(readDiffPrefs(fakeStorage({ [DIFF_PREFS_STORAGE_KEY]: 'not json' }))).toEqual({
      diffStyle: 'unified',
      wrap: false,
      ignoreWhitespace: false,
    })
    expect(readDiffPrefs(fakeStorage({ [DIFF_PREFS_STORAGE_KEY]: '{"diffStyle":"sideways","wrap":"yes"}' }))).toEqual(
      { diffStyle: 'unified', wrap: false, ignoreWhitespace: false },
    )
  })

  it('round-trips a written prefs object', () => {
    const storage = fakeStorage()
    const prefs: DiffPrefs = { diffStyle: 'split', wrap: true, ignoreWhitespace: true }
    writeDiffPrefs(storage, prefs)
    expect(readDiffPrefs(storage)).toEqual(prefs)
  })

  it('is throw-tolerant: a storage that throws yields defaults / a silent write', () => {
    const throwing = {
      getItem: (): string | null => {
        throw new Error('quota')
      },
      setItem: (): void => {
        throw new Error('quota')
      },
    }
    expect(readDiffPrefs(throwing)).toEqual({ diffStyle: 'unified', wrap: false, ignoreWhitespace: false })
    expect(() => writeDiffPrefs(throwing, { diffStyle: 'split', wrap: false, ignoreWhitespace: false })).not.toThrow()
  })
})
