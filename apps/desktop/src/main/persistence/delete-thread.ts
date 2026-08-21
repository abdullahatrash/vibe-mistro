/**
 * Delete a Thread end-to-end (TB6 #35, ADR-0005). Vibe owns agent context; WE own
 * the visible history, so deleting a Thread tears down OUR records — its metadata
 * entry and its JSONL transcript — and, if it is bound to a LIVE ACP session,
 * makes a best-effort attempt to close that session first.
 *
 * Best-effort is the whole point: a close failure, a cold Thread with no live
 * session, or a never-prompted draft with no JSONL must NEVER block the deletion
 * or surface as a hard error. EVERY step is guarded so the orchestration always
 * RESOLVES: the close is swallowed (belt-and-suspenders — the close seam is itself
 * best-effort), and BOTH record removals are swallowed too. `store.deleteThread`
 * reaches `persist()` (writeFile/rename), which rejects on a full / read-only
 * `userData`; an unguarded reject would bubble out the `thread:delete` IPC to the
 * renderer's `.catch`-less onClick (unhandled rejection, list never refreshes).
 * This mirrors `recordWorkspaceOpen`'s guard — a failing persist never rejects the
 * UI flow. The transcript removal is independently attempted even if the store
 * removal threw, so a record drop isn't skipped by an unrelated failure.
 */

/** The store surface needed to drop a Thread's metadata record (idempotent). */
export interface DeleteThreadStore {
  deleteThread(id: string): Promise<void>
}

/** The transcript surface needed to drop a Thread's JSONL (missing = no-op). */
export interface DeleteThreadTranscript {
  delete(threadId: string): Promise<void>
}

/** The attachments surface needed to drop a Thread's image files (missing = no-op). */
export interface DeleteThreadAttachments {
  delete(threadId: string): Promise<void>
}

export interface DeleteThreadArgs {
  threadId: string
  store: DeleteThreadStore
  transcript: DeleteThreadTranscript
  /** Omitted when the attachments dir failed to create at startup (null store). */
  attachments?: DeleteThreadAttachments
  /**
   * Best-effort close of the Thread's live ACP session, when one is hosted on an
   * active agent. Omitted for a cold Thread / unbound draft (nothing to close).
   * Any rejection is swallowed — it must not block the record removal below.
   */
  closeSession?: () => Promise<void>
}

/**
 * Returns the Thread ids whose METADATA RECORD actually came down — `[threadId]`
 * on success, `[]` when the store removal threw. The caller uses them to clean
 * anything keyed to that Thread whose rows cascade with it (a Bot and its
 * generated profile files, #445/ADR-0027), so it must report what happened
 * rather than what was asked for: the record removal is deliberately swallowed
 * above, and on that path the `threads` row survives, the `bots` row does not
 * cascade, and destroying the profile files would leave a Bot whose persona is
 * silently gone from disk. Same contract as `removeWorkspace`.
 */
export async function deleteThread(args: DeleteThreadArgs): Promise<string[]> {
  // 1. Best-effort close FIRST, while the session handle is still resolvable.
  //    Swallow any failure (or absence) — Vibe-side cleanup never gates ours.
  if (args.closeSession) {
    try {
      await args.closeSession()
    } catch {
      // A failed/unavailable close is non-fatal — proceed to remove our records.
    }
  }
  // 2. Remove our records regardless — each guarded so a persist/unlink failure
  //    can't reject the orchestration (and thus the IPC). Attempted independently
  //    so the transcript still comes down even if the metadata removal threw.
  let removedThreadIds: string[] = []
  try {
    await args.store.deleteThread(args.threadId)
    removedThreadIds = [args.threadId]
  } catch {
    // A metadata persist failure (full / read-only userData) is non-fatal — but
    // it IS reported (as "nothing removed"), because a caller cleaning cascaded
    // data must not act on a removal that did not happen.
  }
  try {
    await args.transcript.delete(args.threadId)
  } catch {
    // A transcript unlink failure is non-fatal (the store already swallows ENOENT;
    // this guards the injected/no-op seam and any unexpected reject too).
  }
  if (args.attachments) {
    try {
      await args.attachments.delete(args.threadId)
    } catch {
      // An attachments removal failure is non-fatal — same guard as the transcript.
    }
  }
  return removedThreadIds
}
