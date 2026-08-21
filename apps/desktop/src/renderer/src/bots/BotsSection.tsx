import type { JSX } from 'react'
import { Plus } from 'lucide-react'
import type { BotSidebarRow } from './bot-rows'
import { BotMark } from './BotMark'
import { LogoSnakeSpinner } from '../shell/logo-snake-spinner'
import { formatRelativeTime } from '../shell/relative-time'
import { Badge } from '../ui/badge'
import { IconButton } from '../ui/icon-button'
import { cn } from '../lib/utils'

/**
 * The **Bots** section of the sidebar, above Projects (#446, ADR-0027 decision 4).
 *
 * Two things here are decided, prototyped and captured on `proto/422-bots-view`,
 * and neither is a style preference:
 *
 * 1. **It is BOUNDED.** The row list carries its own `max-height` and scrollbar, so
 *    Projects stays reachable at any Bot count. Unbounded, twenty Bots push Projects
 *    entirely off screen (captured as `D-scale-20.png`), and a *collapsible* section
 *    does NOT fix it — expanded is its default, so the first twenty-Bot user meets
 *    exactly the broken state.
 * 2. **A row carries mark + name + right-aligned last-active + unread dot, and
 *    nothing else.** Description, message count and project were tried and rejected:
 *    at sidebar width they truncate to noise. The timestamp is the whole identity
 *    answer — colour and name alone read as a bookmark list, "Rex · 1h" reads as a
 *    teammate.
 *
 * Selecting a row swaps the outlet to that Bot's conversation, exactly as selecting
 * a Thread does. There is no Bots page and no fourth outlet view.
 */

/** The bound: about seven rows, then the section scrolls on its own. */
const BOTS_SECTION_MAX_HEIGHT = 240

export function BotsSection({
  rows,
  selectedThreadId,
  onSelectBot,
  onCreateBot,
}: {
  /** The Bots, most-recently-ACTIVE first (`deriveBotRows`). */
  rows: BotSidebarRow[]
  /** The nav selection, so the open Bot's row is highlighted. */
  selectedThreadId: string | null
  /** Open a Bot's conversation — App routes it through the ordinary Thread select. */
  onSelectBot: (row: BotSidebarRow) => void
  /**
   * Open the create form. The section's ＋ is the create affordance that works in
   * every state (the empty-state CTA only exists while there are no Bots), but the
   * form itself is slice 3 (#447) — until it lands the ＋ is omitted rather than
   * rendered inert, because a button that does nothing is worse than no button.
   */
  onCreateBot?: () => void
}): JSX.Element {
  // ONE Date.now() per render, injected into the pure formatter at each call site.
  const nowMs = Date.now()
  return (
    <nav className="flex flex-none flex-col gap-0.5" aria-label="Bots">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[13px] font-medium text-muted-foreground">Bots</span>
        {onCreateBot && (
          <IconButton size="icon-xs" aria-label="New Bot" title="New Bot" onClick={onCreateBot}>
            <Plus className="size-4" aria-hidden />
          </IconButton>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="px-3 py-1 text-[13px] leading-relaxed text-muted-foreground">
          No Bots yet. A Bot keeps one running conversation about one project.
        </p>
      ) : (
        <ul
          // The bound itself. `overflow-y-auto` on the LIST (not the section) keeps
          // the header and the ＋ pinned while the rows scroll under them.
          className="flex flex-col gap-0.5 overflow-y-auto"
          style={{ maxHeight: BOTS_SECTION_MAX_HEIGHT }}
        >
          {rows.map((row) => (
            <BotRow
              key={row.bot.threadId}
              row={row}
              nowMs={nowMs}
              selected={row.bot.threadId === selectedThreadId}
              onSelect={() => onSelectBot(row)}
            />
          ))}
        </ul>
      )}
    </nav>
  )
}

/**
 * One Bot row. Deliberately NOT the shared `NavItem`: a Bot row's leading element is
 * its mark (a coloured identity, not a status dot) and its trailing element is a
 * timestamp that must survive at the default sidebar width — so it owns its layout,
 * with the name as the only flexible column (`min-w-0 truncate`) and every other
 * part `flex-none`.
 */
function BotRow({
  row,
  nowMs,
  selected,
  onSelect,
}: {
  row: BotSidebarRow
  nowMs: number
  selected: boolean
  onSelect: () => void
}): JSX.Element {
  const timestamp = formatRelativeTime(row.lastActiveAt, nowMs)
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-3 py-[7px] text-left text-[13.5px] text-foreground outline-none transition-colors',
          'hover:bg-primary/10 focus-visible:bg-primary/10',
          selected && 'bg-primary/15 font-semibold',
        )}
      >
        <BotMark name={row.bot.name} colour={row.bot.colour} size={20} />
        <span className="min-w-0 flex-1 truncate">{row.bot.name}</span>
        {row.streaming && <LogoSnakeSpinner size={15} label={`${row.bot.name} is working`} />}
        {row.needsAttention && (
          <Badge variant="destructive" title="Awaiting your response">
            !
          </Badge>
        )}
        {timestamp && (
          <span className="flex-none text-[13px] tabular-nums text-muted-foreground">
            {timestamp}
          </span>
        )}
        {/* The unread dot sits OUTSIDE the timestamp column so the times stay in a
            straight line whether or not a row has one. */}
        <span
          className={cn(
            'size-1.5 flex-none rounded-full',
            row.unread ? 'bg-primary' : 'bg-transparent',
          )}
          role={row.unread ? 'img' : undefined}
          aria-label={row.unread ? `${row.bot.name} has new activity` : undefined}
          aria-hidden={row.unread ? undefined : true}
        />
      </button>
    </li>
  )
}
