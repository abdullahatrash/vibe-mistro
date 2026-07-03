/**
 * The Browser Surface's load-state machine (#217). The webview's load lifecycle arrives
 * as ordered DOM events; this pure reducer turns them into the four UI states (idle /
 * loading / loaded / failed) so the view is a thin switch. Kept pure + unit-tested
 * because the ordering has a GOTCHA: Electron fires `did-stop-loading` AFTER
 * `did-fail-load`, so a naive "stop → loaded" would clobber the failure — `onStopLoad`
 * must preserve a `failed` state.
 */
export type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'loaded' }
  | { status: 'failed'; url: string; code: number }

export const INITIAL_LOAD: LoadState = { status: 'idle' }

/** A load began (did-start-loading) — always enters `loading`, clearing a prior failure. */
export function onStartLoad(): LoadState {
  return { status: 'loading' }
}

/**
 * A load finished (did-stop-loading). Because this fires AFTER `did-fail-load`, it must
 * NOT overwrite a `failed` state — only a non-failed load resolves to `loaded`.
 */
export function onStopLoad(state: LoadState): LoadState {
  return state.status === 'failed' ? state : { status: 'loaded' }
}

/**
 * A load failed (did-fail-load). Chromium's ERR_ABORTED (-3) is a superseded/cancelled
 * load (the user navigated away mid-load), NOT a reachability failure — ignore it.
 */
export function onFailLoad(state: LoadState, url: string, code: number): LoadState {
  if (code === -3) return state
  return { status: 'failed', url, code }
}
