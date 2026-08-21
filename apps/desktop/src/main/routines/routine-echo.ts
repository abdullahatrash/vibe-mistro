import type { TranscriptEntry, TranscriptEntryEvent } from '../../shared/ipc'
import type { TranscriptBridge } from '../persistence/transcript-bridge'

/**
 * **Tee AND echo** a headless turn's own entries (#471, ADR-0028 part 5) — the
 * push that makes a **Routine**'s turn legible while it is happening, not only
 * after a reopen.
 *
 * A user's turn reaches the live view twice by construction: the composer echoes
 * the prompt it sent, and everything the agent says arrives on `acp:event`. A
 * Routine's turn has neither half. Main tees the prompt bubble, its routine chip
 * and the "late" notice into the durable log with no renderer in the loop, so a Bot
 * open while its Routine fired showed the reply streaming in with NOTHING above it.
 * Nothing was lost — a reopen replayed the same entries into the right order — but
 * the live reading was that the agent had answered a question nobody asked.
 *
 * The fix is one push, and its whole design is the {@link isEchoedEntry} rule: echo
 * exactly the entries a live view cannot derive, and never the ones it already has.
 * Echoing an `acp-event` would double every streamed message, because the forward
 * in `agent-events.ts` has already delivered it.
 *
 * Electron-free: the send is injected, so the rule and the tombstone guard are unit
 * tests rather than a window's behaviour.
 */

/** How the echo reaches whatever windows exist right now (possibly none). */
export type TranscriptEntrySender = (event: TranscriptEntryEvent) => void

/** Tee one entry to a Thread's log AND push it to any live view of that Thread. */
export type TranscriptEcho = (threadId: string | null, entry: TranscriptEntry) => void

/**
 * Which entries a live view cannot work out for itself, and therefore the only
 * ones worth echoing.
 *
 * - `user-prompt` — the bubble, and the chip naming the Routine that sent it.
 *   Nobody typed it, so nothing echoed it.
 * - `routine-late` — our half of "this run is late" (the agent is told the other
 *   half inside its prompt).
 * - `turn-complete` / `turn-error` — the turn's END. Not cosmetic: the echoed
 *   prompt flips the view to processing, and only these two flip it back. Without
 *   them a watched Routine would leave a spinner running until the Thread was
 *   remounted.
 * - `agent-rebound` — the "context reset" notice, which a renderer normally learns
 *   from its own `thread:bound` signal; a headless turn sends none.
 *
 * Everything else is refused, and the two refusals are the load-bearing ones:
 * `acp-event` is ALREADY on the live view (main forwards every payload as it
 * streams), and `resolve-permission` is teed at the renderer's own answering
 * chokepoint, which by definition has a renderer.
 */
export function isEchoedEntry(entry: TranscriptEntry): boolean {
  switch (entry.t) {
    case 'user-prompt':
    case 'routine-late':
    case 'turn-complete':
    case 'turn-error':
    case 'agent-rebound':
      return true
    case 'acp-event':
    case 'resolve-permission':
      return false
  }
}

/**
 * The tee-and-echo used by every headless-turn write path.
 *
 * The tee is unchanged and stays authoritative: it is what survives the app being
 * closed, and it happens whether or not the echo reaches anybody. The echo is
 * strictly additive and skips a **tombstoned** Thread for the same reason the tee
 * does — a Workspace removed mid-turn must not have its conversation re-appear in
 * a live view a moment after it was deleted.
 */
export function createTranscriptEcho(deps: {
  bridge: Pick<TranscriptBridge, 'tee' | 'isTombstoned'>
  send: TranscriptEntrySender
}): TranscriptEcho {
  return (threadId, entry) => {
    deps.bridge.tee(threadId, entry)
    if (!threadId || deps.bridge.isTombstoned(threadId)) return
    if (!isEchoedEntry(entry)) return
    deps.send({ threadId, entry })
  }
}
