import { type JSX } from 'react'
import { useWideMode } from '../shell/wide-mode-store'
import { cn } from '../lib/utils'

/** Two-button toggle for the wide-mode reading-measure preference. */
export function WideModeControl(): JSX.Element {
  const [wide, setWide] = useWideMode()

  return (
    <div
      className="flex overflow-hidden rounded-lg border border-border"
      role="group"
      aria-label="Conversation width"
    >
      <button
        type="button"
        onClick={() => setWide(false)}
        aria-pressed={!wide}
        title="Cap the conversation column at 830px"
        className={cn(
          'px-2.5 py-1 text-[13px] transition-colors',
          !wide
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-primary',
        )}
      >
        Standard
      </button>
      <button
        type="button"
        onClick={() => setWide(true)}
        aria-pressed={wide}
        title="Let the conversation column use the full outlet width"
        className={cn(
          'px-2.5 py-1 text-[13px] transition-colors',
          wide
            ? 'bg-primary/10 text-primary'
            : 'text-muted-foreground hover:text-primary',
        )}
      >
        Wide
      </button>
    </div>
  )
}
