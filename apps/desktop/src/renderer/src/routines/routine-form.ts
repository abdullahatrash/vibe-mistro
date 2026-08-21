import type { RoutineRecord, RoutinesCreateArgs, RoutinesUpdateArgs } from '../../../shared/ipc'
import { hasBotControlCharacter } from '../../../shared/bot-limits'
import {
  ALLOWED_COMMAND_MAX_LENGTH,
  MAX_ALLOWED_COMMANDS,
  MAX_ROUTINES_PER_BOT,
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_PROMPT_MAX_LENGTH,
} from '../../../shared/routine-limits'
import {
  isSupportedTimezone,
  machineTimezone,
  parseTimeOfDay,
  type RoutineSchedule,
  type RoutineScheduleKind,
  type RoutineWeekday,
} from '../../../shared/schedule'

/**
 * The Routine editor, as data (#471, ADR-0028 part 7). Pure — no React, no IPC —
 * so what the form ACCEPTS, what it REFUSES and what it SENDS are settled in a unit
 * test rather than by clicking through the app.
 *
 * The division of labour with main is the Bot form's, for the same reasons. Main is
 * the validator: `main/routines/validate-routine.ts` refuses a record that cannot
 * schedule, and its `problems` are shown verbatim. This module applies the rules
 * BOTH sides share (`shared/routine-limits`, `shared/schedule`) one step earlier,
 * so a malformed time or an unknown zone is a message beside the field instead of a
 * round trip.
 *
 * Two rules are this form's alone, and both come from the surface being where a
 * user learns what a routine can do:
 *
 *  - **the 5-per-Bot cap is stated before you type**, not after you submit. Main
 *    answers `capped`; a form that lets you write a prompt first and then says the
 *    Bot is full has wasted the only thing you actually wrote.
 *  - **an allowed command is checked against what the MATCHER will do with it.**
 *    `main/routines/allowed-commands.ts` compares the WHOLE invocation, verbatim:
 *    no prefixes, no globs, no tokenising. So an entry a person would read as a
 *    pattern — `gh issue *` — matches nothing at all, and only this form is in a
 *    position to say so while it can still be fixed. It is a warning rather than a
 *    refusal: the matcher does honour such an entry if the command really is that
 *    text, and refusing it here would be this form inventing a rule the gate does
 *    not have.
 */

/** Which routine the editor is for — the nav target, mirroring `BotFormTarget`. */
export type RoutineFormTarget =
  /** A new Routine on this Bot (its Thread id — a Bot IS one continuing Thread). */
  | { mode: 'create'; threadId: string }
  /** An existing Routine, which is edited in its own view. */
  | { mode: 'edit'; threadId: string; routineId: string }

/** Everything the editor edits. `active` is here so pausing is possible from it too. */
export interface RoutineFormValues {
  name: string
  prompt: string
  kind: RoutineScheduleKind
  /** `HH:MM`, 24-hour — validated here exactly as `shared/schedule` parses it. */
  at: string
  /** Only meaningful for a `weekly` schedule; kept across a kind switch so a
   * mis-click does not discard the day you picked. */
  weekday: RoutineWeekday
  timezone: string
  allowedCommands: string[]
  active: boolean
}

/** Per-field messages, keyed by the field at fault. Empty = submittable. */
export type RoutineFormErrors = Partial<Record<keyof RoutineFormValues, string>>

/** The default a new Routine starts on: the motivating example's own schedule. */
export const DEFAULT_ROUTINE_TIME = '09:00'

/**
 * The form's starting values.
 *
 * A create starts on **weekdays at 09:00** in the machine's zone — the motivating
 * example of the whole epic ("triage this repo every morning") — read ONCE here and
 * then stored, so travelling never re-points an existing routine (ADR-0028 part 2).
 * It also starts ACTIVE: a routine created in a state where it silently does
 * nothing is the failure family this design exists to remove.
 */
export function initialRoutineFormValues(args: {
  target: RoutineFormTarget
  routines: readonly RoutineRecord[]
}): RoutineFormValues {
  const target = args.target
  if (target.mode === 'edit') {
    const routine = args.routines.find((r) => r.id === target.routineId)
    if (routine) {
      return {
        name: routine.name,
        prompt: routine.prompt,
        kind: routine.schedule.kind,
        at: routine.schedule.at,
        weekday: routine.schedule.kind === 'weekly' ? routine.schedule.weekday : 1,
        timezone: routine.schedule.timezone,
        allowedCommands: [...routine.allowedCommands],
        active: routine.active,
      }
    }
    // A record that vanished under the form (deleted in another window): fall
    // through to an empty create-shaped form rather than rendering stale values.
  }
  return {
    name: '',
    prompt: '',
    kind: 'weekdays',
    at: DEFAULT_ROUTINE_TIME,
    weekday: 1,
    timezone: machineTimezone(),
    allowedCommands: [],
    active: true,
  }
}

/** The schedule these values describe — the value main stores, built in one place. */
export function routineScheduleOf(values: RoutineFormValues): RoutineSchedule {
  const base = { at: values.at.trim(), timezone: values.timezone.trim() }
  return values.kind === 'weekly'
    ? { kind: 'weekly', weekday: values.weekday, ...base }
    : { kind: values.kind, ...base }
}

/**
 * What is wrong with these values, per field. The bounds are
 * `shared/routine-limits`; the schedule rules are `shared/schedule`'s own parser
 * and zone check, so the form and the scheduler agree about what is computable.
 *
 * The NAME is required and that is not a style choice: slices 3 and 4 already write
 * messages that name the routine ("Morning triage was stopped before running…"),
 * and a list of identical schedules is unreadable.
 */
export function validateRoutineForm(values: RoutineFormValues): RoutineFormErrors {
  const errors: RoutineFormErrors = {}

  const name = values.name.trim()
  if (!name) errors.name = 'A routine needs a name.'
  else if (name.length > ROUTINE_NAME_MAX_LENGTH) {
    errors.name = `A name can be at most ${ROUTINE_NAME_MAX_LENGTH} characters.`
  } else if (hasBotControlCharacter(name)) {
    errors.name = 'A name cannot contain line breaks.'
  }

  const prompt = values.prompt.trim()
  if (!prompt) errors.prompt = 'A routine needs a prompt to send.'
  else if (prompt.length > ROUTINE_PROMPT_MAX_LENGTH) {
    errors.prompt = `A prompt can be at most ${ROUTINE_PROMPT_MAX_LENGTH} characters.`
  }

  if (parseTimeOfDay(values.at.trim()) === null) {
    errors.at = 'A time is HH:MM on a 24-hour clock — 09:00, or 17:30.'
  }

  const timezone = values.timezone.trim()
  if (!timezone) errors.timezone = 'A routine needs a timezone — 09:00 has to be 09:00 somewhere.'
  else if (!isSupportedTimezone(timezone)) {
    errors.timezone = `"${timezone}" is not a timezone this app knows.`
  }

  if (values.allowedCommands.length > MAX_ALLOWED_COMMANDS) {
    errors.allowedCommands = `A routine can list at most ${MAX_ALLOWED_COMMANDS} allowed commands.`
  }

  return errors
}

/** Whether the form may be submitted at all (the cap is asked separately). */
export function canSubmitRoutineForm(values: RoutineFormValues): boolean {
  return Object.keys(validateRoutineForm(values)).length === 0
}

/**
 * The cap, stated BEFORE anything is typed (ADR-0028 part 1 — 5 per Bot).
 *
 * Only a create can hit it: editing the fifth routine is not adding a sixth. Main
 * enforces the same number and answers `capped`; this exists so the answer arrives
 * before the prompt is written rather than after.
 */
export function routineCapProblem(args: {
  target: RoutineFormTarget
  routineCount: number
}): string | null {
  if (args.target.mode !== 'create') return null
  if (args.routineCount < MAX_ROUTINES_PER_BOT) return null
  return (
    `This Bot already has ${MAX_ROUTINES_PER_BOT} routines, which is the most one Bot can hold. ` +
    'Edit or delete one of them to make room.'
  )
}

/**
 * Why this text cannot be ADDED to the allowed commands, or null when it can.
 *
 * A refusal here is only ever for something the stored list genuinely cannot carry:
 * `normalizeAllowedCommands` trims and de-duplicates on the way in, main's validator
 * bounds the length and refuses a line break, and a blank entry would authorise
 * nothing while looking like it authorised something.
 */
export function allowedCommandProblem(entry: string, existing: readonly string[]): string | null {
  const command = entry.trim()
  if (!command) return 'Type the command to allow first.'
  if (command.length > ALLOWED_COMMAND_MAX_LENGTH) {
    return `A command can be at most ${ALLOWED_COMMAND_MAX_LENGTH} characters.`
  }
  if (hasBotControlCharacter(command)) {
    return 'List one invocation per entry — a line break makes it two commands.'
  }
  if (existing.some((candidate) => candidate.trim() === command)) {
    return 'That command is already on the list.'
  }
  if (existing.length >= MAX_ALLOWED_COMMANDS) {
    return `A routine can list at most ${MAX_ALLOWED_COMMANDS} allowed commands.`
  }
  return null
}

/**
 * What this entry will do that its author probably does not expect — or null.
 *
 * The matcher compares the WHOLE invocation, verbatim (`allowed-commands.ts`), so
 * the two ways an entry silently matches nothing are a pattern that is not a
 * pattern and a prefix that is not a prefix. Warnings, never refusals: the gate
 * honours a listed string whatever is in it, and this form must not invent a rule
 * the gate does not have.
 */
export function allowedCommandWarning(entry: string): string | null {
  const command = entry.trim()
  if (!command) return null
  if (command.includes('*') || command.includes('?')) {
    return 'Wildcards are not expanded — this matches only a command containing those characters exactly.'
  }
  if (/[<>|;&`$()]/.test(command)) {
    return 'This combines commands (a redirect, pipe, separator or substitution). It is allowed only when the agent runs exactly this line.'
  }
  return null
}

/** The commands as they will be STORED: trimmed, blanks and duplicates dropped. */
export function normalizeFormCommands(commands: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const command of commands) {
    const trimmed = command.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

/** The `routines:create` payload for these values. */
export function routineCreateArgs(threadId: string, values: RoutineFormValues): RoutinesCreateArgs {
  return {
    threadId,
    name: values.name.trim(),
    prompt: values.prompt.trim(),
    schedule: routineScheduleOf(values),
    allowedCommands: normalizeFormCommands(values.allowedCommands),
  }
}

/**
 * The `routines:update` payload. Carries every editable field including `active`,
 * so the editor can pause a routine as well as the list can — main merges by
 * presence and one write is one round trip.
 */
export function routineUpdateArgs(routineId: string, values: RoutineFormValues): RoutinesUpdateArgs {
  return {
    id: routineId,
    name: values.name.trim(),
    prompt: values.prompt.trim(),
    schedule: routineScheduleOf(values),
    allowedCommands: normalizeFormCommands(values.allowedCommands),
    active: values.active,
  }
}

/** Whether an edit changed anything worth writing — Save stays honest about no-ops. */
export function isRoutineFormDirty(values: RoutineFormValues, routine: RoutineRecord): boolean {
  const schedule = routineScheduleOf(values)
  return (
    values.name.trim() !== routine.name ||
    values.prompt.trim() !== routine.prompt ||
    values.active !== routine.active ||
    schedule.kind !== routine.schedule.kind ||
    schedule.at !== routine.schedule.at ||
    schedule.timezone !== routine.schedule.timezone ||
    (schedule.kind === 'weekly' &&
      routine.schedule.kind === 'weekly' &&
      schedule.weekday !== routine.schedule.weekday) ||
    !sameCommands(normalizeFormCommands(values.allowedCommands), routine.allowedCommands)
  )
}

function sameCommands(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}
