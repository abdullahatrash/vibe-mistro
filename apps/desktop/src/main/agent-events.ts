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
  /**
   * Is a **Routine**'s turn in flight on this Thread (#471)? The one question that
   * decides whether a permission request is anybody's to answer — see
   * {@link isRoutinePermission}.
   */
  isRoutineThread(threadId: string): boolean
}

/**
 * Is this payload a permission request raised by a **Routine**'s turn?
 *
 * For a scheduled turn MAIN answers, from the Routine's allowed commands, with no
 * renderer in the loop (#469, the ADR-0001 amendment). So the request is not a
 * question anybody is being asked: by the time a window could paint it, it has
 * already been answered, and clicking either button changes nothing that happened.
 *
 * The Thread is resolved exactly as the tee resolves it — the event's OWN
 * `sessionId`, falling back to the agent's active Thread — so a Routine on one Bot
 * cannot suppress a genuine request on a sibling Thread sharing the same agent.
 */
export function isRoutinePermission(
  deps: Pick<AgentEventDeps, 'bridge' | 'isRoutineThread'>,
  agentId: string,
  payload: unknown,
): boolean {
  if (permissionRequestIdOf(payload) === null) return false
  const threadId = deps.bridge.threadIdFor(agentId, sessionIdFromPayload(payload))
  return threadId !== null && deps.isRoutineThread(threadId)
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
    // A Routine's permission request is dropped WHOLE (#471) — not teed, not noted,
    // not forwarded — because all three would describe a decision nobody made:
    //
    //  - forwarded, it paints Allow / Deny buttons over a request main has already
    //    answered from the allowed commands;
    //  - teed, the same dead buttons come back on every later reopen, since main's
    //    in-process answer never crosses the renderer chokepoint that would have
    //    teed a `resolve-permission` beside it;
    //  - noted, it raises `needsAttention`, which ADR-0028 part 5 explicitly refuses
    //    as a Routine's notifier: it is a live count of requests waiting on a
    //    PERSON, and this one never was.
    //
    // Nothing legible is lost. An allowed command still renders as its tool call,
    // and a refused one is reported by name — the refusal message is written into
    // the Bot's own conversation.
    if (isRoutinePermission(deps, agentId, payload)) return
    teeAgentEvent(deps, agentId, payload)
    forward(agentId, payload)
  })
}
