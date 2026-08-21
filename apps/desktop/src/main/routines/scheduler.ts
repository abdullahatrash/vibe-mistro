import type { RoutineStoreApi } from '../persistence/routine-store-api'
import { nextRunAfter } from '../../shared/schedule'
import { detectMissedRuns, type MissedRun } from './missed-runs'
import { decideRoutineTick, type PendingDeferral, type RoutineFire } from './schedule-tick'
import type { RoutineTurnResult, RunRoutineOptions } from './run-routine-turn'

/**
 * **The Routine scheduler** (#470, ADR-0028) — the periodic tick in main that
 * fires what is due, waits out a busy Bot, and catches up ONCE at launch for
 * whatever could not run while the app was shut.
 *
 * The timer is the only thing in this file that is not a straight application of
 * two pure modules: `schedule-tick.ts` decides each tick, `missed-runs.ts`
 * recomputes what is owed, and this holds the interval, the in-flight set and the
 * deferrals between them. That split is deliberate — collisions, the deferral
 * bound and catch-up are unit tests here rather than timing tests.
 *
 * **Routines fire only while the app is open.** Electron has no background daemon
 * and we ship no server, so this is stated rather than disguised: it is exactly
 * why the launch catch-up exists, and why a run that never happened has to be
 * visible instead of looking like one that happened and found nothing.
 */

/** How often the tick asks whether anything is due. */
export const ROUTINE_TICK_MS = 30 * 1000

export interface RoutineSchedulerDeps {
  /** The rows. Re-listed every tick: a Routine edited mid-session must be honoured. */
  routines: Pick<RoutineStoreApi, 'list' | 'recordRun'>
  /**
   * Is this Bot's Thread streaming? The per-THREAD busy signal (#456): one
   * `vibe-acp` child legitimately hosts concurrent turns across sessions, so the
   * per-agent in-flight count would defer a Routine because an unrelated Thread in
   * the same Workspace happens to be mid-turn.
   */
  isStreaming(threadId: string): boolean
  /** Run one Routine's turn — `runRoutineNow`, the single entry point of slice 2. */
  runRoutine(routineId: string, options: RunRoutineOptions): Promise<RoutineTurnResult>
  now(): number
}

export interface RoutineScheduler {
  /** Begin ticking. Idempotent. */
  start(): void
  /** Stop ticking, so no timer outlives the app. Idempotent. */
  stop(): void
  /**
   * The launch catch-up: run whatever is owed, ONCE each. Independent of the tick
   * — it needs nothing but the rows and a clock, and it would still answer if the
   * tick never ran at all.
   */
  catchUp(): MissedRun[]
  /** One tick. Resolves when the runs it started have settled (the tests' seam). */
  tick(): Promise<void>
}

export function createRoutineScheduler(deps: RoutineSchedulerDeps): RoutineScheduler {
  /** Due runs waiting for a busy Bot. In memory only — a deferral is about this minute. */
  let deferrals: PendingDeferral[] = []
  /** Routines whose turn is in flight: their `lastRunAt` has not moved yet. */
  const running = new Set<string>()
  /** The Threads those runs hold, so a sibling Routine defers instead of racing the claim. */
  const runningThreads = new Set<string>()
  /**
   * Baseline floors for Routines RESUMED in this session (ADR-0028 part 7: no
   * catch-up for a paused period). Held in memory rather than written to the row,
   * because the alternative — reading a column that any write touches — would let
   * an unrelated edit SUPPRESS a missed-run report, and silence is the one failure
   * this design refuses. The cost of keeping it in memory is at most one extra
   * late run after a resume that spans a restart.
   */
  const floors = new Map<string, number>()
  /** Each Routine's `active` as of the previous tick, to spot the resume. */
  const wasActive = new Map<string, boolean>()
  let timer: ReturnType<typeof setInterval> | null = null

  /**
   * Put a slot back in the deferral queue after the RUN itself refused it.
   *
   * The scheduler decides busy-ness a moment before `runRoutineTurn` takes its
   * atomic claim, so a user who starts typing inside that window wins the Bot and
   * the run comes back `deferred`. Re-queuing is what keeps ADR-0028's "re-check on
   * the next tick" true for that race: the slot keeps its own bound and is retried
   * until its next slot arrives, instead of being lost because the losing run
   * already stamped the record.
   */
  const requeue = (run: RoutineFire): void => {
    const routine = deps.routines.list().find((candidate) => candidate.id === run.routineId)
    if (!routine || !routine.active) return
    if (deferrals.some((pending) => pending.routineId === run.routineId)) return
    deferrals.push({
      routineId: run.routineId,
      threadId: run.threadId,
      dueAt: run.dueAt,
      expiresAt: nextRunAfter(routine.schedule, run.dueAt) ?? run.dueAt,
      lastRunAt: run.lastRunAt,
    })
  }

  const startRun = (run: RoutineFire): Promise<void> => {
    running.add(run.routineId)
    runningThreads.add(run.threadId)
    return deps
      .runRoutine(run.routineId, lateOf(run))
      .then((result) => {
        // The Bot was taken between the decision and the claim — see `requeue`.
        if (result.outcome === 'deferred') requeue(run)
      })
      .catch((err: unknown) => {
        // `runRoutineTurn` answers with an outcome rather than rejecting; this is
        // the belt to that pair of braces, because a rejection here would leave the
        // Routine marked in flight forever and silently stop scheduling it.
        console.error(`[vibe-mistro:routines] run ${run.routineId} rejected: ${String(err)}`)
      })
      .then(() => {
        running.delete(run.routineId)
        runningThreads.delete(run.threadId)
      })
  }

  const tick = async (): Promise<void> => {
    const now = deps.now()
    const routines = deps.routines.list()

    // Spot a resume (paused -> active) and give that Routine a fresh baseline, so
    // resuming after a fortnight does not accrue a fortnight of catch-up. A Routine
    // seen for the first time gets no floor: we do not know when it was resumed,
    // and guessing would suppress a real missed run.
    for (const routine of routines) {
      if (wasActive.get(routine.id) === false && routine.active) floors.set(routine.id, now)
      wasActive.set(routine.id, routine.active)
    }

    const busyThreads = new Set(runningThreads)
    for (const routine of routines) {
      if (deps.isStreaming(routine.threadId)) busyThreads.add(routine.threadId)
    }

    const decision = decideRoutineTick({
      routines,
      now,
      busyThreads,
      runningRoutines: running,
      deferrals,
      floors,
    })
    deferrals = decision.defer

    // A deferral that ran out of time is recorded on the Routine and NOWHERE else
    // (ADR-0028 part 5): a defer is not a failure, and writing it into the
    // conversation would make a Bot chattier the more you use it. The record's
    // `lastRunAt` is the ABANDONED SLOT rather than now — the give-up settles that
    // slot, and stamping `now` (which is the next slot's instant) would swallow the
    // next slot as well.
    for (const expired of decision.report) {
      deps.routines.recordRun(expired.routineId, {
        lastRunAt: expired.dueAt,
        lastOutcome: 'deferred',
        lastError: 'The Bot was busy for this whole slot, so the run was given up.',
      })
    }

    await Promise.all(decision.fire.map(startRun))
  }

  return {
    start(): void {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, ROUTINE_TICK_MS)
      // Never keep the process alive on its own — the idle sweep's precedent.
      timer.unref?.()
    },
    stop(): void {
      if (!timer) return
      clearInterval(timer)
      timer = null
    },
    catchUp(): MissedRun[] {
      const now = deps.now()
      const missed = detectMissedRuns(deps.routines.list(), now)
      const started: MissedRun[] = []
      const claimed = new Set<string>()
      for (const run of missed) {
        // One Bot, one turn — a Bot owed two runs starts the older one here and the
        // tick picks the other up, deferral bound and all. Nothing is remembered
        // about the one left behind: it is still owed, and still recomputed.
        if (claimed.has(run.threadId) || running.has(run.routineId)) continue
        claimed.add(run.threadId)
        started.push(run)
        void startRun(run)
      }
      return started
    },
    tick,
  }
}

/** A fired slot, as the run options the turn needs. */
function lateOf(fire: RoutineFire): RunRoutineOptions {
  return { late: fire.late ? { dueAt: fire.dueAt, lastRunAt: fire.lastRunAt } : null }
}
