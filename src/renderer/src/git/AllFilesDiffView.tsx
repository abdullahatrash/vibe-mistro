import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react'
import { PatchDiff } from '@pierre/diffs/react'
import type { GitFileDiff, GitFullDiffResult } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { Button } from '../ui'
import { readDiffPrefs, writeDiffPrefs, type DiffPrefs } from './diff-prefs-store'
import { diffRequestKey, glyphClass, type GitFileView } from './status-view'

/**
 * The ALL-FILES working-tree diff view (#235, PRD #233) — every changed file as a
 * collapsible section with a sticky header in ONE scroll, replacing #85's one-file
 * viewer (the changes list is now a table of contents: a row click scrolls to its
 * section). One `gitFullDiff` invoke returns per-file entries, each individually
 * capped + hashed; each section renders its own memoized `PatchDiff` (parsing in the
 * shared worker pool), so an unchanged file skips re-parse/re-render across refetches.
 *
 * Refetches when the changed set / churn changes (`diffRequestKey` over the LIVE
 * files — the streamed status is the trigger, like the old per-file churn dep) and on
 * the whitespace toggle (a fresh `-w` read). Stacked/Split and word WRAP are pure
 * relayout — no re-fetch. All three toggles persist via `diff-prefs-store`.
 */
export function AllFilesDiffView({
  workspaceDir,
  files,
  initialPath,
  onBack,
}: {
  workspaceDir: string
  /** The LIVE sorted view files — sections follow this order and churn drives refetch. */
  files: GitFileView[]
  /** The section to scroll to on open (the clicked row), if any. */
  initialPath: string | null
  onBack: () => void
}): JSX.Element {
  const [prefs, setPrefs] = useState<DiffPrefs>(() => readDiffPrefs(window.localStorage))
  const [result, setResult] = useState<GitFullDiffResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const sectionRefs = useRef(new Map<string, HTMLElement>())
  const scrolledRef = useRef(false)

  function updatePrefs(patch: Partial<DiffPrefs>): void {
    setPrefs((prev) => {
      const next = { ...prev, ...patch }
      writeDiffPrefs(window.localStorage, next)
      return next
    })
  }

  // Refetch on the fingerprint, not the array identity: a status tick that changes
  // nothing about the files (ahead/behind moved) must not re-read every diff.
  const requestKey = diffRequestKey(files)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.api
      .gitFullDiff({
        workspaceDir,
        files: files.map((f) => ({ path: f.path, untracked: f.untracked })),
        ignoreWhitespace: prefs.ignoreWhitespace,
      })
      .then((res) => {
        if (cancelled) return
        setResult(res)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // `requestKey` is the files' 1:1 refetch proxy (churn + paths + tracked-form).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceDir, requestKey, prefs.ignoreWhitespace])

  // Scroll the clicked row's section into view ONCE, after the first result lands
  // (before that the sections don't exist). Later refetches keep the user's position.
  useEffect(() => {
    if (scrolledRef.current || !initialPath || !result) return
    const el = sectionRefs.current.get(initialPath)
    if (el) {
      el.scrollIntoView({ block: 'start' })
      scrolledRef.current = true
    }
  }, [initialPath, result])

  // Entries follow the LIVE file order (the list's table-of-contents order); a file
  // that just left the changed set drops its section on the next result.
  const entryByPath = new Map((result?.files ?? []).map((f) => [f.path, f]))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border-muted px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onBack}
          className="-ml-1 shrink-0 text-muted hover:text-accent-text"
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          <span>Changes</span>
        </Button>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">
          All changes · {files.length} {files.length === 1 ? 'file' : 'files'}
        </span>
      </div>

      <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2 text-[13px]">
        <div className="flex overflow-hidden rounded-md border border-border">
          <ToggleButton active={prefs.diffStyle === 'unified'} onClick={() => updatePrefs({ diffStyle: 'unified' })}>
            Stacked
          </ToggleButton>
          <ToggleButton active={prefs.diffStyle === 'split'} onClick={() => updatePrefs({ diffStyle: 'split' })}>
            Split
          </ToggleButton>
        </div>
        <button
          type="button"
          onClick={() => updatePrefs({ wrap: !prefs.wrap })}
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
          onClick={() => updatePrefs({ ignoreWhitespace: !prefs.ignoreWhitespace })}
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

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !result ? (
          <p className="px-3 py-3 text-[13px] text-muted">Loading diff…</p>
        ) : (
          files.map((file) => (
            <FileSection
              key={file.path}
              file={file}
              entry={entryByPath.get(file.path)}
              collapsed={collapsed.has(file.path)}
              onToggle={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(file.path)) next.delete(file.path)
                  else next.add(file.path)
                  return next
                })
              }
              refFn={(el) => {
                if (el) sectionRefs.current.set(file.path, el)
                else sectionRefs.current.delete(file.path)
              }}
              diffStyle={prefs.diffStyle}
              wrap={prefs.wrap}
              ignoreWhitespace={prefs.ignoreWhitespace}
            />
          ))
        )}
      </div>
    </div>
  )
}

/**
 * One file's collapsible section: a STICKY header (glyph + path + churn + truncated
 * marker + collapse chevron) over its own `PatchDiff`. Memoized so a sibling section's
 * collapse or an unchanged refetch (same `diffHash`) doesn't re-render this one —
 * per-file memoization is the whole point of per-file hashes.
 */
const FileSection = memo(
  function FileSection({
    file,
    entry,
    collapsed,
    onToggle,
    refFn,
    diffStyle,
    wrap,
    ignoreWhitespace,
  }: {
    file: GitFileView
    entry: GitFileDiff | undefined
    collapsed: boolean
    onToggle: () => void
    refFn: (el: HTMLElement | null) => void
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
      <section ref={refFn} className="border-b border-border-muted">
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
          <span className={cn('w-3 shrink-0 text-center text-[11px] font-semibold', glyphClass(file.glyph))}>
            {file.glyph}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-text" dir="rtl" title={file.path}>
            {file.path}
          </span>
          {entry?.truncated && (
            <span className="shrink-0 text-[11px] text-muted" title="Diff truncated — file too large">
              truncated
            </span>
          )}
          <span className="shrink-0 text-[11px] tabular-nums">
            {file.insertions > 0 && <span className="text-ok">+{file.insertions}</span>}{' '}
            {file.deletions > 0 && <span className="text-bad">−{file.deletions}</span>}
          </span>
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
    prev.entry?.diffHash === next.entry?.diffHash &&
    prev.entry?.truncated === next.entry?.truncated &&
    prev.collapsed === next.collapsed &&
    prev.diffStyle === next.diffStyle &&
    prev.wrap === next.wrap &&
    prev.ignoreWhitespace === next.ignoreWhitespace &&
    prev.file.insertions === next.file.insertions &&
    prev.file.deletions === next.file.deletions &&
    prev.file.glyph === next.file.glyph,
)

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
