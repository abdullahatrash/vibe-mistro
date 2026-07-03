import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import type { EditorId } from '../../../shared/editors'
import { Button } from '../ui/button'
import { firstAvailableEditor, openFailureMessage } from './open-in-editor'

/**
 * The window-header Open-in-editor affordance (#252, epic #178): one click opens
 * the SELECTED Workspace's directory in the first detected external editor.
 * Workspace-keyed (not agent-keyed), so it's live whenever a project is selected —
 * no warm agent required.
 *
 * Detection (`editorsList`) is fetched once on mount — main caches the probe for
 * the whole session, so remounts are cheap. A launch failure (typed, never a
 * silent no-op) surfaces as a transient status line beside the button.
 */
export function OpenInEditorButton({
  workspaceId,
}: {
  /** The SELECTED Workspace, or null when none is selected. */
  workspaceId: string | null
}): JSX.Element {
  const [available, setAvailable] = useState<readonly EditorId[]>([])
  const [error, setError] = useState<string | null>(null)
  const clearTimer = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.editorsList().then((result) => {
      if (!cancelled) setAvailable(result.editors)
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(
    () => () => {
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
    },
    [],
  )

  const editor = firstAvailableEditor(available)

  const open = useCallback(async () => {
    if (!workspaceId || !editor) return
    const result = await window.api.editorsOpen({ workspaceId, editorId: editor.id })
    if (!result.ok) {
      setError(openFailureMessage(result.reason, editor.label))
      if (clearTimer.current !== null) window.clearTimeout(clearTimer.current)
      clearTimer.current = window.setTimeout(() => setError(null), 5000)
    }
  }, [workspaceId, editor])

  const label = editor ? `Open in ${editor.label}` : 'No installed editors found'
  return (
    <div className="flex items-center gap-1.5">
      {error && (
        <span role="status" className="text-xs text-bad">
          {error}
        </span>
      )}
      {/* Labeled (not icon-only) so the affordance is discoverable in the header;
          the title still names the concrete editor the click will open. */}
      <Button
        variant="ghost"
        size="sm"
        aria-label={label}
        title={label}
        disabled={!workspaceId || !editor}
        onClick={() => void open()}
      >
        <SquareArrowOutUpRight className="size-4" aria-hidden />
        Open
      </Button>
    </div>
  )
}
