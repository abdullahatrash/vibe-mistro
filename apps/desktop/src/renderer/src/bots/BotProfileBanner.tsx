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
 * The confirmation is deliberately unexcited about what a rebuild achieves: the
 * files are back, but a running session resolved its profile when it opened
 * (acp-capture §14.6), so the persona returns when the conversation next binds.
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
          {botName} has lost its persona: <CodeText text={health.missing.profileId} />{' '}
          {health.missing.reason} Until it is rebuilt, {botName} answers with Vibe&rsquo;s default
          instructions.
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
          {botName}&rsquo;s persona was rebuilt from its Bot record. It takes effect the next time
          this conversation resumes.
        </span>
      </div>
    )
  }
  return null
}
