import type { ThreadMeta } from '../../../shared/ipc'

/** How a selected Thread is rendered: live on the agent, or cold from JSONL. */
export type ThreadView = 'live' | 'cold'

/**
 * Route a selected Thread to its view (ADR-0005, TB5 #34). Several Threads
 * coexist under one Workspace agent; `liveThreadIds` is the set hosted on the
 * CURRENT agent this session — the auto-opened Thread plus any drafts created
 * since connecting.
 *
 * A member routes `live` (it has, or on its first prompt will mint/resume, a
 * session on the running agent — see `ensureBoundSession`). Since #203 every
 * sidebar click on a connected Workspace hosts the Thread live (`open`), so `cold`
 * is an EDGE-STATE fallback (e.g. an active id pointing at a Thread nothing
 * opened), not a routine view. Membership is the source of truth — a `sessionId`
 * from a prior launch does NOT make it live.
 */
export function routeThreadSelection(
  thread: Pick<ThreadMeta, 'id'>,
  liveThreadIds: ReadonlySet<string>,
): ThreadView {
  return liveThreadIds.has(thread.id) ? 'live' : 'cold'
}

/**
 * The session to seed a selected Thread's live view with (TB5). A session bound
 * THIS session (lifted when main signals `thread:bound`, kept in `boundSessions`)
 * wins over the Thread's persisted `sessionId` cursor — so switching away from a
 * just-bound draft and back RE-SEEDS its real session instead of seeing a stale
 * `null` and re-minting a second one (`ensureBoundSession` then takes its reuse
 * branch — zero extra `session/new`).
 */
export function seedSessionId(
  thread: ThreadMeta,
  boundSessions: Readonly<Record<string, string>>,
): string | null {
  return boundSessions[thread.id] ?? thread.sessionId
}

export interface ThreadIdentity {
  workspaceId: string
  threadId: string
}

export interface ThreadSelectionTarget {
  workspaceId: string
  threadId: string | null
}

export interface DraftThreadDiscardInput {
  selectedThread: ThreadIdentity
  targetThread: ThreadSelectionTarget
  primaryThreadId: string | null
  liveThreadIds: ReadonlySet<string>
  boundSessions: Readonly<Record<string, string>>
  durableThreadIds: ReadonlySet<string>
  composerIsEmpty: boolean
  threadIsStreaming: boolean
}

/**
 * Whether selecting another Thread abandons the current Draft Thread. A Draft is
 * safe to discard only while it is renderer-only (live, unbound, and absent from
 * durable metadata), is not the connection's protected primary Thread, and has no
 * staged composer content.
 */
export function shouldDiscardDraftThread({
  selectedThread,
  targetThread,
  primaryThreadId,
  liveThreadIds,
  boundSessions,
  durableThreadIds,
  composerIsEmpty,
  threadIsStreaming,
}: DraftThreadDiscardInput): boolean {
  const { threadId } = selectedThread
  return (
    (selectedThread.workspaceId !== targetThread.workspaceId || threadId !== targetThread.threadId) &&
    threadId !== primaryThreadId &&
    liveThreadIds.has(threadId) &&
    boundSessions[threadId] === undefined &&
    !durableThreadIds.has(threadId) &&
    composerIsEmpty &&
    !threadIsStreaming
  )
}
