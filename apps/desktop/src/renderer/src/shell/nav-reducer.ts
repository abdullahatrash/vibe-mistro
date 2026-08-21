import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'
import type { BotFormTarget } from '../bots/bot-form'

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
   * the Skills browser (#259); `'bot-form'` for creating or editing a **Mistro Bot**
   * (#447) — all leave the Workspace/Thread selection intact so closing returns to
   * the same conversation. Any `select-workspace` / `select-thread` (picking a
   * project or thread from the sidebar) resets it to `'conversation'`.
   *
   * `'bot-form'` is NOT the Bots BROWSING view ADR-0027 rules out (decision 4, as
   * amended by #447): there is no list column, no nav row, and no way to browse Bots
   * in it — it is a transient form the sidebar's ＋ (or a Bot's Edit) opens and
   * Cancel/Save closes.
   */
  view: 'conversation' | 'settings' | 'skills' | 'bot-form'
  /**
   * WHICH Bot the form is for, when `view === 'bot-form'`; null otherwise.
   *
   * It lives in nav state rather than beside it because the view travels through
   * nav HISTORY, and a payload that does not travel with it produces a back arrow
   * that restores the form pointing at whatever was edited last — or at a Bot that
   * has since been deleted, which then reads as an offer to create a new one (#447
   * review, D1). Keep the two together and the history entry is self-describing.
   *
   * Optional so the many `view: 'conversation'` literals around the app (and their
   * tests) stay literal: absent means the same as null — no form.
   */
  botForm?: BotFormTarget | null
}

export type NavAction =
  | { type: 'select-workspace'; workspaceId: string }
  | { type: 'select-thread'; workspaceId: string; threadId: string }
  | { type: 'open-settings' }
  | { type: 'close-settings' }
  | { type: 'open-skills' }
  | { type: 'close-skills' }
  | { type: 'open-bot-form'; target: BotFormTarget }
  | { type: 'close-bot-form' }
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
        return state.view === 'conversation' ? state : toConversation(state)
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
      return {
        selectedWorkspaceId: action.workspaceId,
        selectedThreadId: action.threadId,
        view: 'conversation',
      }
    case 'open-settings':
      // Swap the outlet for the Settings page, PRESERVING the current selection.
      // Referential no-op when already in Settings (uniform with select-workspace).
      return state.view === 'settings' ? state : { ...withoutBotForm(state), view: 'settings' }
    case 'open-skills':
      // Swap the outlet for the Skills browser (#259) — same contract as Settings.
      return state.view === 'skills' ? state : { ...withoutBotForm(state), view: 'skills' }
    case 'open-bot-form':
      // Swap the outlet for the Bot create/edit form (#447) — same contract again:
      // the selection is preserved, so Cancel returns to what was on screen (a Bot's
      // own conversation, when the form was opened from its Edit). Re-opening the
      // SAME form is a referential no-op, so the ＋ pressed twice records one move.
      return state.view === 'bot-form' && sameBotFormTarget(state.botForm ?? null, action.target)
        ? state
        : { ...state, view: 'bot-form', botForm: action.target }
    case 'close-settings':
    case 'close-skills':
    case 'close-bot-form':
      // Return to the conversation view, PRESERVING the current selection.
      return state.view === 'conversation' ? state : toConversation(state)
    case 'clear':
      return initialNavState
  }
}

/**
 * Back to the conversation view, DROPPING the form payload with it — a `botForm`
 * left behind would travel into history entries that are not showing a form.
 *
 * The key is removed rather than nulled: absent is the canonical "no form", so a
 * state that never had one is indistinguishable from one that left it.
 */
function toConversation(state: NavState): NavState {
  return { ...withoutBotForm(state), view: 'conversation' }
}

/** The state minus its form payload (same ref when it has none). */
function withoutBotForm(state: NavState): NavState {
  if (state.botForm === undefined) return state
  return {
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedThreadId: state.selectedThreadId,
    view: state.view,
  }
}

/** Whether two form targets address the same thing (value equality, for no-ops). */
export function sameBotFormTarget(a: BotFormTarget | null, b: BotFormTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.mode === 'edit') return b.mode === 'edit' && a.threadId === b.threadId
  return b.mode === 'create' && a.workspaceId === b.workspaceId
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
