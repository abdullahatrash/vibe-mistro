import { describe, expect, it } from 'vitest'
import type { RoutineRecord } from '../../shared/ipc'
import type { RoutineRunResult } from '../persistence/routine-store-api'
import { createRoutineScheduler } from './scheduler'
import type { RunRoutineOptions } from './run-routine-turn'

/**
 * The scheduler itself (#470, ADR-0028): the tick, the launch catch-up, and the
 * two writes a deferral is allowed to make (one on the Routine, none in the
 * conversation).
 *
 * Everything it decides is decided by the pure modules beside it, so this suite is
 * about the wiring: what actually gets RUN, exactly once, and what gets RECORDED.
 *
 * Berlin is UTC+2 in August, so the 09:00 slots are written as 07:00 UTC.
 */

const SLOT_20 = Date.UTC(2026, 7, 20, 7, 0)
const SLOT_21 = Date.UTC(2026, 7, 21, 7, 0)
const SLOT_22 = Date.UTC(2026, 7, 22, 7, 0)
/** Noon Berlin on the 21st: this morning's slot went by with the app shut. */
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
    lastRunAt: SLOT_20,
    lastOutcome: 'ok',
    lastError: null,
    lastBlockedCommand: null,
    createdAt: Date.UTC(2026, 7, 1, 12, 0),
    updatedAt: Date.UTC(2026, 7, 1, 12, 0),
    ...over,
  }
}

interface Harness {
  scheduler: ReturnType<typeof createRoutineScheduler>
  runs: { routineId: string; options: RunRoutineOptions }[]
  recorded: { routineId: string; result: RoutineRunResult }[]
  rows: RoutineRecord[]
  streaming: Set<string>
  setNow(instant: number): void
  /** Let the in-flight run settle. */
  settle(): Promise<void>
}

function harness(
  rows: RoutineRecord[],
  now: number,
  options: { hold?: boolean; loseRace?: Set<number> } = {},
): Harness {
  const runs: { routineId: string; options: RunRoutineOptions }[] = []
  const recorded: { routineId: string; result: RoutineRunResult }[] = []
  const streaming = new Set<string>()
  let clock = now
  let release: (() => void) | null = null
  const scheduler = createRoutineScheduler({
    routines: {
      list: () => rows,
      recordRun: (routineId, result) => {
        recorded.push({ routineId, result })
        const row = rows.find((candidate) => candidate.id === routineId)
        if (row) Object.assign(row, result)
        return row ?? null
      },
    },
    isStreaming: (threadId) => streaming.has(threadId),
    runRoutine: async (routineId, runOptions) => {
      runs.push({ routineId, options: runOptions })
      // The user won the Bot between the decision and the claim (#468's atomic
      // `tryBeginTurn`), so the run itself refuses.
      if (options.loseRace?.has(runs.length)) return { outcome: 'deferred', error: 'busy' }
      // `hold` keeps the turn in flight, which is what makes a Routine BUSY for the
      // next tick — the state a real turn spends most of its life in.
      if (options.hold) await new Promise<void>((resolve) => (release = resolve))
      return { outcome: 'ok', error: null }
    },
    now: () => clock,
  })
  return {
    scheduler,
    runs,
    recorded,
    rows,
    streaming,
    setNow: (instant) => void (clock = instant),
    settle: async () => {
      release?.()
      release = null
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('the launch catch-up', () => {
  it('runs a missed Routine EXACTLY ONCE and marks it late', async () => {
    const h = harness([routine({ lastRunAt: SLOT_20 })], NOON_21)

    const started = h.scheduler.catchUp()
    // The tick runs 30 seconds later and must not run it a second time: the turn
    // is still in flight, so no outcome has been written yet.
    await h.scheduler.tick()

    expect(started.map((run) => run.routineId)).toEqual(['r1'])
    expect(h.runs).toEqual([
      { routineId: 'r1', options: { late: { dueAt: SLOT_21, lastRunAt: SLOT_20 } } },
    ])
  })

  it('does not run again once the run has recorded its outcome', async () => {
    const h = harness([routine({ lastRunAt: SLOT_20 })], NOON_21)
    h.scheduler.catchUp()
    await h.settle()
    // What the real turn writes at the end of its run.
    h.rows[0]!.lastRunAt = NOON_21
    h.setNow(NOON_21 + 60_000)

    await h.scheduler.tick()

    expect(h.runs).toHaveLength(1)
  })

  it('runs the Routine that never ran, and hands the agent a null last-run', () => {
    // The story: a Bot with nothing in its conversation because the app was never
    // open at 09:00, next to one that ran and had nothing to say. Only the first is
    // owed a run, and the run it gets says outright that there was no previous one.
    const never = routine({ id: 'never', threadId: 'bot-never', lastRunAt: null })
    const ranAndFoundNothing = routine({ id: 'ran', threadId: 'bot-ran', lastRunAt: SLOT_21 })
    const h = harness([never, ranAndFoundNothing], NOON_21)

    h.scheduler.catchUp()

    expect(h.runs).toEqual([
      { routineId: 'never', options: { late: { dueAt: SLOT_21, lastRunAt: null } } },
    ])
  })

  it('starts one run per Bot, leaving the collision for the tick to re-decide', () => {
    const first = routine({ id: 'first' })
    const second = routine({
      id: 'second',
      schedule: { kind: 'daily', at: '10:00', timezone: 'Europe/Berlin' },
    })
    const h = harness([first, second], NOON_21)

    expect(h.scheduler.catchUp().map((run) => run.routineId)).toEqual(['first'])
  })
})

describe('the tick', () => {
  it('fires a Routine as its slot arrives, with no late marker', async () => {
    const h = harness([routine()], SLOT_21 + 15_000)
    await h.scheduler.tick()
    expect(h.runs).toEqual([{ routineId: 'r1', options: { late: null } }])
  })

  it('defers while the Bot is streaming and writes NOTHING anywhere', async () => {
    const h = harness([routine()], SLOT_21 + 15_000)
    h.streaming.add('bot-1')

    await h.scheduler.tick()

    expect(h.runs).toEqual([])
    expect(h.recorded).toEqual([])
  })

  it('runs the deferred slot on a later tick, once the Bot is free', async () => {
    const h = harness([routine()], SLOT_21 + 15_000)
    h.streaming.add('bot-1')
    await h.scheduler.tick()

    h.streaming.delete('bot-1')
    h.setNow(SLOT_21 + 45_000)
    await h.scheduler.tick()

    expect(h.runs).toEqual([
      { routineId: 'r1', options: { late: null } },
    ])
    expect(h.recorded).toEqual([])
  })

  it('gives up at the next slot, recording `deferred` against the ABANDONED slot', async () => {
    const h = harness([routine()], SLOT_21 + 15_000)
    h.streaming.add('bot-1')
    await h.scheduler.tick()

    // A full day of talking to this Bot later: the 21st's slot is given up, and the
    // 22nd's is deferred in its place rather than being swallowed by the give-up.
    h.setNow(SLOT_22)
    await h.scheduler.tick()

    expect(h.recorded).toEqual([
      {
        routineId: 'r1',
        result: {
          // The slot that was abandoned — NOT `now`, which is the next slot and
          // would make the detector think the next run had already happened.
          lastRunAt: SLOT_21,
          lastOutcome: 'deferred',
          lastError: 'The Bot was busy for this whole slot, so the run was given up.',
        },
      },
    ])
    expect(h.runs).toEqual([])
  })

  it('does not start a second run on a Bot whose Routine is still running', async () => {
    const sibling = routine({
      id: 'sibling',
      schedule: { kind: 'daily', at: '09:05', timezone: 'Europe/Berlin' },
      lastRunAt: SLOT_20 + 5 * 60_000, // it ran at its own slot yesterday
    })
    const h = harness([routine(), sibling], SLOT_21 + 15_000, { hold: true })

    // Tick one fires the 09:00 Routine and the turn stays in flight.
    const firstTick = h.scheduler.tick()
    expect(h.runs.map((run) => run.routineId)).toEqual(['r1'])

    // Tick two: the 09:05 sibling is now due, but its Bot is mid-turn — and the
    // Bot's streaming flag has not been consulted at all, because the scheduler
    // knows it started that run itself.
    h.setNow(SLOT_21 + 6 * 60_000)
    const secondTick = h.scheduler.tick()
    expect(h.runs.map((run) => run.routineId)).toEqual(['r1'])
    expect(h.recorded).toEqual([])

    await h.settle()
    await Promise.all([firstTick, secondTick])
  })

  it('gives a Routine resumed in this session a fresh baseline', async () => {
    const paused = routine({ active: false })
    const h = harness([paused], NOON_21)

    await h.scheduler.tick() // seen paused: nothing is due, nothing is owed
    paused.active = true
    await h.scheduler.tick() // resumed: this morning's slot belongs to the paused period

    expect(h.runs).toEqual([])
  })

  it('still owes a run to a Routine it has never seen paused', async () => {
    const h = harness([routine({ lastRunAt: SLOT_20 })], NOON_21)
    await h.scheduler.tick()
    expect(h.runs.map((run) => run.routineId)).toEqual(['r1'])
  })
})

describe('a run that loses the claim race', () => {
  it('goes back in the queue and is retried on the next tick, not lost for the day', async () => {
    // The scheduler decided the Bot was free; a person started typing before the
    // run took its claim. Without the re-queue the slot would be gone, because the
    // refused run has already stamped the record.
    const h = harness([routine()], SLOT_21 + 15_000, { loseRace: new Set([1]) })

    await h.scheduler.tick()
    expect(h.runs).toHaveLength(1)

    h.setNow(SLOT_21 + 45_000)
    await h.scheduler.tick()

    expect(h.runs.map((run) => run.routineId)).toEqual(['r1', 'r1'])
    // Still the ORIGINAL slot, so the report covers the period it was meant to.
    expect(h.runs[1]?.options).toEqual({ late: null })
    expect(h.recorded).toEqual([])
  })
})

describe('the timer', () => {
  it('starts and stops idempotently, so no tick outlives the app', () => {
    const h = harness([], NOON_21)
    h.scheduler.start()
    h.scheduler.start()
    h.scheduler.stop()
    h.scheduler.stop()
    expect(h.runs).toEqual([])
  })
})
