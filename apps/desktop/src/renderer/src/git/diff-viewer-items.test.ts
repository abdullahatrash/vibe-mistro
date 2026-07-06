import { describe, it, expect } from 'vitest'
import {
  buildReviewDiffItemModels,
  reviewDiffItemVersion,
  type ReviewDiffFileInput,
} from './diff-viewer-items'

/**
 * Item-derivation for the one virtualized Review viewer (#388). The version hash is the
 * load-bearing bit: it must change iff something forces THIS file's item to re-render
 * (patch, collapse, draft, truncation, working-tree churn) and stay stable otherwise —
 * that stability is what keeps collapsing one file from re-rendering its siblings.
 */

const files: ReviewDiffFileInput[] = [
  { path: 'src/a.ts', diffHash: 'hash-a', truncated: false },
  { path: 'src/b.ts', diffHash: 'hash-b', truncated: false },
  { path: 'src/c.ts', diffHash: 'hash-c', truncated: true },
]

describe('buildReviewDiffItemModels', () => {
  it('mints one model per file, in order, id = path, preserving truncation', () => {
    const models = buildReviewDiffItemModels(files, { collapsed: new Set() })
    expect(models.map((m) => m.id)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(models.map((m) => m.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(models[2].truncated).toBe(true)
    expect(models.every((m) => m.collapsed === false && m.hasDraft === false)).toBe(true)
  })

  it('flags only the collapsed / drafted files and only re-versions those', () => {
    const base = buildReviewDiffItemModels(files, { collapsed: new Set() })
    const collapsed = buildReviewDiffItemModels(files, {
      collapsed: new Set(['src/b.ts']),
      draftPath: 'src/a.ts',
    })
    // a.ts: draft opened → version changed; b.ts: collapsed → version changed.
    expect(collapsed[0].hasDraft).toBe(true)
    expect(collapsed[0].version).not.toBe(base[0].version)
    expect(collapsed[1].collapsed).toBe(true)
    expect(collapsed[1].version).not.toBe(base[1].version)
    // c.ts: untouched → identical version, so its item never re-renders.
    expect(collapsed[2].version).toBe(base[2].version)
  })

  it('folds working-tree churn/glyph into the version but leaves branch entries meta-free', () => {
    const metaByPath = new Map([['src/a.ts', { glyph: 'M', insertions: 3, deletions: 1 }]])
    const withMeta = buildReviewDiffItemModels(files, { collapsed: new Set(), metaByPath })
    const noMeta = buildReviewDiffItemModels(files, { collapsed: new Set() })
    expect(withMeta[0].meta).toEqual({ glyph: 'M', insertions: 3, deletions: 1 })
    expect(withMeta[0].version).not.toBe(noMeta[0].version)
    expect(withMeta[1].meta).toBeUndefined()
  })
})

describe('reviewDiffItemVersion', () => {
  it('changes on any re-render trigger and is stable when nothing relevant moved', () => {
    const v = (over: Partial<Parameters<typeof reviewDiffItemVersion>[0]> = {}) =>
      reviewDiffItemVersion({
        diffHash: 'h',
        collapsed: false,
        truncated: false,
        hasDraft: false,
        meta: undefined,
        ...over,
      })
    const base = v()
    expect(v()).toBe(base)
    expect(v({ collapsed: true })).not.toBe(base)
    expect(v({ truncated: true })).not.toBe(base)
    expect(v({ hasDraft: true })).not.toBe(base)
    expect(v({ diffHash: 'h2' })).not.toBe(base)
    expect(v({ meta: { glyph: 'A', insertions: 1, deletions: 0 } })).not.toBe(base)
  })
})
