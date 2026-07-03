import { initialNavState, navReducer, type NavAction, type NavState } from './nav-reducer'

/**
 * Browser-style back/forward over shell navigation: a pure history wrapper around
 * `navReducer` (the undo/redo shape — past / present / future). The header's arrow
 * buttons dispatch `history-back` / `history-forward`; every ordinary NavAction
 * flows through unchanged, so `navDispatch` call sites don't know history exists.
 *
 * Two rules keep the stack honest:
 * - A referential no-op from navReducer (re-selecting the current Thread, opening
 *   Settings while in Settings) records NOTHING — the arrows only walk real moves.
 * - Any new move CLEARS the forward stack, exactly like a browser.
 *
 * History is renderer-session-only (not persisted): like a browser tab, a fresh
 * window starts with no past.
 */
export interface NavHistoryState {
  past: NavState[]
  present: NavState
  future: NavState[]
}

export type NavHistoryAction = NavAction | { type: 'history-back' } | { type: 'history-forward' }

export const initialNavHistory: NavHistoryState = {
  past: [],
  present: initialNavState,
  future: [],
}

/** Bound so a long session can't grow the stack without limit (browser-like cap). */
export const MAX_NAV_HISTORY = 50

export function navHistoryReducer(
  state: NavHistoryState,
  action: NavHistoryAction,
): NavHistoryState {
  switch (action.type) {
    case 'history-back': {
      const previous = state.past.at(-1)
      if (previous === undefined) return state
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
      }
    }
    case 'history-forward': {
      const [next, ...rest] = state.future
      if (next === undefined) return state
      return {
        past: [...state.past, state.present],
        present: next,
        future: rest,
      }
    }
    default: {
      const next = navReducer(state.present, action)
      if (next === state.present) return state
      return {
        past: [...state.past, state.present].slice(-MAX_NAV_HISTORY),
        present: next,
        future: [],
      }
    }
  }
}
