import { useEffect, useMemo, useState, type JSX } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { GitFileDiff, GitFullDiffResult } from '../../../shared/ipc'
import { Button } from '../ui'
import { readDiffPrefs, writeDiffPrefs, type DiffPrefs } from './diff-prefs-store'
import { diffRequestKey, type GitFileView } from './status-view'
import { DiffToggles } from './diff-view-chrome'
import { ReviewDiffViewer } from './ReviewDiffViewer'
import type { ReviewDiffFileMeta } from './diff-viewer-items'

/**
 * The ALL-FILES working-tree diff view (#235, PRD #233) — every changed file in ONE
 * scroll, the changes list acting as its table of contents (a row click scrolls to the
 * file). One `gitFullDiff` invoke returns per-file entries, each individually capped +
 * hashed; #388 (PRD #387) feeds them all to ONE virtualized `ReviewDiffViewer` (the
 * `@pierre/diffs` `CodeView`) instead of a `PatchDiff` per file, so a big diff opens
 * without freezing and an unchanged file keeps its parse across refetches.
 *
 * Refetches when the changed set / churn changes (`diffRequestKey` over the LIVE files —
 * the streamed status is the trigger) and on the whitespace toggle (a fresh `-w` read).
 * Stacked/Split and word WRAP are viewer-option relayouts — no re-fetch. All three
 * toggles persist via `diff-prefs-store`; the toggle chrome is shared with #237's
 * `BranchDiffView` (`diff-view-chrome`).
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
  /** The active Thread for review comments (#239) — null makes selection inert. */
  activeThreadId: string | null
}): JSX.Element {
  const [prefs, setPrefs] = useState<DiffPrefs>(() => readDiffPrefs(window.localStorage))
  const [result, setResult] = useState<GitFullDiffResult | null>(null)
  const [loading, setLoading] = useState(true)

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

  // Entries follow the LIVE file order (the list's table-of-contents order); a file
  // that just left the changed set drops out on the next result. Working-tree churn +
  // status glyph come from the streamed status, keyed by path for the viewer's header.
  const { entries, metaByPath } = useMemo(() => {
    const entryByPath = new Map((result?.files ?? []).map((f) => [f.path, f]))
    const orderedEntries: GitFileDiff[] = []
    const meta = new Map<string, ReviewDiffFileMeta>()
    for (const file of files) {
      const entry = entryByPath.get(file.path)
      if (entry) orderedEntries.push(entry)
      meta.set(file.path, { glyph: file.glyph, insertions: file.insertions, deletions: file.deletions })
    }
    return { entries: orderedEntries, metaByPath: meta }
  }, [files, result])

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

      {loading && !result ? (
        <p className="px-3 py-3 text-[13px] text-muted">Loading diff…</p>
      ) : (
        // Review comments (#239): select lines in any file → inline note editor → a
        // pending-context chip in the active Thread's composer.
        <ReviewDiffViewer
          files={entries}
          metaByPath={metaByPath}
          prefs={prefs}
          threadId={activeThreadId}
          initialScrollPath={initialPath}
        />
      )}
    </div>
  )
}
