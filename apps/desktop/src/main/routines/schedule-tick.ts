import type { RoutineRecord } from '../../shared/ipc'
import { nextRunAfter } from '../../shared/schedule'
import { LATE_AFTER_MS, expectedRun } from './missed-runs'

/**
 * **One tick of the Routine scheduler, as a pure decision** (#470, ADR-0028) —
 * given the Routine rows, the clock, which Bots are busy and what was deferred
 * last time, decide what to fire, what to keep waiting for, and what to record.
 *
 * The decision is separated from the timer for the usual reason and one extra:
 * collisions, the deferral bound and catch-up become ORDINARY UNIT TESTS instead
 * of timing tests. Nothing here touches a store, a pool or an agent — the caller
 * (`scheduler.ts`) does all of that, and hands the answers back on the next tick.
 *
 * Three rules it holds:
 *
 *  - **One Bot, one turn.** A Bot is one continuing conversation, so two Routines
 *    due at the same instant cannot both run: the older slot fires and the other
 *    is deferred. The Bot's live streaming flag is the busy signal (per-THREAD,
 *    never the per-agent in-flight count — one `vibe-acp` child legitimately hosts
 *    concurrent turns across sessions, #456).
 *  - **A deferral is bounded by the Routine's own next slot.** Re-checked every
 *    tick until then; past it we give up and record `deferred`. A Bot you talk to
 *    all day must not accrue an unbounded queue of yesterday's runs.
 *  - **A defer writes NOTHING into the conversation** (ADR-0028 part 5). It is
 *    recorded on the Routine, which is what keeps it from being invisible without
 *    making a Bot chattier the more you use it.
 *
 * Deferrals live in the caller's memory and are never stored: a deferral is a
 * statement about this minute, and a stored one would be a stale value somebody
 * has to remember to clear — the failure family ADR-0028 part 6 exists to remove.
 */

/** A run the tick decided to start now. */
export interface RoutineFire {
  routineId: string
  /** The Bot's Thread this run goes into. */
  threadId: string
  /** The scheduled instant this run is FOR — not the instant it starts. */
  dueAt: number
  /** True when the slot is materially older than now (see `LATE_AFTER_MS`). */
  late: boolean
  /** The Routine's `lastRunAt` at decision time — null when it has NEVER run. */
  lastRunAt: number | null
}

/**
 * A due run waiting for its Bot to be free. Carried from tick to tick in memory.
 */
export interface PendingDeferral {
  routineId: string
  threadId: string
  /** The slot being waited on — preserved, so a run that resolves late says which slot. */
  dueAt: number
  /** The Routine's NEXT slot: the instant we stop waiting and give up. */
  expiresAt: number
  /** `lastRunAt` as it stood when the slot came due (null = never run). */
  lastRunAt: number | null
}

/** A deferral that hit its bound: record `deferred` on the Routine, write nothing else. */
export interface ExpiredDeferral {
  routineId: string
  /** The slot that was given up — what the record's `lastRunAt` is set to. */
  dueAt: number
}

export interface RoutineTickInput {
  /** Every Routine, as stored. Paused ones are skipped here, not by the firer. */
  routines: readonly RoutineRecord[]
  now: number
  /** Bot Threads that cannot take a turn: streaming, or already running a Routine. */
  busyThreads: ReadonlySet<string>
  /** Routines whose run is still in flight — their `lastRunAt` has not moved yet. */
  runningRoutines: ReadonlySet<string>
  /** What the previous tick decided to keep waiting for. */
  deferrals: readonly PendingDeferral[]
  /**
   * Per-Routine baseline floors held in memory — today, the instant a Routine was
   * RESUMED in this session (ADR-0028 part 7: no catch-up for a paused period).
   */
  floors?: ReadonlyMap<string, number>
}

export interface RoutineTickDecision {
  /** Start these now, in order. At most one per Bot Thread. */
  fire: RoutineFire[]
  /** The WHOLE deferral set for the next tick — replaces the previous one. */
  defer: PendingDeferral[]
  /** Record `deferred` on these; nothing reaches the conversation. */
  report: ExpiredDeferral[]
}

/**
 * Decide one tick.
 *
 * Deferrals are settled BEFORE new slots, so a Routine whose old slot expires at
 * the very instant its next slot arrives records the give-up and then competes for
 * the new slot in the same tick — rather than losing a slot to its own backlog.
 */
export function decideRoutineTick(input: RoutineTickInput): RoutineTickDecision {
  const byId = new Map(input.routines.map((routine) => [routine.id, routine]))
  const fire: RoutineFire[] = []
  const defer: PendingDeferral[] = []
  const report: ExpiredDeferral[] = []
  // Every Thread already spoken for this tick: busy before we started, or claimed
  // by a fire we just decided on. One Bot, one turn.
  const claimed = new Set(input.busyThreads)
  /** Routines already settled this tick — a carried deferral wins over a new slot. */
  const settled = new Set<string>()

  for (const pending of input.deferrals) {
    const routine = byId.get(pending.routineId)
    // Deleted, paused or already running since the deferral was made: drop it
    // silently. There is nothing to record against a Routine that is gone, and a
    // paused one has no missed runs by definition.
    if (!routine || !routine.active || input.runningRoutines.has(routine.id)) continue
    if (input.now >= pending.expiresAt) {
      // Given up — and deliberately NOT settled, so the slot that has just come due
      // (the very instant this bound expires) competes in the pass below. A Routine
      // must not lose a slot to its own backlog.
      report.push({ routineId: pending.routineId, dueAt: pending.dueAt })
      continue
    }
    settled.add(routine.id)
    if (claimed.has(pending.threadId)) {
      defer.push(pending)
      continue
    }
    claimed.add(pending.threadId)
    fire.push({
      routineId: pending.routineId,
      threadId: pending.threadId,
      dueAt: pending.dueAt,
      // Measured at FIRE time, not when the slot came due: a run that waited out a
      // long turn is late for the same reason one that waited out a closed app is.
      late: input.now - pending.dueAt > LATE_AFTER_MS,
      lastRunAt: pending.lastRunAt,
    })
  }

  // New slots, oldest first so the Bot owed two runs starts with the older one;
  // creation order breaks a tie, which is the order the authoring list shows.
  const due: { routine: RoutineRecord; dueAt: number; late: boolean }[] = []
  for (const routine of input.routines) {
    if (settled.has(routine.id) || input.runningRoutines.has(routine.id)) continue
    const run = expectedRun(routine, input.now, input.floors?.get(routine.id))
    if (run) due.push({ routine, ...run })
  }
  due.sort((a, b) => a.dueAt - b.dueAt || a.routine.createdAt - b.routine.createdAt)

  for (const { routine, dueAt, late } of due) {
    if (claimed.has(routine.threadId)) {
      defer.push({
        routineId: routine.id,
        threadId: routine.threadId,
        dueAt,
        // The bound: this Routine's own next slot. Null cannot follow a computable
        // last-due, but if the arithmetic ever declines, an already-expired bound
        // gives up on the next tick rather than waiting forever.
        expiresAt: nextRunAfter(routine.schedule, dueAt) ?? dueAt,
        lastRunAt: routine.lastRunAt,
      })
      continue
    }
    claimed.add(routine.threadId)
    fire.push({
      routineId: routine.id,
      threadId: routine.threadId,
      dueAt,
      late,
      lastRunAt: routine.lastRunAt,
    })
  }

  return { fire, defer, report }
}
