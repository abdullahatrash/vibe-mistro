import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getResolvedTheme,
  getThemeState,
  setThemeState,
  subscribeThemeState,
} from './resolved-theme-store'

afterEach(() => setThemeState({ preference: 'light', resolved: 'light' }))

describe('resolved-theme-store', () => {
  it('defaults to light', () => {
    expect(getThemeState()).toEqual({ preference: 'light', resolved: 'light' })
    expect(getResolvedTheme()).toBe('light')
  })

  it('notifies for resolved and preference-only changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeThemeState(listener)
    setThemeState({ preference: 'dark', resolved: 'dark' })
    setThemeState({ preference: 'system', resolved: 'dark' })
    expect(listener).toHaveBeenCalledTimes(2)
    unsubscribe()
  })

  it('does not notify for a repeated state or after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeThemeState(listener)
    setThemeState({ preference: 'light', resolved: 'light' })
    unsubscribe()
    setThemeState({ preference: 'dark', resolved: 'dark' })
    expect(listener).not.toHaveBeenCalled()
  })
})
