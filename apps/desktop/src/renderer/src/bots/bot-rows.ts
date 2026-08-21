import type { BotRecord, ListMetadataResult } from '../../../shared/ipc'
import type { ThreadStatusMap } from '../conversation/thread-status'

/**
 * The sidebar's Bots section, as data (#446, ADR-0027). Pure — no React, no IPC —
 * so the two decisions that matter (what ORDER the section is in, and when a row
 * is unread) are settled in a unit test rather than by eye.
 *
 * A row deliberately carries only what the design allows it to render: mark +
 * name + right-aligned last-active + unread dot. Description, message count and
 * project were rejected — at sidebar width they truncate to noise. The timestamp
 * is the whole identity answer: colour and name alone read as a bookmark list,
 * "Rex · 1h" reads as a teammate (PRD story 5).
 */
export interface BotSidebarRow {
  bot: BotRecord
  /** The Project the Bot lives in — where selecting it navigates. */
  workspaceId: string
  /**
   * Epoch-ms of the Bot's last CONVERSATION activity — its Thread's
   * `lastActiveAt`, which moves on every turn. NOT the record's `updatedAt`
   * (which moves on a rename and never on a turn), so the section really does
   * order by "who I spoke to most recently". Falls back to `updatedAt` only for a
   * Bot whose Thread row hasn't been listed yet.
   */
  lastActiveAt: number
  /** A turn is in flight on this Bot (from the per-Thread status registry). */
  streaming: boolean
  /** This Bot is blocked on a permission answer. */
  needsAttention: boolean
  /** The dot: this Bot has moved since you last opened it — see {@link isBotUnread}. */
  unread: boolean
}

/** What the caller knows about when each Bot was last LOOKED AT (renderer-only). */
export type BotSeenMap = Readonly<Record<string, number>>

/**
 * Whether a Bot's row shows its dot.
 *
 * We have no read receipts and inventing one would be dishonest, so "unread" is
 * defined from signals that already exist: the Bot has been active since the last
 * time the user opened it, or it is blocked on a permission (which needs you
 * whether or not you have read it). The Bot currently on screen is never unread —
 * you are looking at it.
 */
export function isBotUnread(args: {
  lastActiveAt: number
  seenAt: number | undefined
  needsAttention: boolean
  selected: boolean
}): boolean {
  if (args.selected) return false
  if (args.needsAttention) return true
  return args.lastActiveAt > (args.seenAt ?? 0)
}

/**
 * Join the Bot records with their Threads' live metadata and status into the
 * ordered section rows.
 *
 * Ordering is **most-recently-active first**, over the Thread's `lastActiveAt` —
 * NOT `bots:list`'s most-recently-EDITED order, which is the record's own
 * `updatedAt` and would reshuffle the sidebar on a rename while ignoring a
 * conversation entirely. Ties break on name so the list never jitters.
 *
 * A Bot whose Project is no longer in `workspaces` is dropped: it cannot be
 * navigated to, and a row that does nothing when clicked is worse than no row.
 */
export function deriveBotRows(args: {
  bots: readonly BotRecord[]
  workspaces: ListMetadataResult
  statuses: ThreadStatusMap
  seen: BotSeenMap
  /** The Thread currently selected in nav — that Bot is being read, so never unread. */
  selectedThreadId: string | null
}): BotSidebarRow[] {
  const lastActive = threadActivityIndex(args.workspaces)
  const knownWorkspaces = new Set(args.workspaces.map((w) => w.id))
  const rows: BotSidebarRow[] = []
  for (const bot of args.bots) {
    if (!knownWorkspaces.has(bot.workspaceId)) continue
    const status = args.statuses[bot.threadId]
    const needsAttention = status?.needsAttention ?? false
    const lastActiveAt = lastActive.get(bot.threadId) ?? bot.updatedAt
    rows.push({
      bot,
      workspaceId: bot.workspaceId,
      lastActiveAt,
      streaming: status?.streaming ?? false,
      needsAttention,
      unread: isBotUnread({
        lastActiveAt,
        seenAt: args.seen[bot.threadId],
        needsAttention,
        selected: bot.threadId === args.selectedThreadId,
      }),
    })
  }
  return rows.sort(
    (a, b) => b.lastActiveAt - a.lastActiveAt || a.bot.name.localeCompare(b.bot.name),
  )
}

/** Every listed Thread's `lastActiveAt`, keyed by Thread id. */
function threadActivityIndex(workspaces: ListMetadataResult): Map<string, number> {
  const index = new Map<string, number>()
  for (const workspace of workspaces) {
    for (const thread of workspace.threads) index.set(thread.id, thread.lastActiveAt)
  }
  return index
}
