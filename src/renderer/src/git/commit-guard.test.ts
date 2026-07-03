import { describe, it, expect } from 'vitest'
import { autoCommitMessage, isDefaultBranch, suggestBranchName } from './commit-guard'
import type { GitBranch } from '../../../shared/ipc'

/**
 * Pure seams for slice 3 (#238, PRD #233): the heuristic auto commit message. The
 * heuristic lives renderer-side (not main) because the SAME string must show as the
 * textarea's placeholder BEFORE the commit — the renderer substitutes it for a blank
 * message at submit, so what you see is exactly what gets committed.
 */

/** Minimal file shape: the view's sorted files (path + display glyph). */
function f(path: string, glyph = 'M'): { path: string; glyph: string } {
  return { path, glyph }
}

describe('autoCommitMessage', () => {
  it('returns the empty string for no files (nothing to describe)', () => {
    expect(autoCommitMessage([])).toBe('')
  })

  it('one modified file: "Update <basename>"', () => {
    expect(autoCommitMessage([f('src/renderer/src/git/ChangesPanel.tsx')])).toBe('Update ChangesPanel.tsx')
  })

  it('maps each glyph family to its verb (untracked counts as Add)', () => {
    expect(autoCommitMessage([f('a.txt', 'A')])).toBe('Add a.txt')
    expect(autoCommitMessage([f('a.txt', 'U')])).toBe('Add a.txt')
    expect(autoCommitMessage([f('a.txt', 'D')])).toBe('Delete a.txt')
    expect(autoCommitMessage([f('a.txt', 'R')])).toBe('Rename a.txt')
    expect(autoCommitMessage([f('a.txt', 'C')])).toBe('Update a.txt')
  })

  it('the DOMINANT verb wins and the headline is the first file of that verb', () => {
    const files = [f('m.txt', 'M'), f('new1.txt', 'U'), f('new2.txt', 'A')]
    // Add (U+A = 2) beats Update (1); headline = first Add-family file in view order.
    expect(autoCommitMessage(files)).toBe('Add new1.txt and 2 more')
  })

  it('counts the OTHER files, singular/plural', () => {
    expect(autoCommitMessage([f('a.txt'), f('b.txt')])).toBe('Update a.txt and 1 more')
    expect(autoCommitMessage([f('a.txt'), f('b.txt'), f('c.txt')])).toBe('Update a.txt and 2 more')
  })

  it('a verb TIE falls back to Update-first ordering (stable, unsurprising)', () => {
    // 1 M + 1 A: tie → Update wins, headline is the M file.
    expect(autoCommitMessage([f('new.txt', 'A'), f('mod.txt', 'M')])).toBe('Update mod.txt and 1 more')
  })
})

function branch(partial: Partial<GitBranch> & { name: string }): GitBranch {
  return { isRemote: false, current: false, isDefault: false, ...partial }
}

describe('isDefaultBranch', () => {
  const branches = [
    branch({ name: 'main', isDefault: true }),
    branch({ name: 'feat/x', current: true }),
    branch({ name: 'origin/other', isRemote: true }),
  ]

  it('true only when the CURRENT branch name is the LOCAL default', () => {
    expect(isDefaultBranch('main', branches)).toBe(true)
    expect(isDefaultBranch('feat/x', branches)).toBe(false)
  })

  it('a REMOTE entry named like the branch does not count (local default only)', () => {
    const remoteDefault = [branch({ name: 'origin/main', isRemote: true, isDefault: true })]
    expect(isDefaultBranch('origin/main', remoteDefault)).toBe(false)
  })

  it('unresolved default (no isDefault anywhere) or a null branch → false (no guard)', () => {
    expect(isDefaultBranch('main', [branch({ name: 'main' })])).toBe(false)
    expect(isDefaultBranch(null, branches)).toBe(false)
  })
})

describe('suggestBranchName', () => {
  it('slugifies the message: lowercase, non-alphanumerics collapse to single dashes', () => {
    expect(suggestBranchName('Update ChangesPanel.tsx and 2 more')).toBe('update-changespanel-tsx-and-2-more')
  })

  it('trims leading/trailing dashes and caps the length', () => {
    expect(suggestBranchName('  !!Fix: the (thing)!!  ')).toBe('fix-the-thing')
    expect(suggestBranchName('x'.repeat(100)).length).toBeLessThanOrEqual(40)
  })

  it('an empty/unusable message falls back to "changes"', () => {
    expect(suggestBranchName('')).toBe('changes')
    expect(suggestBranchName('!!!')).toBe('changes')
  })
})
