import { type JSX } from 'react'
import { ChevronDown, GitCommitHorizontal } from 'lucide-react'
import { Button, Menu, MenuContent, MenuItem, MenuTrigger } from '../ui'
import type { QuickAction, QuickActionKind, QuickActionView } from './quick-action'

/**
 * The commit area's smart action control (#236, PRD #233): the PRIMARY button (label
 * from the pure `deriveQuickAction`) with the remaining applicable actions in an
 * attached menu — one control that reads Commit, push & PR / Commit & push / Push /
 * Pull / View PR as the repo state moves. PRESENTATIONAL only: the guard
 * interposition, the stacked-action invoke, and the progress subscription live in
 * `ChangesPanel` (the state owner); this renders what it's told and reports clicks.
 */
export function QuickActions({
  view,
  commitCount,
  disabled,
  actingLabel,
  error,
  onRun,
}: {
  view: QuickActionView
  /** The commit-time selection size — appended to commit-family labels ("Commit 3"). */
  commitCount: number
  disabled: boolean
  /** The in-flight phase line ("Pushing…") — replaces the primary label while running. */
  actingLabel: string | null
  error: string | null
  onRun: (kind: QuickActionKind) => void
}): JSX.Element | null {
  if (!view.primary && !error) return null

  return (
    <div className="flex flex-col gap-2">
      {error && (
        <p className="text-[11px] text-bad" role="alert">
          {error}
        </p>
      )}
      {view.primary && (
        <div className="flex w-full items-stretch gap-px overflow-hidden rounded-md">
          <Button
            type="button"
            size="sm"
            className="min-w-0 flex-1 rounded-none"
            onClick={() => view.primary && onRun(view.primary.kind)}
            disabled={disabled}
          >
            <GitCommitHorizontal className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{actingLabel ?? labelWithCount(view.primary, commitCount)}</span>
          </Button>
          {view.menu.length > 0 && (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0 rounded-none px-1.5"
                    disabled={disabled}
                    aria-label="More git actions"
                  />
                }
              >
                <ChevronDown className="size-3.5" aria-hidden />
              </MenuTrigger>
              <MenuContent align="end" className="min-w-44">
                {view.menu.map((item) => (
                  <MenuItem key={item.kind} onClick={() => onRun(item.kind)}>
                    {labelWithCount(item, commitCount)}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          )}
        </div>
      )}
    </div>
  )
}

/** Commit-family labels carry the selection count (the old "Commit N" affordance). */
function labelWithCount(action: QuickAction, count: number): string {
  const isCommitFamily = action.kind === 'commit' || action.kind === 'commit_push' || action.kind === 'commit_push_pr'
  return isCommitFamily ? `${action.label} ${count}` : action.label
}
