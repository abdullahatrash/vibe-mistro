import { type JSX } from 'react'
import { cn } from '../lib/utils'
import type { DiffPrefs } from './diff-prefs-store'

/**
 * Shared chrome for the two Review scopes (#235/#237): the rendering-prefs toggle row
 * used by both the working-tree `AllFilesDiffView` and the branch-range `BranchDiffView`.
 * Extracted (not duplicated) because the two views must FEEL like one surface — same
 * toggles — differing only in where their entries come from. The per-file diff rendering
 * itself moved to the single virtualized `ReviewDiffViewer` (#388, PRD #387), which
 * replaced the per-file section-with-`PatchDiff` this module used to own.
 */

/** The rendering-prefs row shared by both views: Stacked/Split + Wrap + Ignore whitespace. */
export function DiffToggles({
  prefs,
  onChange,
}: {
  prefs: DiffPrefs
  onChange: (patch: Partial<DiffPrefs>) => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2 text-[13px]">
      <div className="flex overflow-hidden rounded-md border border-border">
        <ToggleButton active={prefs.diffStyle === 'unified'} onClick={() => onChange({ diffStyle: 'unified' })}>
          Stacked
        </ToggleButton>
        <ToggleButton active={prefs.diffStyle === 'split'} onClick={() => onChange({ diffStyle: 'split' })}>
          Split
        </ToggleButton>
      </div>
      <button
        type="button"
        onClick={() => onChange({ wrap: !prefs.wrap })}
        aria-pressed={prefs.wrap}
        title={prefs.wrap ? 'Scroll long lines' : 'Wrap long lines'}
        className={cn(
          'shrink-0 rounded-md border border-border px-2.5 py-1 transition-colors',
          prefs.wrap ? 'bg-accent/10 text-accent-text' : 'text-muted hover:text-accent-text',
        )}
      >
        Wrap
      </button>
      <button
        type="button"
        onClick={() => onChange({ ignoreWhitespace: !prefs.ignoreWhitespace })}
        aria-pressed={prefs.ignoreWhitespace}
        title={prefs.ignoreWhitespace ? 'Show whitespace changes' : 'Hide whitespace changes'}
        className={cn(
          'ml-auto shrink-0 rounded-md border border-border px-2.5 py-1 transition-colors',
          prefs.ignoreWhitespace ? 'bg-accent/10 text-accent-text' : 'text-muted hover:text-accent-text',
        )}
      >
        Ignore whitespace
      </button>
    </div>
  )
}

/** A segmented-control button (Stacked / Split) — rounded via its container's clip. */
function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'px-2.5 py-1 transition-colors',
        active ? 'bg-accent/10 text-accent-text' : 'text-muted hover:text-accent-text',
      )}
    >
      {children}
    </button>
  )
}
