/**
 * PROTOTYPE (#422) — throwaway. Only the genuinely shared bits live here: the Bot
 * mark, the conversation tail, and the create form. Layout is DELIBERATELY not
 * shared — each variant is free to throw the whole structure out, which is the
 * point of the exercise.
 */
import type { JSX } from 'react'
import { RotateCcw } from 'lucide-react'
import type { ProtoBot } from './fixtures'
import { PROTO_TURNS } from './fixtures'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { cn } from '../lib/utils'

/** A Bot's identity mark: initial on its own colour. */
export function BotMark({ bot, size = 32 }: { bot: ProtoBot; size?: number }): JSX.Element {
  return (
    <span
      aria-hidden
      className="flex flex-none items-center justify-center rounded-full font-semibold text-white"
      style={{
        background: bot.colour,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {bot.name.slice(0, 1)}
    </span>
  )
}

/** The conversation tail — same in every variant, so layout is what differs. */
export function BotConversation({ bot }: { bot: ProtoBot }): JSX.Element {
  if (bot.messages === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <p className="max-w-sm text-[13px] text-muted-foreground">
          You haven&rsquo;t said anything to {bot.name} yet. Its instructions are already loaded — say
          hello and it will remember this conversation from here on.
        </p>
      </div>
    )
  }
  return (
    <div className="mx-auto flex w-full max-w-[830px] flex-col gap-5 px-6 py-6">
      {PROTO_TURNS.map((turn, i) => (
        <div key={i} className={cn('text-[14px] leading-relaxed', turn.role === 'user' && 'flex justify-end')}>
          {turn.role === 'user' ? (
            <p className="max-w-[80%] rounded-2xl bg-primary/10 px-4 py-2.5 text-foreground">{turn.text}</p>
          ) : (
            <div className="flex gap-3">
              <BotMark bot={bot} size={24} />
              <p className="flex-1 text-foreground">{turn.text}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Composer stand-in — not interactive, just there so density reads honestly. */
export function ComposerStub({ bot }: { bot: ProtoBot }): JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[830px] px-6 pb-6">
      <div className="rounded-xl border border-border bg-card px-4 py-3 text-[14px] text-muted-foreground">
        Message {bot.name}…
      </div>
    </div>
  )
}

/**
 * "Start over" — mints a fresh session, keeps the Bot's identity and instructions,
 * leaves the old transcript readable. The copy has to carry that, or it reads as
 * a delete button.
 */
export function StartOverButton({ compact = false }: { compact?: boolean }): JSX.Element {
  return (
    <Button
      variant="ghost"
      size="sm"
      title="Keeps this Bot's name and instructions. The old conversation stays readable."
    >
      <RotateCcw className="size-3.5" aria-hidden />
      {compact ? 'Start over' : 'Start a fresh conversation'}
    </Button>
  )
}

/** The create/edit form. Same fields everywhere; variants place it differently. */
export function BotForm({ onCancel }: { onCancel: () => void }): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-foreground">Name</label>
        <Input placeholder="Rex" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-foreground">Project</label>
        <div className="rounded-lg border border-border bg-card px-3 py-2 text-[14px] text-muted-foreground">
          vibe-mistro ▾
        </div>
        <p className="text-[12px] text-muted-foreground">
          A Bot lives in one project and works on those files.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-[13px] font-medium text-foreground">Instructions</label>
        <Textarea
          rows={9}
          placeholder="You review my changes before I open a PR. Be blunt about correctness, quiet about style…"
        />
        <p className="text-[12px] text-muted-foreground">
          This is the whole personality. It is loaded once and never forgotten &mdash; it survives
          everything the conversation does.
        </p>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm">Create Bot</Button>
      </div>
    </div>
  )
}
