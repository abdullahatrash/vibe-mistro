import type { BotStartOverFailure } from '../../../shared/ipc'

/**
 * What to TELL the user when a Bot action is refused (#447 review, D2).
 *
 * The contract these exist to make true: `shared/ipc/bots.ts` says the typed
 * failures are typed so the header can show what happened "instead of the Bot
 * silently continuing on the session the user asked to leave behind". A console
 * line is not that — the confirm dialog closes, nothing changes on screen, and a
 * failed Start over is indistinguishable from a successful one.
 *
 * Pure and separate from the components because the interesting part is the
 * WORDING: each reason has a different next action for the user, and a refusal
 * that does not say what to do next is only marginally better than silence.
 */

/** The message for a refused "Start over", addressed to the user, by reason. */
export function startOverFailureMessage(reason: BotStartOverFailure, botName: string): string {
  switch (reason) {
    case 'streaming':
      // The reachable one: the button disables off a `thread:status` push, so a
      // click landing in the gap gets here. Says exactly what to do.
      return `${botName} is mid-turn. Wait for this answer to finish, then start over.`
    case 'notFound':
      // The record went away underneath us (deleted in another window).
      return `${botName} is no longer a Bot, so there is no session to start over.`
    case 'io':
      // The one the user cannot predict — and the one where the Bot silently keeps
      // its old session, so it must never pass unremarked.
      return `Could not start over: ${botName} could not be saved. It still has its old conversation loaded.`
  }
}

/** The message for a failed delete. The Bot is untouched — say so. */
export function deleteBotFailureMessage(botName: string): string {
  return `Could not delete ${botName}. Nothing was changed — the Bot and its files are still there.`
}
