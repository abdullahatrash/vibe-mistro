import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThemeState } from '../../../shared/ipc'
import { getThemeState, setThemeState } from './resolved-theme-store'
import { startThemeSync } from './theme-sync'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((fulfill) => {
    resolve = fulfill
  })
  return { promise, resolve }
}

afterEach(() => {
  setThemeState({ preference: 'light', resolved: 'light' })
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('startThemeSync', () => {
  it('subscribes before reading and does not let a stale read replace a push', async () => {
    const pending = deferred<ThemeState>()
    const listeners: Array<(state: ThemeState) => void> = []
    const toggle = vi.fn()
    vi.stubGlobal('document', { documentElement: { classList: { toggle } } })

    const unsubscribe = vi.fn()
    const stopPending = startThemeSync({
      getTheme: () => pending.promise,
      onThemeStatus: (next) => {
        listeners.push(next)
        return unsubscribe
      },
    })

    expect(listeners).toHaveLength(1)
    listeners[0]?.({ preference: 'dark', resolved: 'dark' })
    pending.resolve({ preference: 'light', resolved: 'light' })
    const stop = await stopPending

    expect(getThemeState()).toEqual({ preference: 'dark', resolved: 'dark' })
    expect(toggle).toHaveBeenCalledOnce()
    expect(toggle).toHaveBeenCalledWith('dark', true)
    stop()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('logs a failed initial read without producing an unhandled rejection', async () => {
    const toggle = vi.fn()
    vi.stubGlobal('document', { documentElement: { classList: { toggle } } })
    const error = new Error('theme IPC unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const stop = await startThemeSync({
      getTheme: () => Promise.reject(error),
      onThemeStatus: () => vi.fn(),
    })

    expect(consoleError).toHaveBeenCalledWith('[theme] failed to read initial state:', error)
    expect(getThemeState()).toEqual({ preference: 'light', resolved: 'light' })
    expect(toggle).not.toHaveBeenCalled()
    stop()
  })
})
