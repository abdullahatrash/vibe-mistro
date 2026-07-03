import { describe, it, expect } from 'vitest'
import { locateExcerptInPatch } from './review-comment'

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
