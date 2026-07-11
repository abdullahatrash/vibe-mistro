import { describe, expect, it } from 'vitest'
import { buildTerminalTheme } from './terminal-theme'

describe('buildTerminalTheme', () => {
  it('keeps terminal input readable when computed CSS colors are transparent', () => {
    const theme = buildTerminalTheme((name) =>
      name === '--terminal-background' ? 'rgba(0, 0, 0, 0)' : '',
    )

    expect(theme.background).toBe('#1c1b1a')
    expect(theme.foreground).toBe('#d8d2ca')
    expect(theme.background).not.toBe(theme.foreground)
  })

  it('uses live terminal design-token overrides', () => {
    const values: Record<string, string> = {
      '--terminal-background': 'rgb(12, 14, 18)',
      '--terminal-foreground': 'rgb(240, 242, 245)',
    }

    const theme = buildTerminalTheme((name) => values[name] ?? '')

    expect(theme.background).toBe('rgb(12, 14, 18)')
    expect(theme.foreground).toBe('rgb(240, 242, 245)')
  })
})
