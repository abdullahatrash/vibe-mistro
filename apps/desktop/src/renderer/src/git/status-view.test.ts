import { describe, it, expect } from 'vitest'
import { buildChangesView, diffRequestKey, fileGlyph, glyphClass, reconcileUnchecked } from './status-view'
import type { GitFile, GitStatus } from '../../../shared/ipc'

function file(partial: Partial<GitFile> & { path: string }): GitFile {
  return {
    status: '.M',
    insertions: 0,
    deletions: 0,
    staged: false,
    untracked: false,
    ...partial,
  }
}

describe('fileGlyph', () => {
  it('maps each porcelain XY family to a glyph + label', () => {
    expect(fileGlyph(file({ path: 'a', status: '?', untracked: true }))).toEqual({ glyph: 'U', label: 'Untracked' })
    expect(fileGlyph(file({ path: 'a', status: '.M' }))).toEqual({ glyph: 'M', label: 'Modified' })
    expect(fileGlyph(file({ path: 'a', status: 'A.' }))).toEqual({ glyph: 'A', label: 'Added' })
    expect(fileGlyph(file({ path: 'a', status: '.D' }))).toEqual({ glyph: 'D', label: 'Deleted' })
    expect(fileGlyph(file({ path: 'a', status: 'RM' }))).toEqual({ glyph: 'R', label: 'Renamed' })
  })
})

describe('glyphClass', () => {
  it('accents added/untracked positive, deleted negative, else neutral', () => {
    expect(glyphClass('A')).toBe('text-ok')
    expect(glyphClass('U')).toBe('text-ok')
    expect(glyphClass('D')).toBe('text-bad')
    expect(glyphClass('M')).toBe('text-accent-text')
    expect(glyphClass('R')).toBe('text-accent-text')
    expect(glyphClass('C')).toBe('text-accent-text')
  })
})

describe('buildChangesView', () => {
  const status: GitStatus = {
    isRepo: true,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
    files: [
      file({ path: 'z.txt', status: '?', untracked: true }),
      file({ path: 'a.txt', status: '.M', insertions: 3, deletions: 1 }),
      file({ path: 'b.txt', status: 'A.', insertions: 5, deletions: 0, staged: true }),
    ],
  }

  it('groups by glyph rank then path, and rolls up header + churn', () => {
    const view = buildChangesView(status)
    expect(view.branch).toBe('main')
    expect(view.detached).toBe(false)
    expect(view.ahead).toBe(2)
    expect(view.behind).toBe(1)
    expect(view.fileCount).toBe(3)
    expect(view.totalInsertions).toBe(8)
    expect(view.totalDeletions).toBe(1)
    // Modified (a.txt) before Added (b.txt) before Untracked (z.txt).
    expect(view.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt', 'z.txt'])
    expect(view.files.map((f) => f.glyph)).toEqual(['M', 'A', 'U'])
  })

  it('labels a detached HEAD', () => {
    const view = buildChangesView({ ...status, branch: null, files: [] })
    expect(view.branch).toBe('HEAD')
    expect(view.detached).toBe(true)
  })
})

describe('diffRequestKey', () => {
  it('is stable for the same file set + churn', () => {
    const files = [file({ path: 'a.txt', insertions: 1 }), file({ path: 'b.txt', deletions: 2 })]
    expect(diffRequestKey(files)).toBe(diffRequestKey([...files]))
  })

  it('changes when a file’s churn changes (an edit mid-view must refetch)', () => {
    const before = [file({ path: 'a.txt', insertions: 1 })]
    const after = [file({ path: 'a.txt', insertions: 2 })]
    expect(diffRequestKey(before)).not.toBe(diffRequestKey(after))
  })

  it('changes when a file enters or leaves the changed set', () => {
    const one = [file({ path: 'a.txt' })]
    const two = [file({ path: 'a.txt' }), file({ path: 'b.txt' })]
    expect(diffRequestKey(one)).not.toBe(diffRequestKey(two))
  })

  it('changes when a path flips tracked ↔ untracked (the diff form changes)', () => {
    const tracked = [file({ path: 'a.txt', untracked: false })]
    const untracked = [file({ path: 'a.txt', untracked: true, status: '?' })]
    expect(diffRequestKey(tracked)).not.toBe(diffRequestKey(untracked))
  })
})

describe('reconcileUnchecked', () => {
  it('drops a deselected path that has vanished from the changed set', () => {
    const next = reconcileUnchecked(new Set(['a.txt', 'gone.txt']), ['a.txt', 'b.txt'])
    expect([...next]).toEqual(['a.txt'])
  })

  it('keeps a NEW file selected by default (it is absent from the set)', () => {
    // `new.txt` appears in the changed set but not in `unchecked` → stays selected.
    const next = reconcileUnchecked(new Set(['a.txt']), ['a.txt', 'new.txt'])
    expect([...next]).toEqual(['a.txt'])
  })

  it('returns the SAME set ref when nothing changed (no needless re-render)', () => {
    const unchecked = new Set(['a.txt'])
    expect(reconcileUnchecked(unchecked, ['a.txt', 'b.txt'])).toBe(unchecked)
  })

  it('returns a NEW set when an entry was dropped (ref changes)', () => {
    const unchecked = new Set(['gone.txt'])
    const next = reconcileUnchecked(unchecked, ['a.txt'])
    expect(next).not.toBe(unchecked)
    expect(next.size).toBe(0)
  })
})
