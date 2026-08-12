import { describe, expect, it } from 'vitest'
import { isThemePreference, THEME_PREFERENCES } from './theme'

describe('isThemePreference', () => {
  it('accepts every theme preference', () => {
    for (const preference of THEME_PREFERENCES) expect(isThemePreference(preference)).toBe(true)
  })

  it('rejects values outside the theme vocabulary', () => {
    expect(isThemePreference('solarized')).toBe(false)
    expect(isThemePreference('')).toBe(false)
    expect(isThemePreference(undefined)).toBe(false)
    expect(isThemePreference(null)).toBe(false)
    expect(isThemePreference(42)).toBe(false)
    expect(isThemePreference({ preference: 'dark' })).toBe(false)
  })
})
