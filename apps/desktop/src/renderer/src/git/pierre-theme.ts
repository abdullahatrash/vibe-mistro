import type { ResolvedTheme } from '../../../shared/ipc'

/** Keep every @pierre/diffs consumer on the same bundled theme vocabulary. */
const PIERRE_THEMES: Record<ResolvedTheme, string> = {
  light: 'pierre-light',
  dark: 'pierre-dark',
}

export interface PierreThemeOptions {
  theme: string
  themeType: ResolvedTheme
}

/** Options shared by the worker highlighter, Review viewer, and file preview. */
export function pierreThemeOptions(resolved: ResolvedTheme): PierreThemeOptions {
  return { theme: PIERRE_THEMES[resolved], themeType: resolved }
}
