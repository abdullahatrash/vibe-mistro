/**
 * A pure back/forward availability model for the Browser Surface (#216). The Electron
 * `<webview>` tag's own `canGoBack()`/`canGoForward()` are unreliable (they report
 * `false` against a genuine multi-entry history), so we track availability from
 * navigation EVENTS instead: a simple `{index, length}` cursor the component advances
 * on each new navigation and shifts on back/forward. Deliberately a small pure module
 * so the edge cases (truncate-on-branch, end-of-list no-ops) are unit-tested DOM-free.
 */
export interface NavState {
  /** The active entry's 0-based position, or -1 before the first navigation. */
  index: number
  /** How many entries the history holds. */
  length: number
}

/** Before any navigation: nowhere to go. */
export const INITIAL_NAV: NavState = { index: -1, length: 0 }

/**
 * A brand-new navigation (first load, URL-bar submit, link click, guest redirect):
 * truncate any forward entries and push a new tip, landing on it.
 */
export function pushNav(state: NavState): NavState {
  const index = state.index + 1
  return { index, length: index + 1 }
}

/** Move back one entry (a no-op — same reference — at the first entry). */
export function goBackNav(state: NavState): NavState {
  return state.index > 0 ? { ...state, index: state.index - 1 } : state
}

/** Move forward one entry (a no-op — same reference — at the tip). */
export function goForwardNav(state: NavState): NavState {
  return state.index < state.length - 1 ? { ...state, index: state.index + 1 } : state
}

/** Whether a Back is possible. */
export function canGoBackNav(state: NavState): boolean {
  return state.index > 0
}

/** Whether a Forward is possible. */
export function canGoForwardNav(state: NavState): boolean {
  return state.index < state.length - 1
}
