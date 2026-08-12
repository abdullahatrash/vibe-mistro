import type { ResolvedTheme, ThemePreference } from '../../shared/ipc'

/** Resolve `system` through Electron's current OS appearance. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

/**
 * BrowserWindow paints this colour before and behind the renderer. Keep these
 * literals aligned with the light and dark `--background` tokens in styles.css.
 */
export const THEME_BACKGROUND: Record<ResolvedTheme, string> = {
  light: '#fbfaf8',
  dark: '#151524',
}
