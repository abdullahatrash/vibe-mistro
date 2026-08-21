import { acpEventEntry, sessionIdFromPayload, titleFromSessionInfoUpdate } from './persistence/transcript'
import type { TranscriptBridge } from './persistence/transcript-bridge'
import { permissionRequestIdOf } from './thread-status'

/**
 * A warm agent's raw `event` stream, split into the two halves it was always
 * really made of (#468, ADR-0028) — the **tee**, which main owns, and the
 * **forward**, which only a renderer consumes.
 *
 * This lived inline in `index.ts` as one listener that did both, taking the
 * `WebContents` of whichever window happened to spawn the agent. Two things were
 * wrong with that once a turn can run with nobody watching:
 *
 *  - the wiring DEMANDED a sender, so an agent a Routine warms could not be wired
 *    at all — and the durable log is exactly the thing a headless turn needs;
 *  - the sender was captured at spawn, so an agent wired to a window that was
 *    later destroyed kept teeing into a dead `WebContents`. Routine or not, the
 *    live view belongs to whatever windows exist NOW, which is what
 *    `forward` (a broadcast in production, and possibly to nobody) expresses.
 *
 * The tee itself never depended on a subscriber — #456 verified that on the wire —
 * so nothing here changes what is captured. Splitting it makes the independence a
 * property of the code rather than an accident of the order two statements were
 * written in, and `agent-events.test.ts` pins it with NO subscriber attached.
 *
 * Electron-free on purpose: `forward` is injected, so this module is unit-testable
 * and knows nothing about windows.
 */

/** The half of `WorkspaceAgent` this needs: a stream of raw ACP payloads. */
export interface AgentEventSource {
  on(event: 'event', listener: (payload: unknown) => void): unknown
}

export interface AgentEventDeps {
  bridge: Pick<TranscriptBridge, 'tee' | 'threadIdFor'>
  /**
   * Persist + push a session's lazily-emitted auto-title. Best-effort and
   * fire-and-forget, like every other write on this path.
   */
  recordTitle(sessionId: string | null, title: string): void
  /**
   * Note a forwarded `session/request_permission` as its Thread's
   * `needsAttention` (#53). Main-side state, so it belongs to the tee half:
   * it must be tracked whether or not any window sees the request.
   */
  notePermission(agentId: string, threadId: string, requestId: number | string): void
}

/**
 * The half main owns: capture the payload in ITS Thread's log, catch a lazily
 * pushed auto-title, and record a blocking permission request.
 *
 * Routed by the event's OWN `sessionId` (via the store) so that with several warm
 * agents an event always lands in the right Thread regardless of which Workspace
 * is focused — and regardless of whether that Thread is on screen, or whether any
 * window exists at all.
 */
export function teeAgentEvent(deps: AgentEventDeps, agentId: string, payload: unknown): void {
  const sessionId = sessionIdFromPayload(payload)
  deps.bridge.tee(deps.bridge.threadIdFor(agentId, sessionId), acpEventEntry(payload))
  // vibe-acp pushes the session's auto-title lazily after the first prompt via a
  // `session_info_update` (never in `session/new`) — capture it so the Thread stops
  // showing "Untitled". Persist + push by the event's OWN sessionId; best-effort.
  const title = titleFromSessionInfoUpdate(payload)
  if (title !== null) deps.recordTitle(sessionId, title)
  // A `session/request_permission` blocks the turn until it is answered — surface it
  // as the Thread's `needsAttention` (#53). Resolve its Thread the same way the tee
  // does (the event's OWN sessionId, falling back to the agent's active Thread);
  // skip when unattributable.
  const requestId = permissionRequestIdOf(payload)
  if (requestId !== null) {
    const threadId = deps.bridge.threadIdFor(agentId, sessionId)
    if (threadId) deps.notePermission(agentId, threadId, requestId)
  }
}

/**
 * Wire a freshly-spawned pool agent's `event` listener — called exactly ONCE per
 * spawn (a reused warm agent already has one). Every payload is TEED first and
 * FORWARDED second, and the forward can reach nobody without affecting the tee.
 * Best-effort throughout: neither half gates the other.
 */
export function wireAgentEvents(
  deps: AgentEventDeps,
  agentId: string,
  agent: AgentEventSource,
  forward: (agentId: string, payload: unknown) => void,
): void {
  agent.on('event', (payload: unknown) => {
    teeAgentEvent(deps, agentId, payload)
    forward(agentId, payload)
  })
}
