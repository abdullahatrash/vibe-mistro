import { useState, type JSX } from 'react'
import { Pencil, RotateCcw } from 'lucide-react'
import { BotMark } from './BotMark'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'

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
 * What the header can DO to this Bot (#447). Separate from the identity because
 * one is data and the other is behaviour, and because a Bot rendered without
 * actions (any future read-only surface) must still render.
 */
export interface BotHeaderActions {
  /** Open the Bot's form in the outlet. */
  onEdit: () => void
  /** Start over — retire the session and keep everything else. */
  onStartOver: () => void
  /**
   * A turn is in flight. Start over is refused mid-turn (main re-checks), so the
   * button says so before the click rather than after it.
   */
  busy: boolean
}

/**
 * The Bot conversation's header (#446, ADR-0027 decision 4), replacing the ordinary
 * Thread head. Mark, name, one subtitle line (`description · project`), and the two
 * things you can do to a teammate: edit it, or start over.
 *
 * A Thread's head shows its auto-generated title, which is the right answer for a
 * conversation and the wrong one for a teammate — a Bot's identity does not change
 * with what you last asked it.
 */
export function BotHeader({
  bot,
  actions = null,
}: {
  bot: BotIdentity
  actions?: BotHeaderActions | null
}): JSX.Element {
  const [confirmStartOverOpen, setConfirmStartOverOpen] = useState(false)
  return (
    <div className="flex items-center gap-3 border-b border-border pb-3">
      <BotMark name={bot.name} colour={bot.colour} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold text-foreground">{bot.name}</div>
        <div className="truncate text-[12px] text-muted-foreground">
          {bot.description ? `${bot.description} · ${bot.projectName}` : bot.projectName}
        </div>
      </div>
      {actions && (
        <div className="flex flex-none items-center gap-1">
          <Button variant="ghost" size="sm" onClick={actions.onEdit}>
            <Pencil className="size-3.5" aria-hidden />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={actions.busy}
            title={
              actions.busy
                ? `Wait for ${bot.name} to finish this turn`
                : `Keeps ${bot.name}'s name and instructions. The conversation above stays readable.`
            }
            onClick={() => setConfirmStartOverOpen(true)}
          >
            <RotateCcw className="size-3.5" aria-hidden />
            Start over
          </Button>
        </div>
      )}

      {/* The copy is the whole point of this dialog. "Start over" sits one click from
          weeks of conversation, so it has to say — before the click — that nothing is
          deleted: the Bot keeps its name, its instructions and its profile, and every
          earlier message stays readable. What is lost is the agent's MEMORY of them,
          which is exactly what the user came here for. */}
      {actions && (
        <Dialog open={confirmStartOverOpen} onOpenChange={setConfirmStartOverOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Start over with {bot.name}?</DialogTitle>
              <DialogDescription>
                {bot.name} keeps its name, its instructions and everything you have already
                said — the conversation above stays here to read. It just starts the next
                message with a clear head, remembering none of it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                onClick={() => {
                  setConfirmStartOverOpen(false)
                  actions.onStartOver()
                }}
              >
                Start over
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
