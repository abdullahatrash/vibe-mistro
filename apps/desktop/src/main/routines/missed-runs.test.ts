import { describe, expect, it } from 'vitest'
import type { RoutineRecord } from '../../shared/ipc'
import { LATE_AFTER_MS, detectMissedRuns, expectedRun, routineBaseline } from './missed-runs'

/**
 * The missed-run detector (#470, ADR-0028 part 6) — the comparison that answers
 * *should this have run by now, and did it?* from the stored schedule alone.
 *
 * The last test in this file is the one the whole slice exists for: a Routine that
 * NEVER ran must not look like one that ran and found nothing.
 *
 * Instants are written as UTC so they can be read at a glance; Berlin is UTC+2 in
 * August, so 07:00 UTC is the 09:00 slot the Routine was given.
 */

/** The 09:00 Europe/Berlin slot on 21 August 2026. */
const SLOT_21 = Date.UTC(2026, 7, 21, 7, 0)
/** The same slot the day before. */
const SLOT_20 = Date.UTC(2026, 7, 20, 7, 0)
/** Well after the 21st's slot — the app was shut when it came due. */
const NOON_21 = Date.UTC(2026, 7, 21, 10, 0)

function routine(over: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: 'r1',
    threadId: 'bot-1',
    name: 'Morning triage',
    prompt: 'Triage this repo and say what changed.',
    schedule: { kind: 'daily', at: '09:00', timezone: 'Europe/Berlin' },
    allowedCommands: [],
    active: true,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    lastBlockedCommand: null,
    createdAt: Date.UTC(2026, 7, 19, 12, 0),
    updatedAt: Date.UTC(2026, 7, 19, 12, 0),
    ...over,
  }
}

describe('routineBaseline', () => {
  it('is the last run when there was one', () => {
    expect(routineBaseline(routine({ lastRunAt: SLOT_20 }))).toBe(SLOT_20)
  })

  it('falls back to creation, so a new Routine never fires before its first slot', () => {
    // Created at 10:00 on the 21st, an hour AFTER that day's 09:00 slot. Without
    // the floor the Routine would be "owed" a run the moment it was saved.
    const created = Date.UTC(2026, 7, 21, 8, 0)
    expect(routineBaseline(routine({ createdAt: created }))).toBe(created)
    expect(expectedRun(routine({ createdAt: created }), NOON_21)).toBeNull()
  })

  it('takes the caller floor when it is later — a Routine resumed this session', () => {
    expect(routineBaseline(routine({ lastRunAt: SLOT_20 }), NOON_21)).toBe(NOON_21)
  })
})

describe('expectedRun', () => {
  it('answers the slot a Routine that ran yesterday is owed today', () => {
    expect(expectedRun(routine({ lastRunAt: SLOT_20 }), NOON_21)).toEqual({
      dueAt: SLOT_21,
      late: true,
    })
  })

  it('is null once that slot has been run', () => {
    expect(expectedRun(routine({ lastRunAt: SLOT_21 }), NOON_21)).toBeNull()
  })

  it('is not late while the run starts within the grace window', () => {
    const justAfter = SLOT_21 + LATE_AFTER_MS - 1
    expect(expectedRun(routine({ lastRunAt: SLOT_20 }), justAfter)?.late).toBe(false)
    expect(expectedRun(routine({ lastRunAt: SLOT_20 }), SLOT_21 + LATE_AFTER_MS + 1)?.late).toBe(true)
  })

  it('skips a PAUSED Routine — pausing decides what the scheduler considers due', () => {
    expect(expectedRun(routine({ lastRunAt: SLOT_20, active: false }), NOON_21)).toBeNull()
  })

  it('skips a Routine whose schedule cannot be computed, leaving it inert not thrown', () => {
    const broken = routine({
      lastRunAt: SLOT_20,
      schedule: { kind: 'daily', at: '09:00', timezone: 'Mars/Olympus' },
    })
    expect(expectedRun(broken, NOON_21)).toBeNull()
  })

  it('honours a resume floor, so a paused fortnight accrues no catch-up', () => {
    const resumed = routine({ lastRunAt: Date.UTC(2026, 7, 7, 7, 0) })
    expect(expectedRun(resumed, NOON_21)).not.toBeNull()
    expect(expectedRun(resumed, NOON_21, Date.UTC(2026, 7, 21, 9, 0))).toBeNull()
  })
})

describe('detectMissedRuns — the launch catch-up', () => {
  it('owes ONE run however many slots went by: nobody wants Tuesday triage on Thursday', () => {
    // Last ran a fortnight ago. Fourteen slots have passed; exactly one run is owed.
    const stale = routine({ lastRunAt: Date.UTC(2026, 7, 7, 7, 0) })
    const missed = detectMissedRuns([stale], NOON_21)
    expect(missed).toHaveLength(1)
    expect(missed[0]).toEqual({
      routineId: 'r1',
      threadId: 'bot-1',
      lastRunAt: Date.UTC(2026, 7, 7, 7, 0),
      dueAt: SLOT_21,
      late: true,
    })
  })

  it('orders by slot, so a Bot owed two runs starts with the older one', () => {
    const early = routine({
      id: 'early',
      threadId: 'bot-2',
      schedule: { kind: 'daily', at: '07:00', timezone: 'Europe/Berlin' },
      lastRunAt: SLOT_20,
    })
    const later = routine({ id: 'later', lastRunAt: SLOT_20 })
    expect(detectMissedRuns([later, early], NOON_21).map((run) => run.routineId)).toEqual([
      'early',
      'later',
    ])
  })

  it('distinguishes a Routine that NEVER ran from one that ran and found nothing', () => {
    // The story this slice exists for. Both Bots show an empty report; only one of
    // them actually reported. `never` has no `lastRunAt` at all, so the detector
    // owes it a run and the notice it carries says so in its own sentence — while
    // `ran` is owed nothing, because it ran, and "nothing to say" is what it said.
    const never = routine({ id: 'never', threadId: 'bot-never', lastRunAt: null })
    const ran = routine({
      id: 'ran',
      threadId: 'bot-ran',
      lastRunAt: SLOT_21,
      lastOutcome: 'ok',
      lastError: null,
    })

    const missed = detectMissedRuns([never, ran], NOON_21)

    expect(missed.map((run) => run.routineId)).toEqual(['never'])
    expect(missed[0]?.lastRunAt).toBeNull()
  })

  it('needs nothing but the rows and a clock — no flag the firer was meant to set', () => {
    // The point of ADR-0028 part 6, as a test: a Routine whose fire path threw
    // before it reached the store looks EXACTLY like one nothing ever tried to run,
    // and both are detected. Neither wrote an outcome; neither had to.
    const threwBeforeRecording = routine({ id: 'threw', lastRunAt: SLOT_20, lastOutcome: null })
    const nothingEverRan = routine({ id: 'never-tried', threadId: 'bot-2', lastRunAt: SLOT_20 })
    expect(detectMissedRuns([threwBeforeRecording, nothingEverRan], NOON_21)).toHaveLength(2)
  })
})
