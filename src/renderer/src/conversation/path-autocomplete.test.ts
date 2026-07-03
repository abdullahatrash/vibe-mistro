import { describe, it, expect } from 'vitest'
import {
  applyPath,
  filterPaths,
  getPathQuery,
  moveSelection,
  removePathToken,
  MAX_PATH_RESULTS,
} from './path-autocomplete'
import type { FileEntry } from '../../../shared/ipc'

/**
 * `@` file-path autocomplete (#190, ADR-0013 decision 5): the pure derivation behind the
 * composer's path popover — mid-sentence trigger detection, substring-then-subsequence
 * ranking, the plain-text insertion transform (file space vs directory slash), and the
 * shared wrapping selection. All DOM-free, so these exercise the logic as plain data with
 * no renderer. Mirrors the `/` command-autocomplete suite.
 */

const ENTRIES: FileEntry[] = [
  { path: 'src', kind: 'directory' },
  { path: 'src/index.ts', kind: 'file' },
  { path: 'src/reducer.ts', kind: 'file' },
  { path: 'README.md', kind: 'file' },
  { path: 'docs', kind: 'directory' },
]

describe('getPathQuery — mid-sentence trigger detection', () => {
  it('activates on an `@`-token at input start with the caret after the `@`', () => {
    expect(getPathQuery('@src', 4)).toEqual({ active: true, query: 'src', start: 0 })
  })

  it('reports an empty query right after a bare `@`', () => {
    expect(getPathQuery('@', 1)).toEqual({ active: true, query: '', start: 0 })
  })

  it('activates MID-SENTENCE (the key difference from `/`)', () => {
    // "see @src" — the `@` opens at index 4 even though it is not at the line start.
    expect(getPathQuery('see @src', 8)).toEqual({ active: true, query: 'src', start: 4 })
  })

  it('takes the LAST `@` before the caret when several are present', () => {
    expect(getPathQuery('@a @b', 5)).toEqual({ active: true, query: 'b', start: 3 })
  })

  it('does NOT activate once the token is closed by a space', () => {
    expect(getPathQuery('@src ', 5).active).toBe(false)
  })

  it('does NOT activate when whitespace sits between the `@` and the caret', () => {
    // "@src foo" with the caret inside `foo` — the token closed at the space.
    expect(getPathQuery('@src foo', 8).active).toBe(false)
  })

  it('does NOT activate when there is no `@` before the caret', () => {
    expect(getPathQuery('hello world', 5).active).toBe(false)
  })

  it('does NOT activate when the caret rests on the `@` itself', () => {
    expect(getPathQuery('@src', 0).active).toBe(false)
  })

  it('uses the caret, not the end of value, for the query', () => {
    // Caret sits after `sr`, before the trailing `c`.
    expect(getPathQuery('@src', 3)).toEqual({ active: true, query: 'sr', start: 0 })
  })

  it('stays active for a directory fragment ending in a slash (dir continuation)', () => {
    expect(getPathQuery('@src/', 5)).toEqual({ active: true, query: 'src/', start: 0 })
  })

  it('clamps an out-of-range caret rather than throwing', () => {
    expect(getPathQuery('@src', 99)).toEqual({ active: true, query: 'src', start: 0 })
    expect(getPathQuery('@src', -5).active).toBe(false)
  })
})

describe('filterPaths — substring then subsequence, case-insensitive, ≤10, dirs included', () => {
  it('keeps the listing head for an empty query', () => {
    expect(filterPaths(ENTRIES, '')).toEqual(ENTRIES)
  })

  it('orders substring matches before subsequence (fuzzy) matches', () => {
    // `reducer` substring-matches `src/reducer.ts`; `README.md` matches only as a
    // subsequence (r-e-…-d-…), so it ranks after.
    expect(filterPaths(ENTRIES, 'red').map((e) => e.path)).toEqual([
      'src/reducer.ts',
      'README.md',
    ])
  })

  it('is case-insensitive on both sides', () => {
    expect(filterPaths(ENTRIES, 'SRC').map((e) => e.path)).toEqual([
      'src',
      'src/index.ts',
      'src/reducer.ts',
    ])
  })

  it('includes directories alongside files', () => {
    const kinds = filterPaths(ENTRIES, 'src').map((e) => e.kind)
    expect(kinds).toContain('directory')
    expect(kinds).toContain('file')
  })

  it('drops non-matches', () => {
    expect(filterPaths(ENTRIES, 'zzz')).toEqual([])
  })

  it(`caps the result at ${MAX_PATH_RESULTS}`, () => {
    const many: FileEntry[] = Array.from({ length: 25 }, (_, i) => ({
      path: `file-${i}.ts`,
      kind: 'file',
    }))
    expect(filterPaths(many, 'file')).toHaveLength(MAX_PATH_RESULTS)
  })

  it('preserves listing order within each rank group', () => {
    const entries: FileEntry[] = [
      { path: 'ab.ts', kind: 'file' },
      { path: 'xa_b.ts', kind: 'file' },
      { path: 'a-b.ts', kind: 'file' },
    ]
    // Query `ab`: substring group is ab.ts, a-b?no. `ab` substring: ab.ts only; `a-b.ts`
    // and `xa_b.ts` match only as subsequences (a…b), kept in listing order.
    expect(filterPaths(entries, 'ab').map((e) => e.path)).toEqual([
      'ab.ts',
      'xa_b.ts',
      'a-b.ts',
    ])
  })
})

describe('applyPath — plain-text insertion transform', () => {
  it('inserts a FILE with a trailing space and places the caret after it', () => {
    expect(applyPath('@re', 0, 3, { path: 'src/reducer.ts', kind: 'file' })).toEqual({
      value: '@src/reducer.ts ',
      caret: 16,
    })
  })

  it('inserts a DIRECTORY with a trailing slash and no space (continuation)', () => {
    expect(applyPath('@sr', 0, 3, { path: 'src', kind: 'directory' })).toEqual({
      value: '@src/',
      caret: 5,
    })
  })

  it('keeps text after the caret intact', () => {
    const out = applyPath('@re rest', 0, 3, { path: 'README.md', kind: 'file' })
    expect(out.value).toBe('@README.md  rest')
    expect(out.caret).toBe(11)
  })

  it('applies to a token that starts mid-sentence', () => {
    const out = applyPath('see @sr done', 4, 7, { path: 'src', kind: 'directory' })
    expect(out.value).toBe('see @src/ done')
    expect(out.caret).toBe(9)
  })
})

describe('removePathToken — chip-accept transform (#230)', () => {
  it('removes the `@query` token and rests the caret where it began', () => {
    expect(removePathToken('@re', 0, 3)).toEqual({ value: '', caret: 0 })
  })

  it('removes a mid-sentence token, keeping text either side intact', () => {
    expect(removePathToken('see @re done', 4, 7)).toEqual({ value: 'see  done', caret: 4 })
  })
})

describe('moveSelection — wrapping (shared with the `/` core)', () => {
  it('advances within range', () => {
    expect(moveSelection(0, 3, 1)).toBe(1)
  })

  it('wraps past the end', () => {
    expect(moveSelection(2, 3, 1)).toBe(0)
  })

  it('wraps past the start', () => {
    expect(moveSelection(0, 3, -1)).toBe(2)
  })

  it('clamps to 0 for an empty list', () => {
    expect(moveSelection(0, 0, 1)).toBe(0)
  })
})
