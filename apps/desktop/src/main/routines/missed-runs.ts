import type { RoutineRecord } from '../../shared/ipc'
import { expectedLastDue } from '../../shared/schedule'

/**
 * **The missed-run detector** (#470, ADR-0028 part 6) — the arithmetic that
 * answers *should this Routine have run by now, and did it?* from the stored
 * schedule alone.
 *
 * This module SHARES NO CODE WITH THE FIRING PATH, and that is its whole point.
 * It reads no flag the firer was supposed to set, because the case worth catching
 * is exactly the one where **no code ran at all**: the app was never open, a bug
 * ate the timer, the fire path threw before it reached the store. A flag nobody
 * set is indistinguishable from a flag nobody needed to set — the mistake this
 * codebase has now made three times (#427, #433, the persona-loss case), where the
 * component that broke was also the one responsible for reporting that it broke.
 *
 * What it DOES share with the firer is `shared/schedule`'s pure arithmetic, and it
 * must: the two have to agree about which instants are fire instants, which slice
 * 1 proved with a round-trip property test. Sharing arithmetic is required.
 * Sharing responsibility for self-report is the anti-pattern.
 *
 * The comparison, in one line: `expectedLastDue(schedule, now) > baseline` means a
 * run is owed. Everything below is what "baseline" means and how "late" is decided.
 */

/**
 * How far past its slot a run may start before it counts as **late**.
 *
 * A run that starts a few seconds after its slot is simply the tick doing its
 * job; one that starts hours later happened because the app was shut, or because
 * the Bot was busy through the whole window. Only the second is worth telling
 * anyone about, in the conversation or in the prompt — so the threshold is
 * comfortably wider than the tick interval and far narrower than any schedule.
 */
export const LATE_AFTER_MS = 5 * 60 * 1000

/** A run this Routine is owed: the slot it is for, and whether it is late. */
export interface ExpectedRun {
  /** The scheduled instant this run belongs to — never `now`. */
  dueAt: number
  /** True when `now` is more than {@link LATE_AFTER_MS} past `dueAt`. */
  late: boolean
}

/** A Routine that is owed a run at launch, with the two timestamps the notice states. */
export interface MissedRun extends ExpectedRun {
  routineId: string
  /** The Bot's Thread — a Bot IS one continuing Thread, so this is the whole address. */
  threadId: string
  /**
   * When this Routine last ran, or **null when it has never run at all**.
   *
   * Carried, rather than derived later, because it is the difference the whole
   * slice exists for: a Routine that never ran must never look like one that ran
   * and found nothing. Null reaches the conversation notice as its own sentence.
   */
  lastRunAt: number | null
}

/**
 * The instant a Routine is measured FROM — the far side of the comparison.
 *
 * `lastRunAt` when it has ever run, and `createdAt` when it has not. The
 * `createdAt` floor is not a convenience: without it, a Routine created at 10:00
 * with a 09:00 daily schedule would be "owed" 09:00 the moment it was saved, and
 * would fire immediately instead of tomorrow — a Routine whose first run happens
 * before its first slot.
 *
 * `floor` is the caller's in-memory baseline, used for exactly one thing: a
 * Routine RESUMED in this session (ADR-0028 part 7 — resuming sets a fresh
 * baseline, so a fortnight of pause does not accrue catch-up). It is deliberately
 * not persisted and deliberately not `updatedAt`: reading a column that any write
 * touches would let an unrelated edit SUPPRESS a missed-run report, which is the
 * failure direction this module exists to make impossible. Erring the other way
 * costs one extra late run.
 */
export function routineBaseline(routine: RoutineRecord, floor?: number): number {
  const own = routine.lastRunAt ?? routine.createdAt
  return floor === undefined ? own : Math.max(own, floor)
}

/**
 * The run this Routine is owed at `now`, or null when it is owed none.
 *
 * Null for a **paused** Routine (pausing decides what the scheduler considers
 * due — `runRoutineTurn` deliberately does not ask, so the skip belongs here),
 * for a schedule the arithmetic cannot compute with (a zone this ICU no longer
 * knows, a malformed time — the Routine stays listable, editable and inert), and
 * for one whose last due instant is already covered by its baseline.
 *
 * Used by BOTH the launch catch-up and every tick, on purpose: the question is the
 * same question, so asking it in one place is what keeps the two answers equal.
 * Neither caller stores the answer.
 */
export function expectedRun(
  routine: RoutineRecord,
  now: number,
  floor?: number,
): ExpectedRun | null {
  if (!routine.active) return null
  const dueAt = expectedLastDue(routine.schedule, now)
  if (dueAt === null) return null
  if (dueAt <= routineBaseline(routine, floor)) return null
  return { dueAt, late: now - dueAt > LATE_AFTER_MS }
}

/**
 * Every Routine owed a run at `now` — **the launch catch-up** (ADR-0028 part 3).
 *
 * Each answer is ONE run, whatever the reason and however many slots went by:
 * nobody wants Tuesday's triage on Thursday. Ordered by slot so a Bot owed two
 * runs starts with the older one.
 *
 * Independent of the tick by construction — it needs nothing but the rows and a
 * clock, so it answers at launch, before the first tick, and would still answer if
 * the tick never ran at all.
 */
export function detectMissedRuns(routines: readonly RoutineRecord[], now: number): MissedRun[] {
  const missed: MissedRun[] = []
  for (const routine of routines) {
    const run = expectedRun(routine, now)
    if (!run) continue
    missed.push({
      routineId: routine.id,
      threadId: routine.threadId,
      lastRunAt: routine.lastRunAt,
      ...run,
    })
  }
  return missed.sort((a, b) => a.dueAt - b.dueAt)
}
