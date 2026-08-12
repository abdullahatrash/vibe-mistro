import { describe, expect, it } from 'vitest'
import { resolveTheme, THEME_BACKGROUND } from './resolve-theme'

describe('resolveTheme', () => {
  it('keeps explicit preferences independent of the OS', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('light', false)).toBe('light')
    expect(resolveTheme('dark', true)).toBe('dark')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('resolves system through the OS preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('THEME_BACKGROUND', () => {
  it('provides paintable colours for both resolved themes', () => {
    expect(THEME_BACKGROUND.light).toMatch(/^#[0-9a-f]{6}$/i)
    expect(THEME_BACKGROUND.dark).toMatch(/^#[0-9a-f]{6}$/i)
  })
})
