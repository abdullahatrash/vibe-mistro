import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CodeView, type CodeViewHandle } from '@pierre/diffs/react'
import {
  parsePatchFiles,
  type CodeViewDiffItem,
  type CodeViewLineSelection,
  type DiffLineAnnotation,
  type FileDiffMetadata,
  type SelectedLineRange,
} from '@pierre/diffs'
import type { GitFileDiff } from '../../../shared/ipc'
import { cn } from '../lib/utils'
import { Button, Textarea } from '../ui'
import { glyphClass } from './status-view'
import type { DiffPrefs } from './diff-prefs-store'
import {
  buildPatchCacheKey,
  buildReviewDiffItemModels,
  type ReviewDiffFileMeta,
} from './diff-viewer-items'
import { emitComposerInsertReviewComment } from '../conversation/composer-insert'
import { locateRangeInPatch } from './review-comment'

/**
 * The ONE virtualized Review viewer (#388, PRD #387). Both scopes — the working-tree
 * `AllFilesDiffView` and the branch-range `BranchDiffView` — hand every changed file to
 * a single `@pierre/diffs` `CodeView` as controlled items (the library ships the
 * virtualizer; the app just never mounted it, so it rebuilt the DOM for every file at
 * once). Only on-screen rows exist in the DOM; each item carries a stable id (its path),
 * a collapse flag, and a VERSION hash (`diff-viewer-items`) so collapsing or annotating
 * one file re-renders only that item. Stacked/Split and Wrap are viewer OPTIONS, not
 * item state, so flipping them relayouts without remounting items.
 *
 * Review comments (#239) ride the viewer's line-selection API: dragging a line range
 * opens an inline note editor (rendered as a diff-line annotation); submitting maps the
 * structured range back to the raw patch (`locateRangeInPatch`) and stages the SAME
 * `{filePath,startLine,endLine,note,excerpt}` payload the old native-selection overlay
 * did — byte-identical on the wire into the active Thread's composer.
 *
 * Per-file parses are cached by `diffHash`, so a refetch that leaves a file unchanged
 * reuses its parsed `FileDiffMetadata` (live updates don't re-cost the whole diff).
 */

/** Our annotation payload — one transient review-comment draft at a time. */
interface ReviewDraftMeta {
  kind: 'review-draft'
}

/** @pierre's light theme — matches the brand's light-mode surfaces (`DiffWorkerProvider`). */
const DIFF_THEME = 'pierre-light'

/** Which annotation side a range anchors to (the library's own convention). */
function annotationSide(range: SelectedLineRange): 'additions' | 'deletions' {
  return (range.endSide ?? range.side) === 'deletions' ? 'deletions' : 'additions'
}

export function ReviewDiffViewer({
  files,
  metaByPath,
  prefs,
  threadId,
  initialScrollPath,
}: {
  /** The scope's per-file diff entries, already in display order. */
  files: readonly GitFileDiff[]
  /** Working-tree status extras (glyph + churn) by path; omitted for the branch range. */
  metaByPath?: ReadonlyMap<string, ReviewDiffFileMeta>
  prefs: DiffPrefs
  /** The active Thread for review comments (#239) — null makes selection inert. */
  threadId: string | null
  /** Scroll this file's section into view once, after the first render (row click). */
  initialScrollPath?: string | null
}): JSX.Element {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [selection, setSelection] = useState<CodeViewLineSelection | null>(null)
  const [draft, setDraft] = useState<{ path: string; range: SelectedLineRange } | null>(null)
  const [note, setNote] = useState('')
  const viewerRef = useRef<CodeViewHandle<ReviewDraftMeta>>(null)
  const scrolledRef = useRef(false)

  // Parse each file's patch to `FileDiffMetadata`, memoized by `diffHash` across
  // refetches — an unchanged file keeps its parse (PRD #387: reuse parsed state).
  const parseCache = useRef(new Map<string, FileDiffMetadata>())
  const parsedByPath = useMemo(() => {
    const map = new Map<string, FileDiffMetadata>()
    const live = new Set<string>()
    for (const file of files) {
      if (!file.patch || !file.diffHash) continue
      live.add(file.diffHash)
      let fileDiff = parseCache.current.get(file.diffHash)
      if (!fileDiff) {
        try {
          fileDiff = parsePatchFiles(file.patch, buildPatchCacheKey(file.patch)).flatMap((p) => p.files)[0]
        } catch {
          fileDiff = undefined
        }
        if (fileDiff) parseCache.current.set(file.diffHash, fileDiff)
      }
      if (fileDiff) map.set(file.path, fileDiff)
    }
    for (const key of parseCache.current.keys()) if (!live.has(key)) parseCache.current.delete(key)
    return map
  }, [files])

  const truncatedByPath = useMemo(() => new Map(files.map((f) => [f.path, f.truncated])), [files])

  const models = useMemo(
    () => buildReviewDiffItemModels(files, { collapsed, metaByPath, draftPath: draft?.path ?? null }),
    [files, collapsed, metaByPath, draft],
  )

  const items = useMemo<CodeViewDiffItem<ReviewDraftMeta>[]>(() => {
    const out: CodeViewDiffItem<ReviewDraftMeta>[] = []
    for (const model of models) {
      const fileDiff = parsedByPath.get(model.path)
      if (!fileDiff) continue
      const annotations: DiffLineAnnotation<ReviewDraftMeta>[] | undefined =
        model.hasDraft && draft
          ? [{ side: annotationSide(draft.range), lineNumber: draft.range.end, metadata: { kind: 'review-draft' } }]
          : undefined
      out.push({
        id: model.id,
        type: 'diff',
        fileDiff,
        collapsed: model.collapsed,
        version: model.version,
        ...(annotations ? { annotations } : {}),
      })
    }
    return out
  }, [models, parsedByPath, draft])

  // Scroll the clicked row's section into view ONCE, after items first exist.
  useEffect(() => {
    if (scrolledRef.current || !initialScrollPath) return
    if (!items.some((item) => item.id === initialScrollPath)) return
    viewerRef.current?.scrollTo({ type: 'item', id: initialScrollPath, align: 'start' })
    scrolledRef.current = true
  }, [initialScrollPath, items])

  function toggleCollapsed(path: string): void {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  function beginDraft(range: SelectedLineRange | null, path: string): void {
    if (!range || threadId === null) return
    setDraft({ path, range })
    setNote('')
  }

  function cancelDraft(): void {
    setDraft(null)
    setNote('')
    setSelection(null)
    viewerRef.current?.clearSelectedLines()
  }

  function submitDraft(): void {
    if (!draft || threadId === null) return
    const trimmed = note.trim()
    if (trimmed.length === 0) return
    const patch = files.find((f) => f.path === draft.path)?.patch ?? ''
    const located = locateRangeInPatch(patch, draft.range)
    emitComposerInsertReviewComment(threadId, {
      filePath: draft.path,
      startLine: located?.startLine ?? null,
      endLine: located?.endLine ?? null,
      note: trimmed,
      excerpt: located?.excerpt ?? '',
    })
    cancelDraft()
  }

  const hasOpenDraft = draft !== null

  return (
    <CodeView<ReviewDraftMeta>
      ref={viewerRef}
      className="relative min-h-0 flex-1 overflow-auto"
      items={items}
      selectedLines={selection}
      onSelectedLinesChange={setSelection}
      options={{
        diffStyle: prefs.diffStyle,
        overflow: prefs.wrap ? 'wrap' : 'scroll',
        theme: DIFF_THEME,
        themeType: 'light',
        stickyHeaders: true,
        // A drag opens the note editor; block a new selection while one is open.
        enableLineSelection: threadId !== null && !hasOpenDraft,
        onLineSelectionEnd: (range, context) => {
          if (context.item.type === 'diff') beginDraft(range, context.item.id)
        },
      }}
      renderCustomHeader={(item) => {
        if (item.type !== 'diff') return null
        const path = item.id
        const meta = metaByPath?.get(path)
        const truncated = truncatedByPath.get(path) ?? false
        const isCollapsed = item.collapsed === true
        return (
          <button
            type="button"
            onClick={() => toggleCollapsed(path)}
            aria-expanded={!isCollapsed}
            className="flex w-full items-center gap-1.5 bg-background px-3 py-1.5 text-left"
          >
            {isCollapsed ? (
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
            {truncated && (
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
        )
      }}
      renderAnnotation={() => (
        <div className="flex w-full max-w-md flex-col gap-1.5 border-y border-border bg-surface p-2">
          <Textarea
            autoFocus
            aria-label={`Review comment on ${draft?.path ?? ''}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Comment on this code…"
            rows={2}
            className="min-h-14 resize-y text-[13px]"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault()
                submitDraft()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelDraft()
              }
            }}
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button type="button" variant="ghost" size="xs" onClick={cancelDraft} className="text-muted">
              Cancel
            </Button>
            <Button type="button" size="xs" onClick={submitDraft} disabled={note.trim().length === 0}>
              Add to chat
            </Button>
          </div>
        </div>
      )}
    />
  )
}
