import type { RoutineSchedule } from '../schedule'

/**
 * Routines domain of the shared IPC contract (#467, ADR-0028): the CRUD surface
 * over a **Routine** — a named schedule attached to a **Mistro Bot** which, when
 * due, runs ONE headless prompt turn into that Bot's existing conversation and
 * reports there.
 *
 * This slice is the record, its schedule value and its store. The firing, the
 * scheduler and the authoring surfaces are later slices; nothing here runs
 * anything.
 *
 * `RoutineSchedule` and the arithmetic over it live in `shared/schedule` and are
 * deliberately NOT re-exported here, so there is one import path for the value
 * both the firer and the detector compute with.
 *
 * Keep this file free of Node/DOM imports so both sides can consume it.
 */

/** The routines channel entries, merged into the single `IPC` const in `./index`. */
export const routinesChannels = {
  /** Every Routine, or one Bot's — see {@link RoutinesListArgs}. */
  routinesList: 'routines:list',
  /** Create a Routine on a Bot. Refused past {@link MAX_ROUTINES_PER_BOT}. */
  routinesCreate: 'routines:create',
  /** Edit a Routine in place, including pausing it (`active: false`). */
  routinesUpdate: 'routines:update',
  /** Delete a Routine. The Bot and its conversation are untouched. */
  routinesDelete: 'routines:delete',
} as const

/**
 * How a Routine's last run ended (ADR-0028 part 6). Deliberately NOT a place for
 * *missed*, *late* or *never*: those are comparisons between the schedule and
 * `lastRunAt`, derived at launch by a detector that shares no code with the
 * firing path — because the case worth catching is the one where no code ran at
 * all, and a flag nobody set is indistinguishable from a flag nobody needed.
 *
 * - `ok` — the turn ran and ended.
 * - `failed` — it could not run, or it broke (sign-in expired, no agent, …).
 * - `blocked` — an **allowed commands** denial cancelled the turn.
 * - `deferred` — the Bot was busy, so this slot was given up. Recorded on the
 *   Routine and never written into the conversation.
 */
export type RoutineOutcome = 'ok' | 'failed' | 'blocked' | 'deferred'

/**
 * One Routine, as persisted.
 *
 * `threadId` names the **Bot** it belongs to — a Bot IS one continuing Thread
 * (ADR-0027), so that is the whole address. The row cascades with the Bot, and
 * with the Bot's Thread and Workspace behind it.
 *
 * **There is no `nextRunAt` field, deliberately** (ADR-0028 part 6). A stored
 * next-fire is a value somebody must remember to rewrite; the next run is a pure
 * function of the schedule (`nextRunAfter`), so it is computed wherever it is
 * shown and can never go stale.
 */
export interface RoutineRecord {
  /** Ours, minted by main. */
  id: string
  /** The Bot this Routine belongs to and reports into. */
  threadId: string
  /** Required and non-empty: a list of identical schedules is unreadable. */
  name: string
  /** The prompt the headless turn sends, verbatim. */
  prompt: string
  /** The `when`. A structured value, never a cron string — see `shared/schedule`. */
  schedule: RoutineSchedule
  /**
   * The **allowed commands**: literal invocations this Routine may run
   * unattended. EMPTY by default, and never seeded from what the Bot has already
   * run while you watched (ADR-0028 part 4). Matching them is slice 3's job.
   */
  allowedCommands: string[]
  /**
   * False = paused. A paused Routine has no missed runs: resuming sets a fresh
   * baseline rather than accruing a fortnight of catch-up.
   */
  active: boolean
  /** When the last run STARTED, or null if it has never run. */
  lastRunAt: number | null
  /** How that run ended, or null if it has never run. */
  lastOutcome: RoutineOutcome | null
  /** The failure detail behind a `failed` / `blocked` outcome — the fixable message. */
  lastError: string | null
  createdAt: number
  updatedAt: number
}

/** Args for `routines:list`. Omit `threadId` for every Bot's Routines. */
export interface RoutinesListArgs {
  /** One Bot's Routines, oldest first. */
  threadId?: string
}

/** The `routines:list` reply. */
export interface RoutinesListResult {
  routines: RoutineRecord[]
}

/**
 * Args for `routines:create`. Main mints the `id`, and defaults an omitted
 * `schedule.timezone` to the machine's — read ONCE, at creation, and then stored
 * (ADR-0028 part 2), so a Routine keeps meaning the 09:00 you chose after you
 * travel.
 *
 * A Routine is created ACTIVE; there is no `active` here on purpose. One created
 * in a state where it silently does nothing is the failure family this design
 * exists to remove.
 */
export interface RoutinesCreateArgs {
  /** The Bot to attach it to. Must BE a Bot — an ordinary Thread is refused. */
  threadId: string
  name: string
  prompt: string
  schedule: RoutineSchedule
  /** Defaults to empty: a Routine may run nothing until you say what it may run. */
  allowedCommands?: string[]
}

/** Args for `routines:update`. Omitted fields are left alone. */
export interface RoutinesUpdateArgs {
  id: string
  name?: string
  prompt?: string
  schedule?: RoutineSchedule
  allowedCommands?: string[]
  /** Pause (`false`) or resume (`true`). */
  active?: boolean
}

/** Args for `routines:delete`. */
export interface RoutinesDeleteArgs {
  id: string
}

/**
 * Why a Routine write was refused. `invalid` = the record would not schedule
 * (bad time, unknown zone, no name); `notFound` = no such Routine, or its
 * `threadId` is not a Bot; `capped` = the Bot already holds
 * {@link MAX_ROUTINES_PER_BOT}; `io` = the row could not be written.
 */
export type RoutineWriteFailure = 'invalid' | 'notFound' | 'capped' | 'io'

/**
 * The reply to `routines:create` / `routines:update`. Failure is LOUD and typed
 * rather than thrown, like every Bot write: `problems` carries the
 * human-readable messages the form shows.
 */
export type RoutineWriteResult =
  | { ok: true; routine: RoutineRecord }
  | { ok: false; reason: RoutineWriteFailure; problems: string[] }

/** The reply to `routines:delete`. Best-effort: `ok:false` means nothing was removed. */
export interface RoutinesDeleteResult {
  ok: boolean
}
