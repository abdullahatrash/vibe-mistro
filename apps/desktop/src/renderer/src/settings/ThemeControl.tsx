import { useState, type JSX } from 'react'
import { THEME_PREFERENCES, type ThemePreference } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { useThemeState } from '../shell/resolved-theme-store'

const LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

const TITLES: Record<ThemePreference, string> = {
  light: 'Always light',
  dark: 'Always dark',
  system: 'Follow the OS appearance',
}

/** Theme selection rendered only from main-confirmed state, never optimistic state. */
export function ThemeControl(): JSX.Element {
  const { preference } = useThemeState()
  const [error, setError] = useState<string | null>(null)

  async function selectTheme(next: ThemePreference): Promise<void> {
    setError(null)
    try {
      await window.api.setTheme({ preference: next })
    } catch (cause) {
      console.error('[theme] failed to set preference:', cause)
      setError('Could not change the theme. Try again.')
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      <div
        className="flex overflow-hidden rounded-lg border border-border"
        role="group"
        aria-label="Theme"
      >
        {THEME_PREFERENCES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => void selectTheme(option)}
            aria-pressed={preference === option}
            title={TITLES[option]}
            className={cn(
              'px-2.5 py-1 text-[13px] transition-colors',
              preference === option
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:text-primary',
            )}
          >
            {LABELS[option]}
          </button>
        ))}
      </div>
      {error ? <p className="text-[12px] text-destructive" role="alert">{error}</p> : null}
    </div>
  )
}
