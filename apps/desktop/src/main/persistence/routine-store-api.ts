import type { RoutineOutcome, RoutineRecord } from '../../shared/ipc'
import type { RoutineSchedule } from '../../shared/schedule'

/**
 * The public surface of the **Routine** store (#467, ADR-0028) — the seam every
 * Routine flow in main types against, mirroring `BotStoreApi` exactly (which
 * itself mirrors `MetadataStoreApi` / `TranscriptStoreApi`). One implementation
 * today (`SqliteRoutineStore`, on the same `state.sqlite` as everything else);
 * the interface exists so the lifecycle and the IPC handlers can be tested
 * without a database.
 *
 * SYNCHRONOUS on purpose, like `BotStoreApi`: `node:sqlite` is synchronous and
 * there is no legacy engine behind this seam.
 *
 * Best-effort like every other store here: a write that cannot land LOGS and
 * reports failure (`null` / `false`) rather than throwing into the live flow —
 * which for Routines matters twice over, since the flow that writes here is a
 * turn nobody is watching.
 */

/** A new Routine's row values. The id is minted by the caller, never by the renderer. */
export interface RoutineInsert {
  id: string
  /** The Bot this Routine belongs to. Must name a Bot row (the FK). */
  threadId: string
  name: string
  prompt: string
  schedule: RoutineSchedule
  allowedCommands: string[]
  /** A Routine is created ACTIVE (ADR-0028 part 7); the field exists for restores. */
  active: boolean
}

/**
 * The editable half of a Routine. `threadId` is deliberately absent: a Routine
 * belongs to the Bot whose conversation it reports into, so moving one would
 * strand its reports away from the history that makes them readable.
 */
export interface RoutinePatch {
  name?: string
  prompt?: string
  schedule?: RoutineSchedule
  allowedCommands?: string[]
  active?: boolean
}

/**
 * The run outcome, written by the firer (slice 2) after every turn — success or
 * failure, one rule with no exceptions (ADR-0028 part 5).
 *
 * `lastError` is cleared by an `ok`, so a Routine that recovered does not keep
 * showing the failure it recovered from.
 */
export interface RoutineRunResult {
  lastRunAt: number
  lastOutcome: RoutineOutcome
  /** The fixable message behind a `failed` / `blocked` run; omitted for `ok`. */
  lastError?: string | null
  /**
   * The exact invocation the allowed-commands gate refused (#469), or null. Unlike
   * `lastError` this is NOT carried forward: a run that was not blocked clears it,
   * so the offer to add a command can never be made about a command that is no
   * longer the reason anything failed.
   */
  lastBlockedCommand?: string | null
}

export interface RoutineStoreApi {
  /** Every Routine, oldest first, across every Bot. Empty on a locked database. */
  list(): RoutineRecord[]
  /** One Bot's Routines, oldest first — creation order, which is the authoring list's order. */
  listByBot(threadId: string): RoutineRecord[]
  /** One Routine by id, or null. */
  get(id: string): RoutineRecord | null
  /**
   * Insert a Routine row. Returns null when the write could not land (logged) —
   * including when the Bot already holds `MAX_ROUTINES_PER_BOT` of them, which
   * this store enforces as a data invariant so no writer can get past it.
   */
  insert(input: RoutineInsert): RoutineRecord | null
  /** Patch a Routine in place. Returns null for an unknown id or a failed write. */
  update(id: string, patch: RoutinePatch): RoutineRecord | null
  /** Record how a run ended. Returns null for an unknown id or a failed write. */
  recordRun(id: string, result: RoutineRunResult): RoutineRecord | null
  /** Drop a Routine row. Idempotent; false = nothing removed. */
  delete(id: string): boolean
}
