import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ThreadMeta } from '../../../shared/ipc'
import { Item } from './items/Item'
import { UsageBar } from './items/UsageBar'
import {
  SETTLED_ACTIVITY,
  TimelineActivityProvider,
  TimelineHandlersProvider,
} from './timeline-context'
import {
  initialConversationState,
  REDUCER_SCHEMA_VERSION,
  type ConversationState,
} from './reducer'
import { foldTranscriptTail, parseSnapshotState, transcriptHasImages } from './replay'
import { replayCache } from './replay-cache'
import { useJumpToItem } from './use-jump-to-item'
import { getWorkspaceCommands } from './workspace-commands'

/**
 * A reopened Thread rendered READ-ONLY from its persisted JSONL (ADR-0005, TB3
 * #32) — NO `vibe-acp` spawned. On mount we fetch the Thread's logged input
 * stream over IPC (`readTranscript`) and replay it through the SAME reducer the
 * live turn used (`replayTranscript`) to rebuild exactly what the user saw.
 *
 * When `onContinue` is provided (TB4 #33), a "Continue" affordance spawns/uses the
 * Workspace agent and resumes this Thread via `session/load` (re-binding fresh if
 * the agent can't resume) — the first prompt then runs on the resumed session. The
 * caller owns that transition (it has the Workspace context); here we only invite it.
 */
export function ColdThread({
  thread,
  onClose,
  onContinue,
}: {
  thread: ThreadMeta
  onClose: () => void
  /** Continue this reopened Thread live (TB4 #33). Absent = view-only. */
  onContinue?: () => void
}): JSX.Element {
  // null = still loading; a ConversationState once the transcript has replayed.
  const [state, setState] = useState<ConversationState | null>(null)
  // Mirror for the unmount snapshot (a cleanup closes over the first render's
  // `state` otherwise). `null` (read never resolved) is never cached.
  const stateRef = useRef(state)
  stateRef.current = state

  // Fetch + replay once per Thread — cache first (take = consume), so a
  // switch-back within the LRU window skips the IPC + re-fold entirely.
  // Reads only — no agent is started here.
  useEffect(() => {
    const cached = replayCache.take(thread.id)
    if (cached) {
      // Sync the snapshot mirror NOW, not at the re-render: an unmount landing
      // before the render (StrictMode's dev double-mount) would otherwise see
      // `null` and drop the consumed entry instead of putting it back.
      stateRef.current = cached.state
      setState(cached.state)
      return
    }
    let active = true
    const hydrateFromStore = async (): Promise<void> => {
      // Tiered read (ADR-0019, #297) like Conversation's, minus the durable put
      // (this is an edge-state fallback view — the live path owns snapshotting).
      let result = await window.api.readTranscript({
        threadId: thread.id,
        reducerVersion: REDUCER_SCHEMA_VERSION,
      })
      let base = initialConversationState
      if (result.snapshot) {
        const parsed = parseSnapshotState(result.snapshot.state)
        if (parsed) {
          base = parsed
        } else {
          result = await window.api.readTranscript({
            threadId: thread.id,
            reducerVersion: REDUCER_SCHEMA_VERSION,
            forceFull: true,
          })
        }
      }
      // Resolve persisted image attachments (one batched IPC) ONLY when the
      // tail references any — an image-less reopen costs nothing extra.
      const attachments = transcriptHasImages(result.tail)
        ? await window.api.readThreadAttachments(thread.id)
        : undefined
      if (active) setState(foldTranscriptTail(base, result.tail, attachments))
    }
    void hydrateFromStore()
    return () => {
      active = false
    }
  }, [thread.id])

  // Unmount snapshot: a replayed cold view is settled by construction (no live
  // turn here — `isProcessing` is forced false by replay), so cache it for the
  // next open. A still-loading view (`null`) is never cached.
  useEffect(() => {
    return () => {
      if (stateRef.current !== null) {
        replayCache.put(thread.id, {
          state: stateRef.current,
          sessionId: thread.sessionId,
          workspaceId: thread.workspaceId,
        })
      }
    }
  }, [thread.id, thread.sessionId, thread.workspaceId])

  const view = state ?? initialConversationState
  const title = view.title ?? thread.title ?? 'Untitled thread'

  // Read-only timeline contexts (#386): permissions already replayed as resolved
  // (the no-op relay never fires), and the retroactive skill chip (PR #213) matches
  // against the Workspace-level commands cache (#241) — computed ONCE per Workspace
  // now, not per item. `SETTLED_ACTIVITY` keeps every row's `streaming` false.
  const timelineHandlers = useMemo(
    () => ({
      onPermission: noPermission,
      availableCommands: getWorkspaceCommands(window.localStorage, thread.workspaceId),
    }),
    [thread.workspaceId],
  )

  // Land a Search jump (#174 slice 3) once the replay has rendered its items.
  const convRef = useRef<HTMLDivElement | null>(null)
  useJumpToItem(thread.id, state !== null && view.items.length > 0, convRef)

  return (
    <div className="conv conv--cold" ref={convRef}>
      <div className="conv__head">
        <button className="btn btn--ghost" onClick={onClose}>
          ← Back
        </button>
        <span className="conv__title">{title}</span>
        <span className="badge">history</span>
        {onContinue && (
          <button className="btn" onClick={onContinue}>
            Continue
          </button>
        )}
      </div>

      <UsageBar state={view} />

      <div className="messages">
        <div className="conv-measure flex flex-col gap-3">
          {state === null ? (
            <p className="hint">Loading conversation…</p>
          ) : view.items.length === 0 ? (
            <p className="hint">This thread has no saved conversation yet.</p>
          ) : (
            // Read-only reopened history: no live turn, so reasoning renders collapsed.
            <TimelineHandlersProvider value={timelineHandlers}>
              <TimelineActivityProvider value={SETTLED_ACTIVITY}>
                {view.items.map((item, idx) => (
                  <Item key={item.id} item={item} index={idx} />
                ))}
              </TimelineActivityProvider>
            </TimelineHandlersProvider>
          )}
        </div>
      </div>

      <p className="hint">
        {onContinue
          ? 'Viewing saved history — replayed from disk. Continue to resume this conversation with the agent.'
          : 'Viewing saved history — replayed from disk with no agent running.'}
      </p>
    </div>
  )
}

/** Read-only view: permissions already replayed as resolved, so this never fires. */
const noPermission = (): void => {}
