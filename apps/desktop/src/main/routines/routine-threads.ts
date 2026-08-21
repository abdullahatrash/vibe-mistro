/**
 * **Which Threads are mid-Routine right now** (#471) — the one fact the event
 * wiring needs to stop showing a user buttons that decide nothing.
 *
 * A scheduled turn's permission requests are answered by MAIN, from the Routine's
 * allowed commands (#469, the ADR-0001 amendment). The request still arrives on the
 * agent's ordinary event stream, so it was broadcast to every window like any
 * other: an open Bot conversation rendered Allow / Deny buttons for a request that
 * had already been answered in-process, and whichever the user clicked changed
 * nothing. Harmless in effect and dishonest in kind — a control that does nothing is
 * worse than no control, because it teaches that the ones next to it do nothing too.
 *
 * A COUNT rather than a flag, for the same reason `AgentActivity` keeps counts: the
 * bracket is the claim and the release, and a Thread whose entry hit zero is dropped
 * so the map cannot leak across evictions or restarts.
 *
 * Keyed by our durable `threadId`, not by ACP session: a Bot IS one continuing
 * Thread, the claim that starts a Routine's run is per-Thread, and the Thread id is
 * known from the first instant of the run — before any session exists to name.
 */
export interface RoutineThreads {
  /** A Routine's turn has taken this Thread. Paired with {@link end}. */
  begin(threadId: string): void
  /** The run ended, however it ended. */
  end(threadId: string): void
  /** Is a Routine's turn in flight on this Thread? */
  has(threadId: string): boolean
}

export function createRoutineThreads(): RoutineThreads {
  const runs = new Map<string, number>()
  return {
    begin(threadId) {
      runs.set(threadId, (runs.get(threadId) ?? 0) + 1)
    },
    end(threadId) {
      const next = (runs.get(threadId) ?? 0) - 1
      if (next > 0) runs.set(threadId, next)
      else runs.delete(threadId)
    },
    has(threadId) {
      return runs.has(threadId)
    },
  }
}
