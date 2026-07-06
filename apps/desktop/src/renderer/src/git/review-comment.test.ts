import { describe, it, expect } from 'vitest'
import { locateExcerptInPatch, locateRangeInPatch } from './review-comment'

/**
 * The excerpt locator (#239): map the user's NATIVE text selection over a rendered
 * diff back to the patch's own lines — the verbatim +/-/space excerpt and the
 * new-file line range. Pure over the raw unified patch; the selection may carry
 * rendering artifacts (gutter line numbers, blank rows), which normalization drops.
 */

const patch = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,4 +1,5 @@
 const a = 1
-const b = 2
+const b = 20
+const c = 3
 const d = 4
@@ -10,3 +11,3 @@
 function f() {
-  return b
+  return b + c
 }
`

describe('locateExcerptInPatch', () => {
  it('locates a contiguous selection and returns the prefixed excerpt + new-file range', () => {
    const found = locateExcerptInPatch(patch, 'const b = 20\nconst c = 3\nconst d = 4')
    expect(found).toEqual({
      excerpt: '+const b = 20\n+const c = 3\n const d = 4',
      startLine: 2,
      endLine: 4,
    })
  })

  it('drops rendering artifacts: gutter numbers and blank lines in the selection', () => {
    const found = locateExcerptInPatch(patch, '2\n\nconst b = 20\n3\nconst c = 3\n')
    expect(found).toMatchObject({ startLine: 2, endLine: 3 })
  })

  it('numbers lines correctly inside a LATER hunk', () => {
    const found = locateExcerptInPatch(patch, 'return b + c\n}')
    expect(found).toEqual({ excerpt: '+  return b + c\n }', startLine: 12, endLine: 13 })
  })

  it('a selection spanning a DELETED line keeps it in the excerpt', () => {
    const found = locateExcerptInPatch(patch, 'const a = 1\nconst b = 2\nconst b = 20')
    expect(found?.excerpt).toBe(' const a = 1\n-const b = 2\n+const b = 20')
    expect(found).toMatchObject({ startLine: 1, endLine: 2 })
  })

  it('returns null when the selection matches nothing contiguous', () => {
    expect(locateExcerptInPatch(patch, 'const a = 1\nconst d = 4')).toBeNull()
    expect(locateExcerptInPatch(patch, 'not in the patch at all')).toBeNull()
    expect(locateExcerptInPatch(patch, '')).toBeNull()
  })
})

/**
 * The viewer-range locator (#388): the virtualized `CodeView` reports a structured
 * `SelectedLineRange` (side + line number) instead of raw selected text. Mapping it back
 * to the patch must produce the SAME excerpt + new-file range the native-selection path
 * does, so the staged comment stays byte-identical on the wire.
 */
describe('locateRangeInPatch', () => {
  it('maps an additions run to the same excerpt as the native selection', () => {
    // The additions-side twin of the `locateExcerptInPatch` "contiguous" case.
    expect(locateRangeInPatch(patch, { start: 2, side: 'additions', end: 4, endSide: 'additions' })).toEqual({
      excerpt: '+const b = 20\n+const c = 3\n const d = 4',
      startLine: 2,
      endLine: 4,
    })
  })

  it('numbers lines correctly inside a LATER hunk', () => {
    expect(locateRangeInPatch(patch, { start: 12, side: 'additions', end: 13 })).toEqual({
      excerpt: '+  return b + c\n }',
      startLine: 12,
      endLine: 13,
    })
  })

  it('keeps a spanned deletion between two additions-side endpoints', () => {
    expect(locateRangeInPatch(patch, { start: 1, side: 'additions', end: 2, endSide: 'additions' })).toEqual({
      excerpt: ' const a = 1\n-const b = 2\n+const b = 20',
      startLine: 1,
      endLine: 2,
    })
  })

  it('anchors a pure deletion to the new-file position it applied at', () => {
    expect(locateRangeInPatch(patch, { start: 2, side: 'deletions', end: 2, endSide: 'deletions' })).toEqual({
      excerpt: '-const b = 2',
      startLine: 2,
      endLine: 2,
    })
  })

  it('normalizes a reversed range (end before start)', () => {
    expect(locateRangeInPatch(patch, { start: 4, side: 'additions', end: 2, endSide: 'additions' })).toEqual(
      locateRangeInPatch(patch, { start: 2, side: 'additions', end: 4, endSide: 'additions' }),
    )
  })

  it('resolves a deletions-side start paired with an additions-side end', () => {
    expect(locateRangeInPatch(patch, { start: 2, side: 'deletions', end: 3, endSide: 'additions' })).toEqual({
      excerpt: '-const b = 2\n+const b = 20\n+const c = 3',
      startLine: 2,
      endLine: 3,
    })
  })

  it('returns null for an empty patch or an unlocatable endpoint', () => {
    expect(locateRangeInPatch('', { start: 1, end: 1 })).toBeNull()
    expect(locateRangeInPatch(patch, { start: 999, side: 'additions', end: 999 })).toBeNull()
  })
})
