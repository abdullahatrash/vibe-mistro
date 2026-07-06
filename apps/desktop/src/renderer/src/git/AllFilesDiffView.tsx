import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { GitFullDiffResult } from '../../../shared/ipc'
import { Button } from '../ui'
import { readDiffPrefs, writeDiffPrefs, type DiffPrefs } from './diff-prefs-store'
import { diffRequestKey, type GitFileView } from './status-view'
import { DiffFileSection, DiffToggles, DiffTruncationBanner } from './diff-view-chrome'
import { ReviewSelectionLayer } from './ReviewSelectionLayer'

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
 * relayout — no re-fetch. All three toggles persist via `diff-prefs-store`; the
 * section + toggle chrome is shared with #237's `BranchDiffView` (`diff-view-chrome`).
 */
export function AllFilesDiffView({
  workspaceDir,
  files,
  initialPath,
  onBack,
  activeThreadId,
}: {
  workspaceDir: string
  /** The LIVE sorted view files — sections follow this order and churn drives refetch. */
  files: GitFileView[]
  /** The section to scroll to on open (the clicked row), if any. */
  initialPath: string | null
  onBack: () => void
  /** The active Thread for review comments (#239) — null renders the layer inert. */
  activeThreadId: string | null
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

      <DiffToggles prefs={prefs} onChange={updatePrefs} />

      {/* Aggregate-truncation banner (#390): the read hit the payload budget, some files omitted. */}
      {result?.truncated && <DiffTruncationBanner />}

      {/* Review comments (#239): select lines in any section → floating Comment →
          note editor → a pending-context chip in the active Thread's composer. */}
      <ReviewSelectionLayer threadId={activeThreadId} getPatch={(path) => entryByPath.get(path)?.patch}>
        {loading && !result ? (
          <p className="px-3 py-3 text-[13px] text-muted">Loading diff…</p>
        ) : (
          files.map((file) => (
            <DiffFileSection
              key={file.path}
              path={file.path}
              meta={{ glyph: file.glyph, insertions: file.insertions, deletions: file.deletions }}
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
      </ReviewSelectionLayer>
    </div>
  )
}
