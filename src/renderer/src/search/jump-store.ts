/**
 * The pending jump-to-message handoff (#174 slice 3): the Search palette records
 * WHERE a selected hit should land (`threadId` → conversation item id), and the
 * conversation view that next renders that Thread consumes it once and scrolls.
 * A module-level single-shot store — renderer-only, transient by design (a
 * relaunch or a normal sidebar open should never inherit an old jump), which is
 * why this is not localStorage. Keying by Thread makes a stale jump harmless:
 * opening a DIFFERENT Thread never consumes another Thread's target.
 */

const pending = new Map<string, string>()

/** Record where the next open of `threadId` should land. Overwrites any prior target. */
export function setPendingJump(threadId: string, itemId: string): void {
  pending.set(threadId, itemId)
}

/** Read the pending target without consuming it (the retry loop peeks first). */
export function peekPendingJump(threadId: string): string | null {
  return pending.get(threadId) ?? null
}

/** Consume the pending target — the jump fires (or gives up) exactly once. */
export function consumePendingJump(threadId: string): string | null {
  const itemId = pending.get(threadId) ?? null
  pending.delete(threadId)
  return itemId
}
