import { describe, it, expect } from 'vitest'
import { deriveQuickAction } from './quick-action'
import type { GitFile, GitStatus } from '../../../shared/ipc'

/**
 * The smart quick-action derivation (#236, PRD #233): pure `GitStatus` + PR-presence →
 * the PRIMARY action (the button) + the remaining applicable actions (the attached
 * menu). Mirrors t3code's GitActionsControl logic layer. Table-driven — every repo
 * state permutation pins its primary.
 */

function file(path: string): GitFile {
  return { path, status: '.M', insertions: 1, deletions: 0, staged: false, untracked: false }
}

function status(partial: Partial<GitStatus>): GitStatus {
  return { isRepo: true, branch: 'feat/x', upstream: 'origin/feat/x', ahead: 0, behind: 0, files: [], ...partial }
}

const kinds = (s: GitStatus, hasPr = false): { primary: string | null; menu: string[] } => {
  const qa = deriveQuickAction(s, hasPr)
  return { primary: qa.primary?.kind ?? null, menu: qa.menu.map((a) => a.kind) }
}

describe('deriveQuickAction: dirty tree', () => {
  it('no PR: primary is the full chain (Commit, push & PR), menu offers the shorter forms', () => {
    expect(kinds(status({ files: [file('a.txt')] }))).toEqual({
      primary: 'commit_push_pr',
      menu: ['commit_push', 'commit'],
    })
  })

  it('PR already open: primary is Commit & push (the PR updates itself), plain commit in the menu', () => {
    expect(kinds(status({ files: [file('a.txt')] }), true)).toEqual({
      primary: 'commit_push',
      menu: ['commit'],
    })
  })

  it('detached HEAD: plain Commit only — nothing push-shaped', () => {
    expect(kinds(status({ files: [file('a.txt')], branch: null, upstream: null }))).toEqual({
      primary: 'commit',
      menu: [],
    })
  })

  it('dirty AND behind: pull joins the menu (the user may want to sync first)', () => {
    expect(kinds(status({ files: [file('a.txt')], behind: 2 })).menu).toContain('pull')
  })
})

describe('deriveQuickAction: clean tree', () => {
  it('ahead: primary Push', () => {
    expect(kinds(status({ ahead: 2 }))).toEqual({ primary: 'push', menu: [] })
  })

  it('behind: primary Pull', () => {
    expect(kinds(status({ behind: 3 }))).toEqual({ primary: 'pull', menu: [] })
  })

  it('diverged: primary Pull (must reconcile first), Push in the menu', () => {
    expect(kinds(status({ ahead: 1, behind: 1 }))).toEqual({ primary: 'pull', menu: ['push'] })
  })

  it('no upstream on a branch: primary Push labelled as publishing', () => {
    const qa = deriveQuickAction(status({ upstream: null }), false)
    expect(qa.primary).toEqual({ kind: 'push', label: 'Publish branch' })
  })

  it('in sync with a PR: primary View PR', () => {
    expect(kinds(status({}), true)).toEqual({ primary: 'view_pr', menu: [] })
  })

  it('in sync, no PR: no primary at all (nothing to do)', () => {
    expect(kinds(status({}))).toEqual({ primary: null, menu: [] })
  })

  it('non-repo: nothing', () => {
    expect(kinds(status({ isRepo: false }))).toEqual({ primary: null, menu: [] })
  })
})
