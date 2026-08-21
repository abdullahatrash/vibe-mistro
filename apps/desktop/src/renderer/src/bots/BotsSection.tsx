import type { JSX } from 'react'
import { Plus } from 'lucide-react'
import type { BotSidebarRow } from './bot-rows'
import { BotMark } from './BotMark'
import { LogoSnakeSpinner } from '../shell/logo-snake-spinner'
import { formatRelativeTime } from '../shell/relative-time'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { IconButton } from '../ui/icon-button'
import { cn } from '../lib/utils'

/**
 * The **Bots** section of the sidebar, above Projects (#446, ADR-0027 decision 4).
 *
 * **It is BOUNDED**, and that is not a style preference: the row list carries its
 * own `max-height` and scrollbar, so Projects stays reachable at any Bot count.
 * Unbounded, twenty Bots push Projects entirely off screen (prototyped and
 * captured on `proto/422-bots-view` as `D-scale-20.png`), and a *collapsible*
 * section does NOT fix it — expanded is its default, so the first twenty-Bot user
 * meets exactly the broken state.
 *
 * What a row may carry is decided in `bot-rows.ts`, which is also what orders them.
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
   * Open the create form in the outlet (#447). The section's ＋ is the create
   * affordance that works in EVERY state, and that is the load-bearing part: the
   * empty-state CTA below exists only while there are no Bots, so without the ＋
   * there would be no way to add a second one — a hole the prototype's capture spec
   * caught rather than the eye.
   *
   * Still optional, because a surface that cannot create a Bot should render the
   * section without a button that does nothing.
   */
  onCreateBot?: () => void
}): JSX.Element | null {
  // Nothing to show and nothing to do: the section is absent rather than an empty
  // block — a permanent, actionless header in the sidebar earns no space.
  if (rows.length === 0 && !onCreateBot) return null

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
        // The empty state, with something to do (#447). It says what a Bot IS —
        // the word alone means nothing on first sight — and offers the one action.
        <div className="flex flex-col items-start gap-1.5 px-3 py-1">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            No Bots yet. A Bot keeps one running conversation about one project.
          </p>
          {onCreateBot && (
            <Button variant="ghost" size="sm" className="-ml-2" onClick={onCreateBot}>
              <Plus className="size-3.5" aria-hidden />
              Create a Bot
            </Button>
          )}
        </div>
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
