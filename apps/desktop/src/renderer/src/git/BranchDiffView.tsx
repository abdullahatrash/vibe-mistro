import { useEffect, useState, type JSX } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import type { GitBranch, GitRangeDiffResult } from '../../../shared/ipc'
import { Input, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../ui'
import { readDiffPrefs, writeDiffPrefs, type DiffPrefs } from './diff-prefs-store'
import { buildBaseRefChoices, filterRefChoices } from './branch-scope'
import { DiffFileSection, DiffToggles, DiffTruncationBanner } from './diff-view-chrome'
import { ReviewSelectionLayer } from './ReviewSelectionLayer'

/**
 * The BRANCH-CHANGES scope (#237, PRD #233): `base...HEAD` — what this branch adds
 * relative to where it forked — as the same collapsible per-file sections as #235's
 * working-tree view (shared `diff-view-chrome`). Review keeps working after commits
 * land. Refreshes ON DEMAND — base change, whitespace toggle, the panel's manual
 * refresh (`refreshKey`) — never from the fs watcher (a range over commits doesn't
 * move when the working tree does). The `head → base` row opens a searchable base-ref
 * picker over the #87 branches list; "Automatic" (baseRef null) lets main resolve the
 * default branch, and the resolved name renders back so Automatic is never opaque.
 * Detached HEAD and unknown-base states surface as friendly inline copy — the raw git
 * reason stays in the title attribute.
 */
export function BranchDiffView({
  workspaceDir,
  currentBranch,
  baseRef,
  onBaseRefChange,
  refreshKey,
  activeThreadId,
}: {
  workspaceDir: string
  /** The checked-out branch, or null when detached (no range to show). */
  currentBranch: string | null
  /** The persisted base choice — null = Automatic (main resolves the default). */
  baseRef: string | null
  onBaseRefChange: (baseRef: string | null) => void
  /** Bumped by the panel's manual refresh — the on-demand re-read trigger. */
  refreshKey: number
  /** The active Thread for review comments (#239) — null renders the layer inert. */
  activeThreadId: string | null
}): JSX.Element {
  const [prefs, setPrefs] = useState<DiffPrefs>(() => readDiffPrefs(window.localStorage))
  const [result, setResult] = useState<GitRangeDiffResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [choices, setChoices] = useState<GitBranch[]>([])
  const [query, setQuery] = useState('')

  function updatePrefs(patch: Partial<DiffPrefs>): void {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      writeDiffPrefs(window.localStorage, next)
      return next
    })
  }

  useEffect(() => {
    if (currentBranch === null) return // detached: nothing to fetch, friendly copy below
    let cancelled = false
    setLoading(true)
    void window.api
      .gitRangeDiff({ workspaceDir, baseRef: baseRef ?? undefined, ignoreWhitespace: prefs.ignoreWhitespace })
      .then((res) => {
        if (cancelled) return
        setResult(res)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceDir, currentBranch, baseRef, prefs.ignoreWhitespace, refreshKey])

  // The picker's choices load once per Workspace/branch (the dropdown also refreshes
  // them on open, like BranchMenu) — a local read, not a network call.
  useEffect(() => {
    let cancelled = false
    void window.api.gitBranches({ workspaceDir }).then((res) => {
      if (!cancelled && res.ok) setChoices(res.branches)
    })
    return () => {
      cancelled = true
    }
  }, [workspaceDir, currentBranch])

  if (currentBranch === null) {
    return (
      <p className="px-3 py-3 text-[13px] text-muted">
        Branch changes needs a checked-out branch — HEAD is currently detached.
      </p>
    )
  }

  const filtered = filterRefChoices(buildBaseRefChoices(choices, currentBranch), query)
  const resolvedBase = result?.ok ? result.baseRef : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* The compare row: head → base picker. */}
      <div className="flex items-center gap-1.5 border-b border-border-muted px-3 py-2 text-[13px]">
        <span className="min-w-0 shrink truncate font-medium text-text" title={currentBranch}>
          {currentBranch}
        </span>
        <ArrowRight className="size-3.5 shrink-0 text-muted" aria-hidden />
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className="min-w-0 flex-1 truncate rounded-md border border-border px-2 py-1 text-left text-[13px] text-text transition-colors hover:bg-accent/10"
                title="Choose the base ref to compare against"
              />
            }
          >
            {baseRef ?? `Automatic${resolvedBase ? ` (${resolvedBase})` : ''}`}
          </MenuTrigger>
          <MenuContent align="start" className="max-h-80 min-w-52 overflow-y-auto">
            <div className="px-2 py-1.5">
              <Input
                autoFocus
                aria-label="Filter refs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter refs…"
                className="h-7 text-[12px]"
              />
            </div>
            <MenuItem onClick={() => onBaseRefChange(null)}>
              <span className="min-w-0 flex-1 truncate">Automatic (default branch)</span>
              {baseRef === null && <Check className="size-3.5 shrink-0 text-accent-text" aria-hidden />}
            </MenuItem>
            <MenuSeparator />
            {filtered.map((b) => (
              <MenuItem key={b.name} onClick={() => onBaseRefChange(b.name)}>
                <span className="min-w-0 flex-1 truncate">{b.name}</span>
                {b.isRemote && <span className="shrink-0 text-[10px] text-faint">remote</span>}
                {baseRef === b.name && <Check className="size-3.5 shrink-0 text-accent-text" aria-hidden />}
              </MenuItem>
            ))}
            {filtered.length === 0 && <p className="px-2 py-1.5 text-[12px] text-muted">No matching refs.</p>}
          </MenuContent>
        </Menu>
      </div>

      <DiffToggles prefs={prefs} onChange={updatePrefs} />

      {/* Aggregate-truncation banner (#390): the read hit the payload budget, some files omitted. */}
      {result?.ok && result.truncated && <DiffTruncationBanner />}

      {/* Review comments work in BOTH scopes (#239): whatever the diff shows is quotable. */}
      <ReviewSelectionLayer
        threadId={activeThreadId}
        getPatch={(path) => (result?.ok ? result.files.find((f) => f.path === path)?.patch : undefined)}
      >
        {loading && !result ? (
          <p className="px-3 py-3 text-[13px] text-muted">Loading branch diff…</p>
        ) : result && !result.ok ? (
          // Friendly copy, raw git reason preserved in the tooltip (never a crash).
          <p className="px-3 py-3 text-[13px] text-muted" title={result.error} role="alert">
            Can’t compare against {baseRef ?? 'the default branch'} — pick another base ref.
          </p>
        ) : result && result.files.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-muted">
            No changes against {result.baseRef}
            {prefs.ignoreWhitespace ? ' (whitespace-only changes hidden)' : ''}.
          </p>
        ) : (
          (result?.ok ? result.files : []).map((file) => (
            <DiffFileSection
              key={file.path}
              path={file.path}
              entry={file}
              collapsed={collapsed.has(file.path)}
              onToggle={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(file.path)) next.delete(file.path)
                  else next.add(file.path)
                  return next
                })
              }
              diffStyle={prefs.diffStyle}
              wrap={prefs.wrap}
              ignoreWhitespace={prefs.ignoreWhitespace}
            />
          ))
        )}
      </ReviewSelectionLayer>
    </div>
  )
}
