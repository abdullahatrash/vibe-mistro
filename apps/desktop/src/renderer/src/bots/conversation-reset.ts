/**
 * The renderer half of "Start over" (#447, ADR-0027).
 *
 * Main retires the Bot's session cursor; the live view has to stop using the
 * session it already holds. `Conversation` seeds its bound session ONCE, at mount
 * (`useState(thread.sessionId)` mirrored into a ref, so the event subscription
 * reads it without re-subscribing) — a deliberate design that also means a prop
 * change cannot un-bind it. If the mounted view kept that session, the very next
 * prompt would reuse the conversation the user just asked to leave behind.
 *
 * So Start over REMOUNTS the live view, by changing the key it is rendered under.
 * That is the whole mechanism, and it is safe precisely because the transcript is
 * durable: a remounted Conversation replays the Thread's history from our own log
 * (`conversation/replay.ts`), so the old turns are still there to read — which is
 * exactly what Start over promises.
 *
 * Renderer-session-only by design: an epoch survives no restart, and needs to
 * survive none. After a relaunch the Thread's persisted `sessionId` is already
 * null, so the fresh mount seeds a draft with no help from here.
 */

/** How many times each Thread's live view has been reset this session. */
export type ConversationEpochs = Readonly<Record<string, number>>

export const initialConversationEpochs: ConversationEpochs = {}

/** Record one Start over on a Thread. Pure; returns a new map. */
export function bumpConversationEpoch(
  epochs: ConversationEpochs,
  threadId: string,
): ConversationEpochs {
  return { ...epochs, [threadId]: (epochs[threadId] ?? 0) + 1 }
}

/**
 * The React key the Thread's live view is rendered under. Stable for a Thread
 * that has never started over (so nothing remounts in the ordinary case) and
 * different afterwards (so the view is rebuilt exactly once per Start over).
 */
export function conversationViewKey(threadId: string, epochs: ConversationEpochs): string {
  const epoch = epochs[threadId] ?? 0
  return epoch === 0 ? threadId : `${threadId}#${epoch}`
}
