import type { Dispatch, SetStateAction } from 'react'
import type {
  BotRecord,
  BotsCreateArgs,
  BotsUpdateArgs,
  BotWriteResult,
  ThreadMeta,
} from '../../../shared/ipc'
import type { ConnectionMap } from '../connection/connections'
import type { WorkspaceThreadsAction } from '../connection/workspace-threads'
import type { NavAction } from '../shell/nav-reducer'
import { deleteBotFailureMessage, startOverFailureMessage } from './bot-action-messages'
import { bumpConversationEpoch, type ConversationEpochs } from './conversation-reset'
import type { BotFormTarget } from './bot-form'

/**
 * The **Mistro Bot** lifecycle mutations (#447), extracted from App for the same
 * reason `use-workspace-actions.ts` was: each one reconciles SEVERAL stores in a
 * specific order, and behind this seam the choreography is drivable with fake
 * dispatchers instead of being closed over App's hooks.
 *
 * "Start over" is why this seam earns its keep. Its three renderer steps are
 * genuinely order-dependent — and one of them is invisible (`wt remove` exists
 * only to drop `bound[threadId]`, because a session bound this session WINS over
 * the record's cursor in `seedSessionId`). A reader reordering them would see
 * nothing wrong; a test does.
 *
 * Every mutation calls main FIRST and reconciles local state only on an ok result,
 * so the UI never drops something main still holds — and every refusal comes back
 * as something to SHOW, never as a console line alone (#447 review, D2).
 */

export interface BotLifecycleDeps {
  /** The per-Workspace connection registry — decides how a new Bot is opened. */
  connections: ConnectionMap
  navDispatch: Dispatch<NavAction>
  wtDispatch: Dispatch<WorkspaceThreadsAction>
  setConversationEpochs: Dispatch<SetStateAction<ConversationEpochs>>
  /** Re-read the Bot records (`bots:list`) after a write. */
  refreshBots: () => void
  /** Re-read the cold Workspace/Thread list. Awaited where ordering matters. */
  refreshRecents: () => Promise<void>
  /** Select a Thread the ordinary way (connect-if-needed, host, replay). */
  selectThreadInWorkspace: (workspaceId: string, threadId: string) => void
  /** Connect a cold Workspace ON a specific Thread (the `continueThreadId` path). */
  continueColdThread: (thread: ThreadMeta) => Promise<void>
  /** Show a refusal on the Bot's header — the channel `shared/ipc/bots.ts` promises. */
  setActionError: (error: { threadId: string; message: string } | null) => void
}

export interface BotLifecycle {
  openForm(target: BotFormTarget): void
  createBot(args: BotsCreateArgs): Promise<BotWriteResult>
  saveBot(args: BotsUpdateArgs): Promise<BotWriteResult>
  /** Resolves with the problems to SHOW in the form — empty on success. */
  deleteBot(bot: BotRecord): Promise<string[]>
  startOver(bot: { threadId: string; name: string }, workspaceId: string): Promise<void>
}

export function useBotLifecycle(deps: BotLifecycleDeps): BotLifecycle {
  /**
   * Land on a Bot's conversation, ready to talk to.
   *
   * The awkward half is the never-connected Project: `hostSelectedThread` resolves
   * a cold Thread through the metadata list, and a Bot created seconds ago is not
   * in the caller's captured copy of it (the refresh updated state, not that
   * value). So the cold path is handed a meta built from the RECORD — a Bot's
   * Thread is durable from creation (CONTEXT.md's carve-out), so main can
   * genuinely continue it.
   */
  function openBotConversation(bot: BotRecord): void {
    if (deps.connections[bot.workspaceId]?.status === undefined) {
      void deps.continueColdThread({
        id: bot.threadId,
        workspaceId: bot.workspaceId,
        sessionId: null,
        title: null,
        createdAt: bot.createdAt,
        lastActiveAt: bot.updatedAt,
      })
      return
    }
    deps.selectThreadInWorkspace(bot.workspaceId, bot.threadId)
  }

  return {
    /**
     * Open the Bot form in the outlet: create (the sidebar section's ＋ or its
     * empty-state CTA) or edit (a Bot's own header). The target travels IN nav
     * state, so a history entry describes which form it was (#447 review, D1).
     */
    openForm(target) {
      deps.navDispatch({ type: 'open-bot-form', target })
    },

    /**
     * Create a Bot. Main is the validator and the file writer, so this is a thin
     * pass-through that refreshes the list on success — the form shows `problems`
     * when main refuses, and stays open so nothing typed is lost.
     *
     * On success we land in the new Bot's conversation: it exists to be talked to,
     * and leaving the user on an empty form after making one would be a dead end.
     */
    async createBot(args) {
      const result = await window.api.botsCreate(args)
      if (!result.ok) return result
      deps.refreshBots()
      // A Bot's Thread is durable from creation, so the cold list has a new row.
      await deps.refreshRecents()
      openBotConversation(result.bot)
      return result
    },

    /**
     * Save an edit. A rename rewrites `display_name` and never the profile id, so
     * the live session keeps the mode it has selected and the Bot keeps working
     * across it (ADR-0027). New instructions ride the NEXT prompt's profile
     * selection — nothing already said is touched, which is what the form promises.
     */
    async saveBot(args) {
      const result = await window.api.botsUpdate(args)
      if (!result.ok) return result
      deps.refreshBots()
      // The Bot mark on the Thread rows carries its NAME, so a rename has to
      // re-read the cold list too or Search would still show the old one. The form
      // closes itself on a successful write — we only navigate when there is
      // somewhere to go.
      await deps.refreshRecents()
      return result
    },

    /**
     * Delete a Bot: the identity goes, the conversation stays. Main drops the
     * record and both profile files and ARCHIVES the Thread, so the row leaves the
     * Bots section and reappears in its project's Archived section — nothing
     * irreplaceable is destroyed. We land the user back on the (now ordinary)
     * conversation. A refusal comes back as a message for the form to show.
     */
    async deleteBot(bot) {
      const result = await window.api.botsDelete({ threadId: bot.threadId })
      if (!result.ok) {
        console.error(`[vibe-mistro:bots] could not delete ${bot.threadId}`)
        return [deleteBotFailureMessage(bot.name)]
      }
      deps.refreshBots()
      await deps.refreshRecents()
      deps.selectThreadInWorkspace(bot.workspaceId, bot.threadId)
      return []
    },

    /**
     * "Start over". Main retires the session cursor; the renderer then has to stop
     * using the session it is holding, in this order:
     *
     *  1. re-read the metadata, so the Thread's `sessionId` IS the cleared one —
     *     before anything re-seeds from it;
     *  2. `remove` then `open`, which drops `bound[threadId]` (a session bound this
     *     session wins over the record's cursor in `seedSessionId`) and re-hosts;
     *  3. bump the view epoch, which remounts `Conversation` so it re-seeds from
     *     the now-null cursor instead of the session it bound at mount.
     *
     * All three land in one post-await batch, so the remount never sees a
     * half-updated world. The transcript is untouched throughout and the remounted
     * view replays it — the old conversation is still there to read, exactly as the
     * confirm promised.
     */
    async startOver(bot, workspaceId) {
      deps.setActionError(null)
      const result = await window.api.botsStartOver({ threadId: bot.threadId })
      if (!result.ok) {
        console.error(`[vibe-mistro:bots] start over refused (${bot.threadId}): ${result.reason}`)
        deps.setActionError({
          threadId: bot.threadId,
          message: startOverFailureMessage(result.reason, bot.name),
        })
        return
      }
      await deps.refreshRecents()
      deps.wtDispatch({ type: 'remove', workspaceId, threadId: bot.threadId })
      deps.wtDispatch({ type: 'open', workspaceId, threadId: bot.threadId })
      deps.setConversationEpochs((prev) => bumpConversationEpoch(prev, bot.threadId))
    },
  }
}
