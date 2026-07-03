import { memo, useMemo, type JSX } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import type { GitFileDiff } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { glyphClass } from './status-view'
import type { DiffPrefs } from './diff-prefs-store'

/**
 * Shared chrome for the multi-file diff views (#235/#237): the per-file collapsible
 * section and the rendering-prefs toggle row, used by both the working-tree
 * `AllFilesDiffView` and the branch-range `BranchDiffView`. Extracted (not duplicated)
 * because the two views must FEEL like one surface — same sticky headers, same
 * toggles, same truncation marker — differing only in where their entries come from.
 */

/**
 * One file's collapsible section: a STICKY header (optional status glyph + path +
 * churn + truncated marker + collapse chevron) over its own `PatchDiff`. Memoized so a
 * sibling section's collapse or an unchanged refetch (same `diffHash`) doesn't
 * re-render this one — per-file memoization is the whole point of per-file hashes.
 * `meta` (glyph + churn) comes from the streamed status in the working-tree view and
 * is ABSENT in the branch-range view (a range entry has no porcelain status).
 */
export const DiffFileSection = memo(
  function DiffFileSection({
    path,
    meta,
    entry,
    collapsed,
    onToggle,
    refFn,
    diffStyle,
    wrap,
    ignoreWhitespace,
  }: {
    path: string
    meta?: { glyph: string; insertions: number; deletions: number }
    entry: GitFileDiff | undefined
    collapsed: boolean
    onToggle: () => void
    refFn?: (el: HTMLElement | null) => void
    diffStyle: 'unified' | 'split'
    wrap: boolean
    ignoreWhitespace: boolean
  }): JSX.Element {
    const patch = entry?.patch ?? ''
    const diffHash = entry?.diffHash ?? ''
    const rendered = useMemo(() => {
      if (!patch) return null
      return (
        <PatchDiff
          patch={patch}
          options={{
            diffStyle,
            theme: 'pierre-light',
            themeType: 'light',
            overflow: wrap ? 'wrap' : 'scroll',
          }}
        />
      )
      // diffHash is a 1:1 proxy for `patch`; depend on it (not the long string).
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [diffHash, diffStyle, wrap])

    return (
      <section ref={refFn} data-diff-path={path} className="border-b border-border-muted">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="sticky top-0 z-10 flex w-full items-center gap-1.5 border-b border-border-muted bg-background px-3 py-1.5 text-left"
        >
          {collapsed ? (
            <ChevronRight className="size-3.5 shrink-0 text-muted" aria-hidden />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted" aria-hidden />
          )}
          {meta && (
            <span className={cn('w-3 shrink-0 text-center text-[11px] font-semibold', glyphClass(meta.glyph))}>
              {meta.glyph}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] text-text" dir="rtl" title={path}>
            {path}
          </span>
          {entry?.truncated && (
            <span className="shrink-0 text-[11px] text-muted" title="Diff truncated — file too large">
              truncated
            </span>
          )}
          {meta && (
            <span className="shrink-0 text-[11px] tabular-nums">
              {meta.insertions > 0 && <span className="text-ok">+{meta.insertions}</span>}{' '}
              {meta.deletions > 0 && <span className="text-bad">−{meta.deletions}</span>}
            </span>
          )}
        </button>
        {!collapsed &&
          (rendered ?? (
            <p className="px-3 py-2 text-[13px] text-muted">
              No changes to show{ignoreWhitespace ? ' (whitespace-only changes hidden).' : '.'}
            </p>
          ))}
      </section>
    )
  },
  (prev, next) =>
    prev.path === next.path &&
    prev.entry?.diffHash === next.entry?.diffHash &&
    prev.entry?.truncated === next.entry?.truncated &&
    prev.collapsed === next.collapsed &&
    prev.diffStyle === next.diffStyle &&
    prev.wrap === next.wrap &&
    prev.ignoreWhitespace === next.ignoreWhitespace &&
    prev.meta?.insertions === next.meta?.insertions &&
    prev.meta?.deletions === next.meta?.deletions &&
    prev.meta?.glyph === next.meta?.glyph,
)

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
