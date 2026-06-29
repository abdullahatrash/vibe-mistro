/**
 * Delete a Thread end-to-end (TB6 #35, ADR-0005). Vibe owns agent context; WE own
 * the visible history, so deleting a Thread tears down OUR records — its metadata
 * entry and its JSONL transcript — and, if it is bound to a LIVE ACP session,
 * makes a best-effort attempt to close that session first.
 *
 * Best-effort is the whole point: a close failure, a cold Thread with no live
 * session, or a never-prompted draft with no JSONL must NEVER block the deletion
 * or surface as a hard error. The close is swallowed here (belt-and-suspenders —
 * the close seam is itself best-effort), and the store/transcript removals are
 * each idempotent + best-effort, so this resolves cleanly in every case.
 */

/** The store surface needed to drop a Thread's metadata record (idempotent). */
export interface DeleteThreadStore {
  deleteThread(id: string): Promise<void>
}

/** The transcript surface needed to drop a Thread's JSONL (missing = no-op). */
export interface DeleteThreadTranscript {
  delete(threadId: string): Promise<void>
}

export interface DeleteThreadArgs {
  threadId: string
  store: DeleteThreadStore
  transcript: DeleteThreadTranscript
  /**
   * Best-effort close of the Thread's live ACP session, when one is hosted on an
   * active agent. Omitted for a cold Thread / unbound draft (nothing to close).
   * Any rejection is swallowed — it must not block the record removal below.
   */
  closeSession?: () => Promise<void>
}

export async function deleteThread(args: DeleteThreadArgs): Promise<void> {
  // 1. Best-effort close FIRST, while the session handle is still resolvable.
  //    Swallow any failure (or absence) — Vibe-side cleanup never gates ours.
  if (args.closeSession) {
    try {
      await args.closeSession()
    } catch {
      // A failed/unavailable close is non-fatal — proceed to remove our records.
    }
  }
  // 2. Remove our records regardless. Both are idempotent + best-effort.
  await args.store.deleteThread(args.threadId)
  await args.transcript.delete(args.threadId)
}
