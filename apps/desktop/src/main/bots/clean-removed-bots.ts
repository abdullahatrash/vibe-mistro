import type { BotRecord } from '../../shared/ipc'

/**
 * Clean the profile files of Bots whose Thread has just been destroyed (#445,
 * ADR-0027) — the "Remove project" and "Delete thread" halves of *destruction is
 * honest*.
 *
 * The ordering this module exists to make explicit: a Bot row cascades away with
 * its Thread, which cascades away with its Workspace, so by the time a removal
 * returns there is nothing left to look the profile ids up in. The candidates
 * must therefore be READ BEFORE the removal and filtered against the thread ids
 * the removal reports — which is exactly what `removeWorkspace`'s return value
 * is for. Without this the TOMLs would be orphaned and keep appearing in every
 * Mode picker as modes for Bots that no longer exist.
 *
 * Pure over an injected remover, and best-effort per Bot: one failure never
 * skips the rest.
 */

export interface CleanRemovedBotsArgs {
  /** Bots read BEFORE the removal (`listByWorkspace` / `get`). */
  candidates: readonly BotRecord[]
  /** The Thread ids the removal actually took down. */
  removedThreadIds: readonly string[]
  /** Destroys one Bot's two generated files; refuses a foreign profile id itself. */
  removeProfile(profileId: string): Promise<boolean>
}

/** The profile ids cleaned, in candidate order. */
export async function cleanRemovedBots(args: CleanRemovedBotsArgs): Promise<string[]> {
  const removed = new Set(args.removedThreadIds)
  const cleaned: string[] = []
  for (const bot of args.candidates) {
    if (!removed.has(bot.threadId)) continue
    try {
      await args.removeProfile(bot.profileId)
      cleaned.push(bot.profileId)
    } catch (err) {
      console.error(`[vibe-mistro:bots] could not clean up ${bot.profileId}:`, err)
    }
  }
  return cleaned
}
