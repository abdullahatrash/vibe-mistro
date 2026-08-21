import { useId, useMemo, useState, type JSX } from 'react'
import { Plus, X } from 'lucide-react'
import type {
  RoutineRecord,
  RoutinesCreateArgs,
  RoutinesUpdateArgs,
  RoutineWriteResult,
} from '../../../shared/ipc'
import {
  ALLOWED_COMMAND_MAX_LENGTH,
  ROUTINE_NAME_MAX_LENGTH,
} from '../../../shared/routine-limits'
import { nextRunAfter, type RoutineScheduleKind, type RoutineWeekday } from '../../../shared/schedule'
import {
  allowedCommandProblem,
  allowedCommandWarning,
  initialRoutineFormValues,
  isRoutineFormDirty,
  routineCapProblem,
  routineCreateArgs,
  routineScheduleOf,
  routineUpdateArgs,
  validateRoutineForm,
  type RoutineFormTarget,
  type RoutineFormValues,
} from './routine-form'
import { describeInstant } from './routine-rows'
import { Button } from '../ui/button'
import { Field } from '../ui/field'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { cn } from '../lib/utils'

/**
 * Creating and editing one **Routine**, in the OUTLET (#471, ADR-0028 part 7).
 *
 * Its own view rather than a section of the Bot form, for the reason the Bot form
 * is not a modal: a routine has as many fields as a Bot does — name, schedule kind,
 * time, timezone, prompt, allowed commands — and the prompt and the command list
 * both need real height. Nested inside the Bot form this is a page nobody can scan;
 * beside it, both stay readable and Cancel returns to exactly where you were.
 *
 * Two pieces of copy here are load-bearing rather than decorative:
 *
 *  - **the next run, shown while you are still editing.** ADR-0028 part 7 creates a
 *    routine ACTIVE, diverging from prior art that creates it paused, on the
 *    grounds that a routine which silently does nothing is the failure this whole
 *    design removes. Arming it is only an informed act if you can see when it will
 *    go off.
 *  - **the empty allowed-commands list means the first denial ends the run.** That
 *    is the actual behaviour (#469): the routine profile makes Vibe ask, our list
 *    is the answer, and the first refusal cancels the turn and names the command.
 *    A user who is not told will read their first blocked run as a bug.
 */
export function RoutineFormView({
  target,
  routines,
  botName,
  onCreate,
  onSave,
  onDelete,
  onClose,
}: {
  target: RoutineFormTarget
  /** Every routine record — the edit target is looked up here, and the cap counted. */
  routines: readonly RoutineRecord[]
  /** The Bot this routine reports into, for the header. */
  botName: string
  onCreate: (args: RoutinesCreateArgs) => Promise<RoutineWriteResult>
  onSave: (args: RoutinesUpdateArgs) => Promise<RoutineWriteResult>
  /** Delete (edit only). Resolves with the problems to SHOW — empty on success. */
  onDelete: (routine: RoutineRecord) => Promise<string[]>
  /** Leave the editor — App returns the outlet to the Bot form it was opened from. */
  onClose: () => void
}): JSX.Element {
  const editing =
    target.mode === 'edit' ? (routines.find((r) => r.id === target.routineId) ?? null) : null
  // Seeded ONCE per open: the view is keyed by its target in App, so switching to
  // another routine remounts rather than re-seeding under the user's typing.
  const [values, setValues] = useState<RoutineFormValues>(() =>
    initialRoutineFormValues({ target, routines }),
  )
  const [draftCommand, setDraftCommand] = useState('')
  const [commandProblem, setCommandProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [problems, setProblems] = useState<string[]>([])
  // Only complain once the user has tried to submit — a form that says "a routine
  // needs a name" before the first keystroke is a form that nags.
  const [showErrors, setShowErrors] = useState(false)
  const fieldId = useId()

  const errors = validateRoutineForm(values)
  const invalid = Object.keys(errors).length > 0
  const dirty = editing ? isRoutineFormDirty(values, editing) : true
  const capped = routineCapProblem({
    target,
    routineCount: routines.filter((r) => r.threadId === target.threadId).length,
  })

  // The next run, derived from the values as they are RIGHT NOW — never stored, and
  // recomputed on every render so the answer always belongs to what is on screen.
  const preview = nextRunPreview(values, errors.at !== undefined || errors.timezone !== undefined)

  const zones = useMemo(() => supportedTimezones(), [])

  function set<K extends keyof RoutineFormValues>(key: K, value: RoutineFormValues[K]): void {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  function addCommand(): void {
    const problem = allowedCommandProblem(draftCommand, values.allowedCommands)
    setCommandProblem(problem)
    if (problem) return
    set('allowedCommands', [...values.allowedCommands, draftCommand.trim()])
    setDraftCommand('')
  }

  async function submit(): Promise<void> {
    setShowErrors(true)
    if (invalid || saving || capped) return
    if (editing && !dirty) {
      onClose()
      return
    }
    setSaving(true)
    setProblems([])
    const result = editing
      ? await onSave(routineUpdateArgs(editing.id, values))
      : await onCreate(routineCreateArgs(target.threadId, values))
    setSaving(false)
    if (result.ok) {
      onClose()
      return
    }
    setProblems(result.problems)
  }

  const draftWarning = allowedCommandWarning(draftCommand)

  return (
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      <header>
        <h1 className="truncate text-[20px] font-semibold text-foreground">
          {editing ? `Edit ${editing.name}` : 'New routine'}
        </h1>
        <p className="text-[13px] text-muted-foreground">
          {botName} runs this on a schedule and reports in its own conversation.
          Routines only run while Vibe Mistro is open.
        </p>
      </header>

      {capped && (
        <p className="rounded-md border border-border bg-secondary px-3 py-2 text-[13px] text-muted-foreground">
          {capped}
        </p>
      )}

      <Field
        label="Name"
        controlId={`${fieldId}-name`}
        error={showErrors ? errors.name : undefined}
        hint="This is what the reports and the failure messages call it."
      >
        <Input
          id={`${fieldId}-name`}
          value={values.name}
          maxLength={ROUTINE_NAME_MAX_LENGTH}
          placeholder="Morning triage"
          autoFocus
          onChange={(e) => set('name', e.target.value)}
        />
      </Field>

      <Field label="Schedule" error={showErrors ? errors.at : undefined}>
        <div className="flex flex-wrap items-center gap-2">
          {SCHEDULE_KINDS.map(([kind, label]) => (
            <Button
              key={kind}
              variant={values.kind === kind ? 'default' : 'secondary'}
              size="sm"
              aria-pressed={values.kind === kind}
              onClick={() => set('kind', kind)}
            >
              {label}
            </Button>
          ))}
          <Input
            id={`${fieldId}-at`}
            type="time"
            aria-label="Time of day"
            className="w-[7.5rem]"
            value={values.at}
            onChange={(e) => set('at', e.target.value)}
          />
        </div>
      </Field>

      {values.kind === 'weekly' && (
        <Field label="Day">
          <div className="flex flex-wrap items-center gap-1.5">
            {WEEKDAYS.map(([day, label]) => (
              <Button
                key={day}
                variant={values.weekday === day ? 'default' : 'secondary'}
                size="sm"
                aria-pressed={values.weekday === day}
                onClick={() => set('weekday', day)}
              >
                {label}
              </Button>
            ))}
          </div>
        </Field>
      )}

      <Field
        label="Timezone"
        controlId={`${fieldId}-zone`}
        error={showErrors ? errors.timezone : undefined}
        hint="Stored with the routine, so 09:00 keeps meaning the 09:00 you chose after you travel."
      >
        <Input
          id={`${fieldId}-zone`}
          list={`${fieldId}-zones`}
          value={values.timezone}
          placeholder="Europe/Berlin"
          onChange={(e) => set('timezone', e.target.value)}
        />
        {/* Native datalist: ~400 IANA names are a search box, not a menu. An
            unrecognised one is refused by the field error above, never stored —
            a zone `Intl` cannot resolve makes the schedule uncomputable. */}
        <datalist id={`${fieldId}-zones`}>
          {zones.map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
      </Field>

      {/* Shown while editing, not after saving (ADR-0028 part 7): arming a routine
          is only informed if you can see when it goes off. */}
      <p
        className={cn(
          'rounded-md border border-border bg-secondary px-3 py-2 text-[13px]',
          preview ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {preview
          ? `${values.active ? 'It will next run' : 'Once resumed it would next run'} ${preview}.`
          : 'This schedule cannot be read yet — set a time and a timezone this app knows.'}
      </p>

      <Field
        label="Prompt"
        controlId={`${fieldId}-prompt`}
        error={showErrors ? errors.prompt : undefined}
        hint="Sent exactly as written, into this Bot's conversation, with nobody watching. Say what to check and what to report."
      >
        <Textarea
          id={`${fieldId}-prompt`}
          value={values.prompt}
          rows={8}
          className="min-h-[180px] resize-y font-normal"
          placeholder={
            'Triage this repo issues: list what is new since yesterday, what changed, and what looks stale.\n\n' +
            'Keep it to a short summary I can read with coffee.'
          }
          onChange={(e) => set('prompt', e.target.value)}
        />
      </Field>

      <Field
        label="Allowed commands"
        error={showErrors ? errors.allowedCommands : undefined}
        hint={
          <>
            An unattended run may only use commands listed here, matched as the whole
            line, exactly as written — no prefixes and no wildcards. The first command
            it asks for that is not listed stops the run and names it. With nothing
            listed, a routine that needs a command will stop on its first run.
          </>
        }
      >
        {values.allowedCommands.length > 0 && (
          <ul className="flex flex-col gap-1">
            {values.allowedCommands.map((command) => (
              <li
                key={command}
                className="flex items-center gap-2 rounded-md border border-border bg-secondary px-2.5 py-1.5"
              >
                <code className="min-w-0 flex-1 truncate text-[12px]">{command}</code>
                <button
                  type="button"
                  aria-label={`Remove ${command}`}
                  className="rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary"
                  onClick={() =>
                    set(
                      'allowedCommands',
                      values.allowedCommands.filter((entry) => entry !== command),
                    )
                  }
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center gap-2">
          <Input
            aria-label="Command to allow"
            value={draftCommand}
            maxLength={ALLOWED_COMMAND_MAX_LENGTH}
            placeholder="gh issue list --state open"
            onChange={(e) => {
              setDraftCommand(e.target.value)
              setCommandProblem(null)
            }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              // Enter adds the command; it never submits the form, which would save
              // a routine over what the user meant as "add this line".
              e.preventDefault()
              addCommand()
            }}
          />
          <Button variant="secondary" onClick={addCommand}>
            <Plus className="size-3.5" aria-hidden />
            Add
          </Button>
        </div>
        {commandProblem ? (
          <span className="text-[12px] text-destructive">{commandProblem}</span>
        ) : draftWarning ? (
          <span className="text-[12px] text-foreground">{draftWarning}</span>
        ) : null}
      </Field>

      <Field
        label="Active"
        hint={
          values.active
            ? 'It will run on the schedule above.'
            : 'Paused. Resuming starts from today — it never catches up on the time it was paused.'
        }
      >
        <div className="flex items-center gap-2">
          <Button
            variant={values.active ? 'default' : 'secondary'}
            size="sm"
            aria-pressed={values.active}
            onClick={() => set('active', true)}
          >
            Active
          </Button>
          <Button
            variant={!values.active ? 'default' : 'secondary'}
            size="sm"
            aria-pressed={!values.active}
            onClick={() => set('active', false)}
          >
            Paused
          </Button>
        </div>
      </Field>

      {problems.length > 0 && (
        <ul className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-4">
        {editing && (
          <Button
            variant="ghost"
            className="mr-auto text-destructive hover:bg-destructive/10"
            onClick={() => void onDelete(editing).then(setProblems)}
          >
            Delete routine
          </Button>
        )}
        <div className={cn('flex gap-2', !editing && 'ml-auto')}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={saving || capped !== null || (showErrors && invalid)}
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create routine'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** The presets, which are the whole UI over the structured schedule value. */
const SCHEDULE_KINDS: ReadonlyArray<[RoutineScheduleKind, string]> = [
  ['daily', 'Every day'],
  ['weekdays', 'Weekdays'],
  ['weekly', 'Weekly'],
]

const WEEKDAYS: ReadonlyArray<[RoutineWeekday, string]> = [
  [1, 'Mon'],
  [2, 'Tue'],
  [3, 'Wed'],
  [4, 'Thu'],
  [5, 'Fri'],
  [6, 'Sat'],
  [0, 'Sun'],
]

/**
 * Every IANA zone this build's ICU knows. Electron ships full ICU, so this is the
 * real list; a runtime without `supportedValuesOf` degrades to the machine's own
 * zone, which is what a new routine defaults to anyway.
 */
function supportedTimezones(): string[] {
  try {
    return Intl.supportedValuesOf('timeZone')
  } catch {
    return [Intl.DateTimeFormat().resolvedOptions().timeZone].filter(Boolean)
  }
}

/**
 * "It will next run tomorrow at 09:00", for the values currently in the form —
 * null while the schedule cannot be computed at all.
 */
function nextRunPreview(values: RoutineFormValues, unreadable: boolean): string | null {
  if (unreadable) return null
  const schedule = routineScheduleOf(values)
  const now = Date.now()
  const next = nextRunAfter(schedule, now)
  return next === null ? null : describeInstant(next, now, schedule.timezone)
}
