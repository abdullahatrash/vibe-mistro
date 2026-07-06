import { describe, it, expect } from 'vitest'
import { fnv1a32, buildPatchCacheKey } from './patch-cache-key'

describe('fnv1a32', () => {
  it('is deterministic for the same input and seed/multiplier', () => {
    expect(fnv1a32('const x = 1')).toBe(fnv1a32('const x = 1'))
  })

  it('differs for different input', () => {
    expect(fnv1a32('const x = 1')).not.toBe(fnv1a32('const x = 2'))
  })

  it('differs for the same input under a different seed (the "secondary" hash)', () => {
    const primary = fnv1a32('const x = 1', 0x811c9dc5, 0x01000193)
    const secondary = fnv1a32('const x = 1', 0x9e3779b9, 0x85ebca6b)
    expect(primary).not.toBe(secondary)
  })

  it('always returns an unsigned 32-bit integer', () => {
    // A long, high-charcode-heavy input exercises the >>> 0 coercions.
    const input = '💥'.repeat(10_000)
    const hash = fnv1a32(input)
    expect(Number.isInteger(hash)).toBe(true)
    expect(hash).toBeGreaterThanOrEqual(0)
    expect(hash).toBeLessThanOrEqual(0xffffffff)
  })

  it('handles the empty string', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5)
  })
})

describe('buildPatchCacheKey', () => {
  it('is a stable key: same patch → same key', () => {
    const patch = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n'
    expect(buildPatchCacheKey(patch)).toBe(buildPatchCacheKey(patch))
  })

  it('differs for different patch content', () => {
    const a = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n'
    const b = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+different\n'
    expect(buildPatchCacheKey(a)).not.toBe(buildPatchCacheKey(b))
  })

  it('is insensitive to leading/trailing whitespace (normalizes via trim)', () => {
    const patch = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new'
    expect(buildPatchCacheKey(`${patch}\n\n`)).toBe(buildPatchCacheKey(patch))
    expect(buildPatchCacheKey(`  ${patch}`)).toBe(buildPatchCacheKey(patch))
  })

  it('namespaces by scope: same content, different scope → different key', () => {
    const patch = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n'
    expect(buildPatchCacheKey(patch, 'scope-a')).not.toBe(buildPatchCacheKey(patch, 'scope-b'))
  })

  it('embeds the normalized content length, guarding against pure-hash collisions', () => {
    const patch = 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new'
    expect(buildPatchCacheKey(patch)).toContain(`:${patch.length}:`)
  })

  it('produces distinct keys across a batch of similar patches (no accidental collisions)', () => {
    const keys = new Set<string>()
    for (let index = 0; index < 500; index += 1) {
      keys.add(buildPatchCacheKey(`diff --git a/file-${index}.ts b/file-${index}.ts\n@@ -1 +1 @@\n-old\n+new-${index}\n`))
    }
    expect(keys.size).toBe(500)
  })
})
