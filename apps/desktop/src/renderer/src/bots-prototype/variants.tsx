/**
 * PROTOTYPE (#422) — throwaway. Three STRUCTURALLY different answers to "what is
 * the Bots view", not three skins:
 *
 *   A — Roster: list-detail inside the outlet. A Bot reads like a contact.
 *   B — Team gallery: identity-first cards; picking one goes full-width.
 *   C — Sidebar-native: there IS no Bots page. Bots sit beside Projects.
 *
 * C is the argument against the other two, and it is included on purpose: the
 * cheapest way to find out whether a top-level view is warranted is to draw the
 * version that does without one.
 */
import { useState, type JSX } from 'react'
import { Plus, Search } from 'lucide-react'
import type { ProtoBot } from './fixtures'
import { BotConversation, BotForm, BotMark, ComposerStub, StartOverButton } from './shared'
import { Button } from '../ui/button'
import { cn } from '../lib/utils'

export interface VariantProps {
  bots: ProtoBot[]
}

/** Shared empty-state copy — the words are a design decision, the layout is not. */
const EMPTY_TITLE = 'No Bots yet'
const EMPTY_BODY =
  'A Bot is a teammate that keeps one long conversation about one project, so you stop re-explaining yourself every new chat.'

// ─────────────────────────────────────────────────────────────────────────────
// A — Roster (list-detail in the outlet)
// ─────────────────────────────────────────────────────────────────────────────

export function VariantA({ bots }: VariantProps): JSX.Element {
  const [selected, setSelected] = useState<string | null>(bots[0]?.id ?? null)
  const [creating, setCreating] = useState(false)
  const bot = bots.find((b) => b.id === selected) ?? null

  return (
    <div className="flex h-full">
      <div className="flex w-[300px] flex-none flex-col border-r border-border">
        <div className="flex items-center justify-between px-4 py-3">
          <h1 className="text-[15px] font-semibold text-foreground">Bots</h1>
          <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" aria-hidden />
            New
          </Button>
        </div>
        {bots.length === 0 ? (
          <div className="px-4 py-6 text-[13px] text-muted-foreground">{EMPTY_BODY}</div>
        ) : (
          <div className="flex flex-col overflow-y-auto">
            {bots.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => {
                  setSelected(b.id)
                  setCreating(false)
                }}
                className={cn(
                  'flex gap-3 border-b border-border/50 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                  b.id === selected && !creating && 'bg-muted',
                )}
              >
                <BotMark bot={b} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[14px] font-medium text-foreground">{b.name}</span>
                    <span className="flex-none text-[11px] text-muted-foreground">{b.lastActive}</span>
                  </span>
                  <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                    {b.preview || b.description}
                  </span>
                  <span className="mt-1 block truncate text-[11px] text-muted-foreground/70">{b.project}</span>
                </span>
                {b.unread && <span className="mt-1.5 size-2 flex-none rounded-full bg-primary" />}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {creating ? (
          <div className="mx-auto w-full max-w-xl px-6 py-6">
            <h2 className="mb-4 text-[15px] font-semibold text-foreground">New Bot</h2>
            <BotForm onCancel={() => setCreating(false)} />
          </div>
        ) : bot ? (
          <>
            <header className="flex items-center gap-3 border-b border-border px-6 py-3">
              <BotMark bot={bot} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-foreground">{bot.name}</div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {bot.description} · {bot.project}
                </div>
              </div>
              <StartOverButton compact />
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <BotConversation bot={bot} />
            </div>
            <ComposerStub bot={bot} />
          </>
        ) : (
          <EmptyPane onCreate={() => setCreating(true)} />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// B — Team gallery (identity-first, then full-width)
// ─────────────────────────────────────────────────────────────────────────────

export function VariantB({ bots }: VariantProps): JSX.Element {
  const [open, setOpen] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const bot = bots.find((b) => b.id === open) ?? null

  if (creating) {
    return (
      <div className="mx-auto w-full max-w-xl px-6 py-8">
        <h2 className="mb-4 text-[15px] font-semibold text-foreground">New Bot</h2>
        <BotForm onCancel={() => setCreating(false)} />
      </div>
    )
  }

  if (bot) {
    return (
      <div className="flex h-full flex-col">
        <header className="flex items-center gap-3 border-b border-border px-6 py-3">
          <Button variant="ghost" size="sm" onClick={() => setOpen(null)}>
            ← All Bots
          </Button>
          <BotMark bot={bot} size={28} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold text-foreground">{bot.name}</div>
            <div className="truncate text-[12px] text-muted-foreground">{bot.project}</div>
          </div>
          <StartOverButton compact />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <BotConversation bot={bot} />
        </div>
        <ComposerStub bot={bot} />
      </div>
    )
  }

  return (
    <div className="px-8 py-7">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-[20px] font-semibold text-foreground">Your Bots</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Each one keeps its own long-running conversation.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" aria-hidden />
          New Bot
        </Button>
      </div>

      {bots.length === 0 ? (
        <EmptyPane onCreate={() => setCreating(true)} />
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
          {bots.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setOpen(b.id)}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
            >
              <div className="flex items-start gap-3">
                <BotMark bot={b} size={40} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[15px] font-semibold text-foreground">{b.name}</span>
                    {b.unread && <span className="size-2 flex-none rounded-full bg-primary" />}
                  </div>
                  <div className="truncate text-[12px] text-muted-foreground">{b.description}</div>
                </div>
              </div>
              <p className="line-clamp-2 min-h-[2.5rem] text-[12px] text-muted-foreground">
                {b.preview || <span className="italic">No messages yet</span>}
              </p>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span className="truncate">{b.project}</span>
                <span className="flex-none">
                  {b.messages > 0 ? `${b.messages.toLocaleString()} messages · ${b.lastActive}` : 'new'}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C — Sidebar-native (no Bots page at all)
// ─────────────────────────────────────────────────────────────────────────────

export function VariantC({ bots }: VariantProps): JSX.Element {
  const [selected, setSelected] = useState<string | null>(bots[0]?.id ?? null)
  const bot = bots.find((b) => b.id === selected) ?? null

  return (
    <div className="flex h-full">
      {/* A stand-in for the REAL sidebar — this variant's claim is that Bots
          belong in it, above Projects, and that the outlet stays pure conversation. */}
      <div className="flex w-[248px] flex-none flex-col gap-1 border-r border-border bg-muted/30 px-3 py-4">
        <div className="flex items-center justify-between px-2 pb-1">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Bots
          </span>
          <Plus className="size-3.5 text-muted-foreground" aria-hidden />
        </div>
        {bots.length === 0 ? (
          <p className="px-2 py-2 text-[12px] text-muted-foreground">
            No Bots yet — add one to keep a running conversation about a project.
          </p>
        ) : (
          bots.map((b) => (
            <button
              key={b.id}
              type="button"
              onClick={() => setSelected(b.id)}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted',
                b.id === selected && 'bg-muted font-medium',
              )}
            >
              <BotMark bot={b} size={20} />
              <span className="min-w-0 flex-1 truncate text-foreground">{b.name}</span>
              {b.unread && <span className="size-1.5 flex-none rounded-full bg-primary" />}
            </button>
          ))
        )}

        <div className="mt-4 flex items-center gap-2 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Projects
        </div>
        {['vibe-mistro', 'rakazo', 'flowleap-patent-cli'].map((p) => (
          <div key={p} className="truncate rounded-lg px-2 py-1.5 text-[13px] text-muted-foreground">
            {p}
          </div>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        {bot ? (
          <>
            <header className="flex items-center gap-3 border-b border-border px-6 py-3">
              <BotMark bot={bot} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-semibold text-foreground">{bot.name}</div>
                <div className="truncate text-[12px] text-muted-foreground">
                  {bot.description} · {bot.project}
                </div>
              </div>
              <StartOverButton compact />
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <BotConversation bot={bot} />
            </div>
            <ComposerStub bot={bot} />
          </>
        ) : (
          <EmptyPane onCreate={() => undefined} />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function EmptyPane({ onCreate }: { onCreate: () => void }): JSX.Element {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <Search className="mb-3 size-7 text-muted-foreground/50" aria-hidden />
      <h2 className="text-[15px] font-semibold text-foreground">{EMPTY_TITLE}</h2>
      <p className="mt-2 max-w-md text-[13px] text-muted-foreground">{EMPTY_BODY}</p>
      <Button size="sm" className="mt-4" onClick={onCreate}>
        <Plus className="size-3.5" aria-hidden />
        Create your first Bot
      </Button>
      <p className="mt-3 max-w-md text-[12px] text-muted-foreground/70">
        Bots live inside a project, so you&rsquo;ll pick one when you create it.
      </p>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// C's real claim, rendered where it belongs: INSIDE the app's own sidebar.
// (The outlet half of C is just a conversation — see VariantCOutlet.)
// ─────────────────────────────────────────────────────────────────────────────

/** Variant C's sidebar section — injected into the REAL sidebar via Shell's slot. */
export function VariantCSidebar({
  bots,
  selected,
  onSelect,
  onCreate,
}: {
  bots: ProtoBot[]
  selected: string | null
  onSelect: (id: string) => void
  /** The ONLY way to add a Bot once one is open — the capture caught this hole. */
  onCreate?: () => void
}): JSX.Element {
  return (
    <div className="flex flex-none flex-col gap-0.5">
      <div className="flex items-center justify-between px-2 pb-1 pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Bots
        </span>
        <button
          type="button"
          aria-label="New Bot"
          onClick={onCreate}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Plus className="size-3.5" aria-hidden />
        </button>
      </div>
      {bots.length === 0 ? (
        <p className="px-2 pb-2 text-[12px] text-muted-foreground">
          No Bots yet — add one to keep a running conversation about a project.
        </p>
      ) : (
        bots.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => onSelect(b.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-muted',
              b.id === selected && 'bg-muted font-medium',
            )}
          >
            <BotMark bot={b} size={20} />
            <span className="min-w-0 flex-1 truncate text-foreground">{b.name}</span>
            {b.unread && <span className="size-1.5 flex-none rounded-full bg-primary" />}
          </button>
        ))
      )}
    </div>
  )
}

/** Variant C's outlet: pure conversation, no second list column. */
export function VariantCOutlet({ bot }: { bot: ProtoBot | null }): JSX.Element {
  if (!bot) return <EmptyPane onCreate={() => undefined} />
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <BotMark bot={bot} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-foreground">{bot.name}</div>
          <div className="truncate text-[12px] text-muted-foreground">
            {bot.description} · {bot.project}
          </div>
        </div>
        <StartOverButton compact />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <BotConversation bot={bot} />
      </div>
      <ComposerStub bot={bot} />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// D — C's sidebar + B's page (the chosen hybrid, #422)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The outlet half of D. Sidebar is C's (`VariantCSidebar`, injected into the REAL
 * sidebar); what changes is that the outlet is no longer ONLY a conversation.
 *
 * C's weakest moment was having nowhere to put a form or an empty state once it
 * gave up its page. D's answer: the outlet is the page. Nothing selected → B's
 * roomy empty state. Creating → B's roomy form. A Bot selected → C's pure
 * conversation. So the outlet is never wasted, and the form gets the width the
 * instructions field needs.
 */
export function VariantDOutlet({
  bot,
  creating,
  onCreate,
  onCancelCreate,
}: {
  bot: ProtoBot | null
  creating: boolean
  onCreate: () => void
  onCancelCreate: () => void
}): JSX.Element {
  if (creating) {
    return (
      <div className="mx-auto w-full max-w-xl px-6 py-8">
        <h2 className="text-[20px] font-semibold text-foreground">New Bot</h2>
        <p className="mb-5 mt-1 text-[13px] text-muted-foreground">
          It will live in the project you pick and keep one conversation there.
        </p>
        <BotForm onCancel={onCancelCreate} />
      </div>
    )
  }
  if (!bot) return <EmptyPane onCreate={onCreate} />
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-3">
        <BotMark bot={bot} size={28} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[14px] font-semibold text-foreground">{bot.name}</div>
          <div className="truncate text-[12px] text-muted-foreground">
            {bot.description} · {bot.project}
          </div>
        </div>
        <StartOverButton compact />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <BotConversation bot={bot} />
      </div>
      <ComposerStub bot={bot} />
    </div>
  )
}
