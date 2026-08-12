import type { ThemeState } from '../../../shared/ipc'
import { setThemeState } from './resolved-theme-store'

/** Apply main's resolved state to the document and renderer theme store. */
export function applyThemeState(state: ThemeState): void {
  document.documentElement.classList.toggle('dark', state.resolved === 'dark')
  setThemeState(state)
}

/** Subscribe before reading so a concurrent push cannot be reverted by a stale snapshot. */
export async function startThemeSync(api: {
  getTheme: () => Promise<ThemeState>
  onThemeStatus: (listener: (state: ThemeState) => void) => () => void
}): Promise<() => void> {
  let pushed = false
  const unsubscribe = api.onThemeStatus((state) => {
    pushed = true
    applyThemeState(state)
  })
  try {
    const state = await api.getTheme()
    if (!pushed) applyThemeState(state)
  } catch (error: unknown) {
    console.error('[theme] failed to read initial state:', error)
  }
  return unsubscribe
}
