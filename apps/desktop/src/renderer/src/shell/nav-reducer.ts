import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'

/**
 * Shell navigation state (ADR-0006 decision 2): WHICH Workspace and Thread the
 * user is looking at — decoupled from connection lifecycle (whether that
 * Workspace's agent is spawned / signed in). A pure reducer at the shell root,
 * mirroring conversation/reducer.ts (ADR-0001): no router, no UI-store library.
 *
 * Invariant: a selected Thread always belongs to the selected Workspace — every
 * `select-thread` carries its `workspaceId`, and switching Workspace drops a
 * Thread selection that no longer belongs.
 */
export interface NavState {
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  /**
   * WHICH top-level outlet view is showing (#130). `'settings'` swaps the outlet for
   * the on-demand Settings page (env/CLI status + future settings); `'skills'` for
   * the Skills browser (#259) — both leave the Workspace/Thread selection intact so
   * closing returns to the same conversation. Any `select-workspace` / `select-thread`
   * (picking a project or thread from the sidebar) resets it to `'conversation'`.
   */
  view: 'conversation' | 'settings' | 'skills'
}

export type NavAction =
  | { type: 'select-workspace'; workspaceId: string }
  | { type: 'select-thread'; workspaceId: string; threadId: string }
  | { type: 'open-settings' }
  | { type: 'close-settings' }
  | { type: 'open-skills' }
  | { type: 'close-skills' }
  | { type: 'clear' }

export const initialNavState: NavState = {
  selectedWorkspaceId: null,
  selectedThreadId: null,
  view: 'conversation',
}

export function navReducer(state: NavState, action: NavAction): NavState {
  switch (action.type) {
    case 'select-workspace':
      // Re-selecting the SAME Workspace keeps any Thread selection; switching to a
      // different one drops the now-foreign Thread selection so the two can never
      // disagree. Either way this leaves Settings (resets `view` to conversation) —
      // but the same-Workspace path stays a referential no-op when ALREADY in the
      // conversation view, so re-selecting the current project never re-renders.
      if (state.selectedWorkspaceId === action.workspaceId) {
        return state.view === 'conversation' ? state : { ...state, view: 'conversation' }
      }
      return { selectedWorkspaceId: action.workspaceId, selectedThreadId: null, view: 'conversation' }
    case 'select-thread':
      // Selecting a Thread pins its Workspace too, so the two never disagree — and
      // leaves Settings (picking a thread returns to the conversation view).
      // Re-selecting the CURRENT Thread in the conversation view is a referential
      // no-op (uniform with select-workspace) — it keeps a connect's redundant
      // re-select (applyConnectResult) out of the back/forward history.
      if (
        state.selectedWorkspaceId === action.workspaceId &&
        state.selectedThreadId === action.threadId &&
        state.view === 'conversation'
      ) {
        return state
      }
      return { selectedWorkspaceId: action.workspaceId, selectedThreadId: action.threadId, view: 'conversation' }
    case 'open-settings':
      // Swap the outlet for the Settings page, PRESERVING the current selection.
      // Referential no-op when already in Settings (uniform with select-workspace).
      return state.view === 'settings' ? state : { ...state, view: 'settings' }
    case 'open-skills':
      // Swap the outlet for the Skills browser (#259) — same contract as Settings.
      return state.view === 'skills' ? state : { ...state, view: 'skills' }
    case 'close-settings':
    case 'close-skills':
      // Return to the conversation view, PRESERVING the current selection.
      return state.view === 'conversation' ? state : { ...state, view: 'conversation' }
    case 'clear':
      return initialNavState
  }
}

/**
 * The selected Thread's cold metadata, or null when nothing is selected or the
 * selection no longer exists (e.g. after a delete refreshed the list). The idle
 * outlet reopens this Thread read-only (ColdThread); a null collapses to the
 * placeholder, so a deleted/absent selection never renders a gone transcript. The
 * lookup is scoped to the selected Workspace, upholding the reducer's invariant.
 */
export function findSelectedThread(
  workspaces: ListMetadataResult,
  state: NavState,
): ThreadMeta | null {
  if (state.selectedThreadId === null) return null
  const workspace = workspaces.find((w) => w.id === state.selectedWorkspaceId)
  return workspace?.threads.find((t) => t.id === state.selectedThreadId) ?? null
}
