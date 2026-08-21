import type {
  RoutineRecord,
  RoutinesCreateArgs,
  RoutinesDeleteArgs,
  RoutinesDeleteResult,
  RoutinesListArgs,
  RoutinesUpdateArgs,
  RoutineWriteResult,
} from '../../shared/ipc'
import { MAX_ROUTINES_PER_BOT } from '../../shared/routine-limits'
import { machineTimezone, type RoutineSchedule } from '../../shared/schedule'
import type { BotStoreApi } from '../persistence/bot-store-api'
import type { RoutineStoreApi } from '../persistence/routine-store-api'
import {
  collectRoutineProblems,
  describeRoutineProblems,
  normalizeAllowedCommands,
  validateRoutineFields,
  validateRoutineSchedule,
} from './validate-routine'

/**
 * Create / edit / delete a **Routine** (#467, ADR-0028) — the orchestration the
 * `routines:*` handlers are thin wrappers around, with every dependency injected
 * so the whole lifecycle is testable without Electron or SQLite.
 *
 * The invariant these functions hold: **a stored Routine is one that can be
 * scheduled.** A Routine runs unattended, so a record that cannot compute a next
 * run is not a slightly-wrong row — it is a Bot that silently never reports. So
 * the order is always *validate → persist*, and a refusal is typed and carries
 * the message that says how to fix it.
 *
 * Best-effort per ADR-0019: nothing here rejects into the live flow.
 */

export interface RoutineLifecycleDeps {
  routines: RoutineStoreApi
  /**
   * The Bot half, read-only. A Routine belongs to a **Bot** (ADR-0028 part 1),
   * and an ordinary Thread has no persona, no continuing conversation to report
   * into, and nothing the reports could be compared against — so attaching one
   * to a plain Thread is refused here as well as by the row's foreign key.
   */
  bots: Pick<BotStoreApi, 'get'>
  /** Mint the Routine's id — injected so tests are deterministic. */
  mintRoutineId: () => string
}

/** Every Routine, or one Bot's, for `routines:list`. */
export function listRoutines(
  deps: Pick<RoutineLifecycleDeps, 'routines'>,
  args: RoutinesListArgs = {},
): RoutineRecord[] {
  return args.threadId ? deps.routines.listByBot(args.threadId) : deps.routines.list()
}

/**
 * Create a Routine on a Bot. Created ACTIVE (ADR-0028 part 7): a Routine created
 * in a state where it silently does nothing is the failure family this whole
 * design exists to remove.
 */
export function createRoutine(
  deps: RoutineLifecycleDeps,
  args: RoutinesCreateArgs,
): RoutineWriteResult {
  const schedule = withStoredTimezone(args.schedule)
  const allowedCommands = normalizeAllowedCommands(args.allowedCommands ?? [])

  const problems = describeRoutineProblems([
    ...collectRoutineProblems(
      validateRoutineFields({ name: args.name, prompt: args.prompt, allowedCommands }),
    ),
    ...collectRoutineProblems(validateRoutineSchedule(schedule)),
  ])
  if (problems.length) return { ok: false, reason: 'invalid', problems }

  if (!deps.bots.get(args.threadId)) {
    return {
      ok: false,
      reason: 'notFound',
      problems: ['threadId: a routine belongs to a Bot, and that is not one.'],
    }
  }

  // The cap, read here so the refusal carries a message. The store enforces the
  // same bound as a data invariant — this is the half a person reads.
  if (deps.routines.listByBot(args.threadId).length >= MAX_ROUTINES_PER_BOT) {
    return {
      ok: false,
      reason: 'capped',
      problems: [`A Bot can have at most ${MAX_ROUTINES_PER_BOT} routines.`],
    }
  }

  const record = deps.routines.insert({
    id: deps.mintRoutineId(),
    threadId: args.threadId,
    name: args.name.trim(),
    prompt: args.prompt,
    schedule,
    allowedCommands,
    active: true,
  })
  if (!record) return { ok: false, reason: 'io', problems: ['Could not save the routine.'] }
  return { ok: true, routine: record }
}

/**
 * Edit a Routine in place — including pausing it, which is an ordinary
 * `active: false` patch rather than a second verb. A paused Routine keeps its
 * prompt, which is the whole point of pausing rather than deleting (PRD story 6).
 */
export function updateRoutine(
  deps: Pick<RoutineLifecycleDeps, 'routines'>,
  args: RoutinesUpdateArgs,
): RoutineWriteResult {
  const existing = deps.routines.get(args.id)
  if (!existing) return { ok: false, reason: 'notFound', problems: ['No such routine.'] }

  const schedule = args.schedule ? withStoredTimezone(args.schedule) : existing.schedule
  const allowedCommands = normalizeAllowedCommands(args.allowedCommands ?? existing.allowedCommands)
  const name = args.name ?? existing.name
  const prompt = args.prompt ?? existing.prompt

  const problems = describeRoutineProblems([
    ...collectRoutineProblems(validateRoutineFields({ name, prompt, allowedCommands })),
    ...collectRoutineProblems(validateRoutineSchedule(schedule)),
  ])
  if (problems.length) return { ok: false, reason: 'invalid', problems }

  const record = deps.routines.update(args.id, {
    name: name.trim(),
    prompt,
    schedule,
    allowedCommands,
    ...(args.active === undefined ? {} : { active: args.active }),
  })
  if (!record) return { ok: false, reason: 'io', problems: ['Could not save the routine.'] }
  return { ok: true, routine: record }
}

/** Delete a Routine. The Bot, its conversation and its other Routines are untouched. */
export function deleteRoutine(
  deps: Pick<RoutineLifecycleDeps, 'routines'>,
  args: RoutinesDeleteArgs,
): RoutinesDeleteResult {
  return { ok: deps.routines.delete(args.id) }
}

/**
 * Fill in an absent timezone with the MACHINE's, once, at the write.
 *
 * ADR-0028 part 2: the zone is stored, never followed. Reading it here is the
 * only moment the machine's own zone is consulted — from then on the Routine
 * carries it, so a flight does not silently reschedule the morning.
 */
function withStoredTimezone(schedule: RoutineSchedule): RoutineSchedule {
  if (schedule && typeof schedule === 'object' && !schedule.timezone) {
    return { ...schedule, timezone: machineTimezone() }
  }
  return schedule
}
