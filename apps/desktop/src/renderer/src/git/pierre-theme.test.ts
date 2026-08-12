import { describe, expect, it } from 'vitest'
import { pierreThemeOptions } from './pierre-theme'

describe('pierreThemeOptions', () => {
  it('maps both resolved app themes to @pierre/diffs bundled themes', () => {
    expect(pierreThemeOptions('light')).toEqual({ theme: 'pierre-light', themeType: 'light' })
    expect(pierreThemeOptions('dark')).toEqual({ theme: 'pierre-dark', themeType: 'dark' })
  })
})
