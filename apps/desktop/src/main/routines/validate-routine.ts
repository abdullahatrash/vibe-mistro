import { hasBotControlCharacter } from '../../shared/bot-limits'
import {
  ALLOWED_COMMAND_MAX_LENGTH,
  MAX_ALLOWED_COMMANDS,
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_PROMPT_MAX_LENGTH,
} from '../../shared/routine-limits'
import { isRoutineSchedule, isSupportedTimezone, parseTimeOfDay } from '../../shared/schedule'
import type { RoutineSchedule } from '../../shared/schedule'

/**
 * What a **Routine** must be before it is stored (#467, ADR-0028) — pure, so
 * every rule is a unit test rather than a form's behaviour.
 *
 * The rules exist because a Routine runs when NOBODY IS WATCHING. A Bot with a
 * malformed schedule is a Bot that silently never reports; a Routine with no
 * name is a row nobody can tell from the one beside it, and ADR-0028 part 4's
 * failure messages already assume a name exists. So a Routine that cannot
 * schedule is refused at the write, loudly, rather than accepted and left inert.
 *
 * The **allowed commands** are checked for SHAPE only here — one literal
 * invocation per entry, bounded, no line breaks. Matching an agent's requested
 * command against them (whole-string, refusing redirects, pipes and
 * substitutions unless listed verbatim) is the answering path's job in a later
 * slice, and belongs beside the thing that answers.
 */

/** One reason a Routine was refused, addressed to the user. */
export interface RoutineProblem {
  /** The record field at fault (`name`, `schedule.at`, `allowedCommands`, …). */
  field: string
  message: string
}

export type RoutineValidation = { ok: true } | { ok: false; problems: RoutineProblem[] }

/** The `when`: is this something `nextRunAfter` can compute with? */
export function validateRoutineSchedule(schedule: RoutineSchedule): RoutineValidation {
  const problems: RoutineProblem[] = []
  if (!isRoutineSchedule(schedule)) {
    // Say WHICH part is wrong — "invalid schedule" is what the user already knows.
    const candidate = (schedule ?? {}) as Partial<RoutineSchedule> & { weekday?: unknown }
    if (!candidate.kind || !['daily', 'weekdays', 'weekly'].includes(candidate.kind)) {
      problems.push({
        field: 'schedule.kind',
        message: `"${String(candidate.kind)}" is not a schedule kind (daily, weekdays or weekly).`,
      })
    }
    if (typeof candidate.at !== 'string' || parseTimeOfDay(candidate.at) === null) {
      problems.push({
        field: 'schedule.at',
        message: `"${String(candidate.at)}" is not a time of day (HH:MM, 24-hour).`,
      })
    }
    if (candidate.kind === 'weekly' && !isWeekday(candidate.weekday)) {
      problems.push({
        field: 'schedule.weekday',
        message: 'A weekly routine needs a weekday (0 = Sunday … 6 = Saturday).',
      })
    }
    if (typeof candidate.timezone !== 'string' || !candidate.timezone) {
      problems.push({ field: 'schedule.timezone', message: 'A schedule needs a timezone.' })
    }
  }
  // The zone is checked separately from the structure: it is the one field whose
  // validity depends on the ICU this build carries, and a Routine is STORED with
  // it (ADR-0028 part 2) — so a name Intl cannot resolve must never be written,
  // or 09:00 quietly means nothing at all.
  if (typeof schedule?.timezone === 'string' && schedule.timezone && !isSupportedTimezone(schedule.timezone)) {
    problems.push({
      field: 'schedule.timezone',
      message: `"${schedule.timezone}" is not an IANA timezone this app knows.`,
    })
  }
  return problems.length ? { ok: false, problems } : { ok: true }
}

/** What a Routine record must carry, whatever it is scheduled for. */
export function validateRoutineFields(input: {
  name: string
  prompt: string
  allowedCommands: string[]
}): RoutineValidation {
  const problems: RoutineProblem[] = []

  const name = input.name.trim()
  if (!name) {
    problems.push({ field: 'name', message: 'A routine needs a name.' })
  } else if (name.length > ROUTINE_NAME_MAX_LENGTH) {
    problems.push({
      field: 'name',
      message: `A name can be at most ${ROUTINE_NAME_MAX_LENGTH} characters.`,
    })
  } else if (hasBotControlCharacter(name)) {
    // The same one-line rule the Bot record uses (`shared/bot-limits`), for the
    // same reason: this name is a row in a list, not prose.
    problems.push({
      field: 'name',
      message: 'A name cannot contain line breaks or control characters.',
    })
  }

  const prompt = input.prompt.trim()
  if (!prompt) {
    // A routine with nothing to say would fire a blank turn on a schedule, and
    // ADR-0028 part 5 says every routine turn writes an entry — so this one would
    // report, daily, that it had nothing to ask.
    problems.push({ field: 'prompt', message: 'A routine needs a prompt to send.' })
  } else if (prompt.length > ROUTINE_PROMPT_MAX_LENGTH) {
    problems.push({
      field: 'prompt',
      message: `A prompt can be at most ${ROUTINE_PROMPT_MAX_LENGTH} characters.`,
    })
  }

  if (!Array.isArray(input.allowedCommands)) {
    problems.push({ field: 'allowedCommands', message: 'Allowed commands must be a list.' })
  } else if (input.allowedCommands.length > MAX_ALLOWED_COMMANDS) {
    problems.push({
      field: 'allowedCommands',
      message: `A routine can list at most ${MAX_ALLOWED_COMMANDS} allowed commands.`,
    })
  } else {
    for (const command of input.allowedCommands) {
      if (typeof command !== 'string' || !command.trim()) {
        problems.push({ field: 'allowedCommands', message: 'An allowed command cannot be blank.' })
      } else if (command.length > ALLOWED_COMMAND_MAX_LENGTH) {
        problems.push({
          field: 'allowedCommands',
          message: `An allowed command can be at most ${ALLOWED_COMMAND_MAX_LENGTH} characters.`,
        })
      } else if (hasBotControlCharacter(command)) {
        // A line break inside "one invocation" is two invocations, and only one
        // of them would ever be read by whoever authored the list.
        problems.push({
          field: 'allowedCommands',
          message: `"${command}" spans more than one line; list one invocation per entry.`,
        })
      }
    }
  }

  return problems.length ? { ok: false, problems } : { ok: true }
}

/**
 * The allowed commands as they are STORED: trimmed, blanks dropped, duplicates
 * dropped, order kept.
 *
 * Trimming at the write is deliberate — #458 found leading and trailing
 * whitespace between an entry and the invocation it was meant to authorise, and
 * a list whose entries differ from what the user meant to type is a list that
 * answers questions nobody asked.
 */
export function normalizeAllowedCommands(commands: string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const command of commands) {
    if (typeof command !== 'string') continue
    const trimmed = command.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    normalized.push(trimmed)
  }
  return normalized
}

/** The problems of a validation, or none. Handy for merging + for messages. */
export function collectRoutineProblems(result: RoutineValidation): RoutineProblem[] {
  return result.ok ? [] : result.problems
}

/** Render problems as the `problems: string[]` the IPC reply carries. */
export function describeRoutineProblems(problems: RoutineProblem[]): string[] {
  return problems.map((problem) => `${problem.field}: ${problem.message}`)
}

function isWeekday(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6
}
