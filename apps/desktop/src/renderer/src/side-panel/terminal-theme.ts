import type { ITheme } from '@xterm/xterm'

type ReadTerminalToken = (name: string) => string

const FALLBACK_BACKGROUND = '#1c1b1a'
const FALLBACK_FOREGROUND = '#d8d2ca'

/**
 * Build xterm's complete palette from our terminal design tokens.
 *
 * xterm paints transparent theme backgrounds as black. Passing it the mount
 * node's computed `transparent` background together with inherited dark text
 * therefore produces black-on-black input in packaged builds. Keep the token
 * reader pure so that failure mode stays covered without a DOM test environment.
 */
export function buildTerminalTheme(readToken: ReadTerminalToken): ITheme {
  const read = (name: string, fallback: string): string => normalizeColor(readToken(name), fallback)

  return {
    background: read('--terminal-background', FALLBACK_BACKGROUND),
    foreground: read('--terminal-foreground', FALLBACK_FOREGROUND),
    cursor: read('--terminal-foreground', FALLBACK_FOREGROUND),
    selectionBackground: 'rgba(216, 210, 202, 0.25)',
    scrollbarSliderBackground: 'rgba(255, 255, 255, 0.1)',
    scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
    scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.22)',
    black: '#34312e',
    red: '#d77c7c',
    green: read('--terminal-green', '#7fb56b'),
    yellow: '#d6b96d',
    blue: read('--terminal-blue', '#6ba0d6'),
    magenta: '#b78bc4',
    cyan: '#72b4b2',
    white: FALLBACK_FOREGROUND,
    brightBlack: read('--terminal-gray', '#a49c93'),
    brightRed: '#ef9999',
    brightGreen: '#a1d28e',
    brightYellow: '#ead58d',
    brightBlue: '#8dbce6',
    brightMagenta: '#cda7d6',
    brightCyan: '#95d0ce',
    brightWhite: '#fffaf4',
  }
}

function normalizeColor(value: string, fallback: string): string {
  const normalized = value.trim().toLowerCase()
  if (
    normalized.length === 0 ||
    normalized === 'transparent' ||
    normalized === 'rgba(0, 0, 0, 0)' ||
    normalized === 'rgba(0 0 0 / 0)' ||
    normalized === '#0000' ||
    normalized === '#00000000'
  ) {
    return fallback
  }
  return value.trim()
}
