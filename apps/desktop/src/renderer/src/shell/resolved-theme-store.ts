import { useSyncExternalStore } from 'react'
import type { ResolvedTheme, ThemeState } from '../../../shared/ipc'

let currentState: ThemeState = { preference: 'light', resolved: 'light' }
const listeners = new Set<() => void>()

export function getThemeState(): ThemeState {
  return currentState
}

export function getResolvedTheme(): ResolvedTheme {
  return currentState.resolved
}

export function subscribeThemeState(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Main-to-renderer write path; repeated states do not rerender subscribers. */
export function setThemeState(state: ThemeState): void {
  if (state.preference === currentState.preference && state.resolved === currentState.resolved) return
  currentState = state
  for (const listener of listeners) listener()
}

export function useThemeState(): ThemeState {
  return useSyncExternalStore(subscribeThemeState, getThemeState)
}

export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeThemeState, getResolvedTheme)
}
