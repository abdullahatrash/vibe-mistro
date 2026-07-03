import { useEffect, useRef, useState, type JSX } from 'react'
import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react'
import type { GitStackedActionKind } from '../../../shared/ipc'
import { Button } from '../ui'
import type { SyncView } from './status-view'

/**
 * The clean-tree sync actions (#234, PRD #233): Push / Pull driven by the pure
 * `buildSyncView` derivation. Runs a stacked action via `gitRunStackedAction` with a
 * renderer-minted `actionId`, and mirrors the streamed `gitActionProgress` events into
 * an inline phase line while the invoke is in flight — the invoke's resolve is the
 * final word (the stream is advisory UI, like the terminal's). Failure surfaces git's
 * ACTUAL reason inline + recoverable (#86 style). Disabled while a turn streams
 * (`busy`) or an action is already running — one stacked action at a time per panel.
 */
export function SyncSection({
  workspaceDir,
  sync,
  busy,
}: {
  workspaceDir: string
  sync: SyncView
  busy: boolean
}): JSX.Element | null {
  // The in-flight action (null = idle). `progress` is the latest streamed line for it.
  const [running, setRunning] = useState<GitStackedActionKind | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The current action's renderer-minted id — the filter key for streamed events.
  const actionIdRef = useRef<string | null>(null)

  // One subscription for the panel's lifetime; events are dropped unless they carry
  // the CURRENT action's id (a stale action's stragglers can't repaint the line).
  useEffect(() => {
    return window.api.onGitActionProgress((event) => {
      if (event.workspaceDir !== workspaceDir || event.actionId !== actionIdRef.current) return
      if (event.kind === 'phaseStarted') setProgress(event.phase === 'push' ? 'Pushing…' : 'Pulling…')
      else if (event.kind === 'output') setProgress(event.text.split('\n').at(-1) ?? null)
    })
  }, [workspaceDir])

  if (!sync.showPush && !sync.showPull) return null

  async function runAction(action: GitStackedActionKind): Promise<void> {
    if (busy || running) return
    const actionId = crypto.randomUUID()
    actionIdRef.current = actionId
    setRunning(action)
    setProgress(null)
    setError(null)
    try {
      const result = await window.api.gitRunStackedAction({ workspaceDir, actionId, action })
      if (!result.ok) setError(result.error)
    } finally {
      // Always re-arm the buttons — even an unexpectedly rejecting IPC can't stick
      // the panel on "Pushing…".
      actionIdRef.current = null
      setRunning(null)
      setProgress(null)
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-border-muted px-3 py-2.5">
      {sync.showPush && (
        <Button
          type="button"
          size="sm"
          className="w-full"
          onClick={() => void runAction('push')}
          disabled={busy || running !== null}
        >
          <ArrowUpFromLine className="size-4" aria-hidden />
          {running === 'push'
            ? (progress ?? 'Pushing…')
            : sync.pushSetsUpstream
              ? 'Publish branch'
              : 'Push'}
        </Button>
      )}
      {sync.showPull && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => void runAction('pull')}
          disabled={busy || running !== null}
        >
          <ArrowDownToLine className="size-4" aria-hidden />
          {running === 'pull' ? (progress ?? 'Pulling…') : 'Pull'}
        </Button>
      )}
      {error && (
        <p className="text-[11px] text-bad" role="alert">
          {error}
        </p>
      )}
      {busy && <p className="text-[11px] text-muted">Agent is working…</p>}
    </div>
  )
}
