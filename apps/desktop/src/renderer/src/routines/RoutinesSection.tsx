import { useState, type JSX } from 'react'
import { CalendarClock, Pause, Play, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { RoutineRecord } from '../../../shared/ipc'
import { routineRows, type RoutineRow } from './routine-rows'
import { routineCapProblem } from './routine-form'
import { Badge } from '../ui/badge'
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
import { cn } from '../lib/utils'

/**
 * The **Routines** list, inside the Bot form (#471, ADR-0028 part 7).
 *
 * It lives here rather than in a browser of its own because the Bot form is where
 * you go to change what a Bot IS, and what it does every morning is part of that
 * answer. Each routine is EDITED in its own view — a routine has as many fields as
 * a Bot does, and nesting a full editor inside a five-field form makes a page
 * nobody can scan — so this surface holds only what a row can say at a glance and
 * the four verbs: add, edit, pause and delete.
 *
 * Three things it must never leave out:
 *
 *  - **the app-must-be-open limit, in plain words** (ADR-0028 part 3). We ship no
 *    daemon; a UI that implies otherwise is a promise the product cannot keep.
 *  - **a run that never happened, said differently from one that found nothing.**
 *    That distinction is the entire reason part 6 derives "missed" instead of
 *    storing it, and it is lost the moment a row renders both as an empty cell.
 *  - **the repair, from where the failure is reported.** A blocked run knows the
 *    exact invocation it refused (#469 keeps it structured for this), so the row
 *    offers to add THAT string — never a paraphrase, and never seeded silently.
 *
 * Thin by construction: every decision a row makes is `routine-rows.ts`, and every
 * write is the caller's.
 */
export function RoutinesSection({
  threadId,
  routines,
  onAdd,
  onEdit,
  onSetActive,
  onAllowCommand,
  onDelete,
}: {
  /** The Bot these routines belong to — a Bot IS one continuing Thread. */
  threadId: string
  /** Every routine record; this section takes the ones for `threadId`. */
  routines: readonly RoutineRecord[]
  onAdd: () => void
  onEdit: (routineId: string) => void
  /** Pause or resume. Resolves with the problems to SHOW — empty on success. */
  onSetActive: (routine: RoutineRecord, active: boolean) => Promise<string[]>
  /** Add one exact invocation to this routine's allowed commands. Same contract. */
  onAllowCommand: (routine: RoutineRecord, command: string) => Promise<string[]>
  onDelete: (routine: RoutineRecord) => Promise<string[]>
}): JSX.Element {
  const [problems, setProblems] = useState<string[]>([])
  const [pending, setPending] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<RoutineRecord | null>(null)

  const mine = routines.filter((routine) => routine.threadId === threadId)
  const rows = routineRows(mine, Date.now())
  const capped = routineCapProblem({ target: { mode: 'create', threadId }, routineCount: mine.length })

  async function run(routineId: string, action: () => Promise<string[]>): Promise<void> {
    setPending(routineId)
    setProblems(await action())
    setPending(null)
  }

  return (
    <section className="flex flex-col gap-3 border-t border-border pt-4">
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[13px] font-medium text-foreground">Routines</h2>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            A routine sends a prompt on a schedule and reports back in this
            conversation. Routines run only while Vibe Mistro is open — one that came
            due while it was closed runs once on the next launch, and says so.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onAdd} disabled={capped !== null}>
          <Plus className="size-3.5" aria-hidden />
          Add routine
        </Button>
      </header>

      {capped && <p className="text-[12px] text-muted-foreground">{capped}</p>}

      {rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-[13px] text-muted-foreground">
          No routines yet. This Bot works only when you ask it to.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <RoutineListRow
              key={row.routine.id}
              row={row}
              busy={pending === row.routine.id}
              onEdit={() => onEdit(row.routine.id)}
              onToggle={() =>
                void run(row.routine.id, () => onSetActive(row.routine, !row.routine.active))
              }
              onAllow={(command) =>
                void run(row.routine.id, () => onAllowCommand(row.routine, command))
              }
              onDelete={() => setConfirmDelete(row.routine)}
            />
          ))}
        </ul>
      )}

      {problems.length > 0 && (
        // Main refused a write. Its messages are field-prefixed and specific — shown
        // verbatim rather than collapsed into "something went wrong".
        <ul className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      {/* Deleting a routine takes the schedule AND the prompt written for it. The
          conversation it reported into is untouched, and the copy says so. */}
      <Dialog open={confirmDelete !== null} onOpenChange={(open) => !open && setConfirmDelete(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {confirmDelete?.name}?</DialogTitle>
            <DialogDescription>
              This removes the schedule, its prompt and its allowed commands. Everything
              it has already reported stays in the conversation. To stop it for a while
              instead, pause it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const routine = confirmDelete
                setConfirmDelete(null)
                if (routine) void run(routine.id, () => onDelete(routine))
              }}
            >
              Delete routine
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}

/** The tone a last-run line is coloured with — `neutral` stays muted like the rest. */
const TONE_CLASS = {
  neutral: 'text-muted-foreground',
  ok: 'text-muted-foreground',
  warn: 'text-foreground',
  error: 'text-destructive',
} as const

function RoutineListRow({
  row,
  busy,
  onEdit,
  onToggle,
  onAllow,
  onDelete,
}: {
  row: RoutineRow
  busy: boolean
  onEdit: () => void
  onToggle: () => void
  onAllow: (command: string) => void
  onDelete: () => void
}): JSX.Element {
  return (
    <li
      className={cn(
        'flex flex-col gap-2 rounded-md border border-border px-3 py-2.5',
        row.paused && 'opacity-70',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[14px] font-medium text-foreground">
              {row.routine.name}
            </span>
            {row.paused && <Badge variant="outline">Paused</Badge>}
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <CalendarClock className="size-3.5 shrink-0" aria-hidden />
            <span className="truncate">{row.scheduleText}</span>
          </p>
          <p className="text-[12px] text-muted-foreground">{row.nextRunText}</p>
          <p className={cn('text-[12px]', TONE_CLASS[row.tone])}>{row.lastRunText}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={row.paused ? `Resume ${row.routine.name}` : `Pause ${row.routine.name}`}
            title={row.paused ? 'Resume' : 'Pause'}
            disabled={busy}
            onClick={onToggle}
          >
            {row.paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-destructive hover:bg-destructive/10"
            aria-label={`Delete ${row.routine.name}`}
            title="Delete"
            disabled={busy}
            onClick={onDelete}
          >
            <Trash2 className="size-3.5" aria-hidden />
          </Button>
        </div>
      </div>

      {row.lastErrorText && (
        <p className="text-[12px] leading-relaxed text-muted-foreground">{row.lastErrorText}</p>
      )}

      {/* The repair (ADR-0028 part 7 / PRD story 13). The exact invocation the gate
          refused, shown in full, with an action that adds THAT string — never a
          paraphrase of it, and never added for you. Without this, fixing a blocked
          routine means reading the error, opening the editor and retyping the
          command from memory. */}
      {row.repairCommand && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-2">
          <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="text-[12px] text-muted-foreground">It tried to run</span>
          <code className="max-w-full truncate rounded bg-background px-1.5 py-0.5 text-[12px]">
            {row.repairCommand}
          </code>
          <Button
            variant="secondary"
            size="xs"
            className="ml-auto"
            disabled={busy}
            onClick={() => row.repairCommand && onAllow(row.repairCommand)}
          >
            Allow this command
          </Button>
        </div>
      )}
    </li>
  )
}
