import type { BotsStartOverArgs, BotsStartOverResult } from '../../shared/ipc'
import type { BotStoreApi } from '../persistence/bot-store-api'

/**
 * "Start over" on a **Mistro Bot** (#447, ADR-0027) — the pressure valve for a
 * conversation that has gone bad.
 *
 * What it does is deliberately narrow: it retires the Bot's ACP session so the
 * NEXT prompt mints a fresh one. What it must NOT touch is the interesting half,
 * and this module exists so that list is stated once and pinned by tests:
 *
 * - **the record** — the Bot keeps its name, colour, description and instructions;
 * - **the profile files** — the TOML and the prompt `.md` are never rewritten or
 *   removed, so the persona the next session selects is the same persona;
 * - **the transcript** — every earlier turn stays readable in our own log. The
 *   agent will not remember it, the user still can, and the copy on the button
 *   says exactly that.
 *
 * It is therefore NOT a delete: nothing that took work to write is destroyed. The
 * only casualty is the agent-side context, which is what the user asked to lose.
 *
 * Pure over injected seams (store + agent), so the whole decision is testable with
 * no SQLite, no pool and no home directory.
 */

export interface StartOverThreads {
  /** Forget the Thread's session cursor. See `MetadataStoreApi.clearThreadSession`. */
  clearThreadSession(id: string): Promise<void>
}

export interface StartOverDeps {
  bots: Pick<BotStoreApi, 'get'>
  threads: StartOverThreads
  /**
   * Whether a turn is in flight on this Thread (main's `thread-status` registry).
   * Retiring the session under a running turn would strand it mid-stream, so this
   * is the same authoritative guard `deleteThread` applies — the renderer disables
   * the button too, but the click-race is real and main owns the truth.
   */
  isStreaming(threadId: string): boolean
  /**
   * Best-effort close of the retired ACP session on whichever warm agent hosts it.
   * Optional: a cold Bot (no warm agent, or no session yet) has nothing to close.
   * A failure here never fails the Start over — the cursor is already gone, and a
   * lingering idle session costs nothing.
   */
  closeSession?: () => Promise<void>
}

export async function startOverBot(
  deps: StartOverDeps,
  args: BotsStartOverArgs,
): Promise<BotsStartOverResult> {
  const bot = deps.bots.get(args.threadId)
  // Only a Bot has a Start over: an ordinary Thread's session cursor is not ours
  // to retire from here, and a wrong id must never silently clear one.
  if (!bot) return { ok: false, reason: 'notFound' }
  if (deps.isStreaming(args.threadId)) return { ok: false, reason: 'streaming' }

  // The cursor FIRST: it is the step that decides the outcome. If it fails, the
  // Bot is exactly as it was and we say so, rather than closing a session the
  // Thread would then try to resume.
  try {
    await deps.threads.clearThreadSession(args.threadId)
  } catch (err) {
    console.error(`[vibe-mistro:bots] could not start over ${args.threadId}:`, err)
    return { ok: false, reason: 'io' }
  }

  if (deps.closeSession) {
    try {
      await deps.closeSession()
    } catch (err) {
      // Log, don't swallow — but never turn a completed Start over into a failure.
      console.error(`[vibe-mistro:bots] could not close the retired session:`, err)
    }
  }
  return { ok: true }
}
