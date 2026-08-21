import type { JSX } from 'react'
import { CircleCheck, TriangleAlert } from 'lucide-react'
import { Button } from '../ui/button'
import { CodeText } from '../ui/code-text'
import type { BotProfileHealth } from './use-bot-profile-health'

/**
 * The missing-persona banner (#448, ADR-0027 "failure is loud"): a strip at the
 * top of a Bot's conversation, naming the profile Vibe no longer offers and
 * offering to rebuild it from the Bot record.
 *
 * It exists because the alternative is the one outcome the design forbids — a
 * Bot that keeps its name, its row and its history while quietly answering as a
 * plain agent. It names the profile id (not just "something is wrong") because
 * the file it is about is the user's to inspect, under `~/.vibe/agents/`.
 *
 * Both halves of the copy are pinned to acp-capture §14.6, which says a session
 * ALREADY RUNNING is unaffected by the profile files either way — it resolved the
 * persona when it opened. So the warning does not claim the Bot is answering
 * without its persona right now (it may well not be), and the confirmation does
 * not claim a rebuild put one back into a session that is already under way.
 * Both speak about the next session this conversation opens.
 */
export function BotProfileBanner({
  botName,
  health,
}: {
  /** The teammate this is about — the banner speaks about a Bot, not a Thread. */
  botName: string
  health: BotProfileHealth
}): JSX.Element | null {
  if (health.missing) {
    return (
      <div
        role="alert"
        className="flex flex-none items-center gap-2.5 rounded-lg border border-destructive/35 bg-destructive/10 px-3 py-2 text-[13px] text-foreground"
      >
        <TriangleAlert className="size-4 flex-none text-destructive" aria-hidden />
        <span className="min-w-0 flex-1">
          {botName}&rsquo;s persona is no longer available:{' '}
          <CodeText text={health.missing.profileId} /> {health.missing.reason} A conversation
          already under way keeps the persona it started with; from its next session onwards,{' '}
          {botName} answers with Vibe&rsquo;s default instructions.
          {health.rebuildError && <> Rebuild failed: {health.rebuildError}</>}
        </span>
        <Button
          variant="outline"
          size="xs"
          className="flex-none"
          onClick={health.rebuild}
          disabled={health.rebuilding}
        >
          {health.rebuilding ? 'Rebuilding…' : 'Rebuild persona'}
        </Button>
      </div>
    )
  }
  if (health.rebuilt) {
    return (
      <div
        role="status"
        className="flex flex-none items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2 text-[13px] text-foreground"
      >
        <CircleCheck className="size-4 flex-none text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          {botName}&rsquo;s persona was rebuilt from its Bot record. It is selected again the next
          time this conversation opens a session with Vibe — your next message, unless one is
          already running, in which case when the app next starts.
        </span>
      </div>
    )
  }
  return null
}
