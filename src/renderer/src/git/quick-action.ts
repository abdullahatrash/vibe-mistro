import type { GitStatus } from '../../../shared/ipc'

/**
 * The smart quick-action derivation (#236, PRD #233): pure `GitStatus` + PR-presence →
 * the PRIMARY action (what the commit-area button does/says) + the remaining
 * applicable actions (the attached menu). Mirrors t3code's GitActionsControl logic
 * layer. Supersedes #234's `buildSyncView` (which only covered the clean-tree
 * Push/Pull corner). The DIRTY-tree primaries follow t3code: with no PR the full
 * `Commit, push & PR` chain leads (shipping is the common case), with an open PR
 * `Commit & push` leads (the PR updates itself); plain `Commit` always stays one menu
 * click away. The CLEAN-tree primaries are the sync moves — diverged leads with Pull
 * (ff-only means you must reconcile before pushing anyway).
 */

/** What the quick action runs: the stacked-action kinds plus the two local-only moves. */
export type QuickActionKind = 'commit' | 'commit_push' | 'commit_push_pr' | 'push' | 'pull' | 'view_pr'

export interface QuickAction {
  kind: QuickActionKind
  label: string
}

export interface QuickActionView {
  /** The button — null when there is genuinely nothing to do (in-sync, no PR). */
  primary: QuickAction | null
  /** The attached menu's remaining applicable actions (possibly empty). */
  menu: QuickAction[]
}

const LABELS: Record<QuickActionKind, string> = {
  commit: 'Commit',
  commit_push: 'Commit & push',
  commit_push_pr: 'Commit, push & PR',
  push: 'Push',
  pull: 'Pull',
  view_pr: 'View PR',
}

function action(kind: QuickActionKind, label = LABELS[kind]): QuickAction {
  return { kind, label }
}

export function deriveQuickAction(status: GitStatus, hasPr: boolean): QuickActionView {
  if (!status.isRepo) return { primary: null, menu: [] }
  const dirty = status.files.length > 0
  const detached = status.branch === null

  if (dirty) {
    // Detached HEAD can commit but has no branch to push — nothing push-shaped.
    if (detached) return { primary: action('commit'), menu: [] }
    const menu: QuickAction[] = hasPr
      ? [action('commit')]
      : [action('commit_push'), action('commit')]
    if (status.behind > 0) menu.push(action('pull'))
    return { primary: action(hasPr ? 'commit_push' : 'commit_push_pr'), menu }
  }

  if (detached) return { primary: null, menu: [] }
  const noUpstream = status.upstream === null
  if (status.behind > 0) {
    // Diverged leads with Pull — ff-only pull must reconcile before a push can land.
    return { primary: action('pull'), menu: status.ahead > 0 ? [action('push')] : [] }
  }
  if (status.ahead > 0) return { primary: action('push'), menu: [] }
  if (noUpstream) return { primary: action('push', 'Publish branch'), menu: [] }
  if (hasPr) return { primary: action('view_pr'), menu: [] }
  return { primary: null, menu: [] }
}
