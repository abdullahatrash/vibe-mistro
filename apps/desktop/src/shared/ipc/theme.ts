/** Theme channels merged into the shared IPC contract. */
export const themeChannels = {
  /** Renderer -> main: read the main-owned theme state. */
  themeGet: 'theme:get',
  /** Renderer -> main: persist and apply a theme preference. */
  themeSet: 'theme:set',
  /** Main -> renderer: theme state changed. */
  themeStatus: 'theme:status',
  /** Renderer -> main: the themed app shell is ready to become visible. */
  themeReady: 'theme:ready',
} as const

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const

/** The persisted preference. `system` follows Electron's native theme. */
export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** Guard renderer input at the untyped IPC boundary. */
export function isThemePreference(value: unknown): value is ThemePreference {
  return (THEME_PREFERENCES as readonly unknown[]).includes(value)
}

export interface SetThemeArgs {
  preference: ThemePreference
}

export type ResolvedTheme = 'light' | 'dark'

export interface ThemeState {
  preference: ThemePreference
  resolved: ResolvedTheme
}
