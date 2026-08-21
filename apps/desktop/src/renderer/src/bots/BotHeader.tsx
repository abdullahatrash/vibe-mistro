import type { JSX } from 'react'
import { BotMark } from './BotMark'

/**
 * Who this Bot is, as the conversation needs to render it (#446). Assembled by App
 * from the Bot record plus its Project's display name — the conversation itself
 * knows nothing about the `bots` store.
 */
export interface BotIdentity {
  threadId: string
  name: string
  colour: string
  description: string
  /** The Project's display name — the second half of the header's subtitle. */
  projectName: string
}

/**
 * The Bot conversation's header (#446, ADR-0027 decision 4), replacing the ordinary
 * Thread head. Mark, name, and one subtitle line: `description · project`.
 *
 * A Thread's head shows its auto-generated title, which is the right answer for a
 * conversation and the wrong one for a teammate — a Bot's identity does not change
 * with what you last asked it. "Start over" belongs in this header too, but it is
 * slice 3 (#447), so the row is deliberately left with room for it rather than
 * carrying a button that cannot do its job yet.
 */
export function BotHeader({ bot }: { bot: BotIdentity }): JSX.Element {
  return (
    <div className="flex items-center gap-3 border-b border-border pb-3">
      <BotMark name={bot.name} colour={bot.colour} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-foreground">{bot.name}</div>
        <div className="truncate text-[12px] text-muted-foreground">
          {bot.description ? `${bot.description} · ${bot.projectName}` : bot.projectName}
        </div>
      </div>
    </div>
  )
}
