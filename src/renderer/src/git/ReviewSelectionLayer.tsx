import { useRef, useState, type JSX, type ReactNode } from 'react'
import { MessageSquareText } from 'lucide-react'
import { Button, Textarea } from '../ui'
import { emitComposerInsertReviewComment } from '../conversation/composer-insert'
import { locateExcerptInPatch } from './review-comment'

/**
 * The review-comment selection layer (#239, PRD #233): wraps a multi-file diff view
 * and turns a NATIVE text selection inside any file section into a comment. On
 * mouseup over a `[data-diff-path]` section a floating "Comment" affordance appears
 * by the selection; clicking it opens an inline note editor (Cmd/Ctrl+Enter submits,
 * Esc cancels). Submit locates the selection in that file's raw patch
 * (`locateExcerptInPatch` — verbatim +/-/space excerpt + new-file line range;
 * unlocatable selections fall back to the selected text with no range) and emits it
 * to the ACTIVE Thread's composer through the module-level channel, where it stages
 * as a pending-context chip. Renderer-only — no IPC, no main-process involvement.
 * With no active Thread (`threadId` null) the layer is inert chrome.
 */
export function ReviewSelectionLayer({
  threadId,
  getPatch,
  children,
}: {
  threadId: string | null
  /** The raw patch for a section's path — the locator's ground truth. */
  getPatch: (path: string) => string | undefined
  children: ReactNode
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  // The captured selection: which file, the selected text, and where to float the UI.
  const [pending, setPending] = useState<{ path: string; text: string; top: number; left: number } | null>(null)
  const [editing, setEditing] = useState(false)
  const [note, setNote] = useState('')

  function handleMouseUp(): void {
    if (editing || threadId === null) return
    const selection = window.getSelection()
    const container = containerRef.current
    if (!selection || selection.isCollapsed || !container) {
      setPending(null)
      return
    }
    const text = selection.toString()
    if (text.trim().length === 0) {
      setPending(null)
      return
    }
    // The selection must live inside ONE of our file sections.
    const anchor = selection.anchorNode
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    const section = element?.closest('[data-diff-path]')
    if (!section || !container.contains(section)) {
      setPending(null)
      return
    }
    const path = section.getAttribute('data-diff-path')
    if (!path) return
    const rect = selection.getRangeAt(0).getBoundingClientRect()
    const containerRect = container.getBoundingClientRect()
    setPending({
      path,
      text,
      // Float just below the selection, clamped into the container.
      top: Math.max(0, rect.bottom - containerRect.top + container.scrollTop + 4),
      left: Math.max(8, Math.min(rect.left - containerRect.left, containerRect.width - 200)),
    })
  }

  function submit(): void {
    if (!pending || threadId === null) return
    const trimmed = note.trim()
    if (trimmed.length === 0) return
    const located = locateExcerptInPatch(getPatch(pending.path) ?? '', pending.text)
    emitComposerInsertReviewComment(threadId, {
      filePath: pending.path,
      startLine: located?.startLine ?? null,
      endLine: located?.endLine ?? null,
      note: trimmed,
      // Unlocatable (e.g. a selection across collapsed chrome): the selected text
      // still pins the code, just without line numbers.
      excerpt: located?.excerpt ?? pending.text.trim(),
    })
    cancel()
  }

  function cancel(): void {
    setPending(null)
    setEditing(false)
    setNote('')
  }

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-auto" onMouseUp={handleMouseUp}>
      {children}
      {pending && (
        <div
          className="absolute z-20 rounded-md border border-border bg-surface shadow-md"
          style={{ top: pending.top, left: pending.left }}
        >
          {!editing ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => setEditing(true)}
              className="text-accent-text"
            >
              <MessageSquareText className="size-3.5" aria-hidden />
              Comment
            </Button>
          ) : (
            <div className="flex w-64 flex-col gap-1.5 p-2">
              <Textarea
                autoFocus
                aria-label={`Review comment on ${pending.path}`}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Comment on this code…"
                rows={2}
                className="min-h-14 resize-y text-[13px]"
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault()
                    submit()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancel()
                  }
                }}
              />
              <div className="flex items-center justify-end gap-1.5">
                <Button type="button" variant="ghost" size="xs" onClick={cancel} className="text-muted">
                  Cancel
                </Button>
                <Button type="button" size="xs" onClick={submit} disabled={note.trim().length === 0}>
                  Add to chat
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
