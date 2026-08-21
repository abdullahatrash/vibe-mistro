import { describe, expect, it } from 'vitest'
import type { RoutineRecord } from '../../shared/ipc'
import { decideRoutineTick, type PendingDeferral } from './schedule-tick'

/**
 * One tick of the scheduler, decided purely (#470, ADR-0028) — collisions, the
 * deferral bound and catch-up as unit tests rather than timing tests.
 *
 * Berlin is UTC+2 in August, so the 09:00 slots below are written as 07:00 UTC.
 */

const SLOT_20 = Date.UTC(2026, 7, 20, 7, 0)
const SLOT_21 = Date.UTC(2026, 7, 21, 7, 0)
const SLOT_22 = Date.UTC(2026, 7, 22, 7, 0)
/** A minute past the 21st's slot: due, and not yet late. */
const JUST_AFTER_21 = SLOT_21 + 60_000

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

/** A tick with nothing busy, nothing running and nothing deferred. */
function tick(
  routines: RoutineRecord[],
  now: number,
  over: Partial<Parameters<typeof decideRoutineTick>[0]> = {},
) {
  return decideRoutineTick({
    routines,
    now,
    busyThreads: new Set(),
    runningRoutines: new Set(),
    deferrals: [],
    ...over,
  })
}

describe('decideRoutineTick — firing', () => {
  it('fires a Routine whose slot has come, for the SLOT rather than for now', () => {
    const decision = tick([routine()], JUST_AFTER_21)
    expect(decision.fire).toEqual([
      { routineId: 'r1', threadId: 'bot-1', dueAt: SLOT_21, late: false, lastRunAt: SLOT_20 },
    ])
    expect(decision.defer).toEqual([])
    expect(decision.report).toEqual([])
  })

  it('fires nothing before the slot', () => {
    expect(tick([routine()], SLOT_21 - 60_000).fire).toEqual([])
  })

  it('skips a PAUSED Routine, however overdue it is', () => {
    const paused = routine({ active: false, lastRunAt: SLOT_20 })
    const decision = tick([paused], Date.UTC(2026, 7, 25, 12, 0))
    expect(decision).toEqual({ fire: [], defer: [], report: [] })
  })

  it('fires into a Bot whose Workspace is NOT connected — a Routine warms it', () => {
    // Nothing about the pool reaches this decision: an unconnected Workspace has
    // no streaming Thread, so it is not busy, and the run itself lazily warms the
    // agent. Refusing here would mean a Routine only ever ran for Workspaces you
    // had already opened, which is the opposite of the point.
    const decision = tick([routine({ threadId: 'bot-cold' })], JUST_AFTER_21)
    expect(decision.fire.map((fire) => fire.threadId)).toEqual(['bot-cold'])
  })

  it('leaves a Routine whose run is still in flight alone', () => {
    const decision = tick([routine()], JUST_AFTER_21, { runningRoutines: new Set(['r1']) })
    expect(decision).toEqual({ fire: [], defer: [], report: [] })
  })

  it('honours a resume floor: a Routine resumed after its slot waits for the next one', () => {
    const decision = tick([routine()], JUST_AFTER_21, {
      floors: new Map([['r1', JUST_AFTER_21 - 1_000]]),
    })
    expect(decision.fire).toEqual([])
  })
})

describe('decideRoutineTick — two Routines on one Bot', () => {
  const early = routine({
    id: 'early',
    schedule: { kind: 'daily', at: '08:00', timezone: 'Europe/Berlin' },
  })
  const late = routine({ id: 'late' })

  it('fires the older slot and defers the other — a Bot is one conversation', () => {
    const decision = tick([late, early], JUST_AFTER_21)

    expect(decision.fire.map((fire) => fire.routineId)).toEqual(['early'])
    expect(decision.defer).toEqual([
      {
        routineId: 'late',
        threadId: 'bot-1',
        dueAt: SLOT_21,
        // Bounded by this Routine's OWN next slot, never by the other's.
        expiresAt: SLOT_22,
        lastRunAt: SLOT_20,
      },
    ])
    expect(decision.report).toEqual([])
  })

  it('defers a due Routine while its Bot is streaming, writing nothing anywhere', () => {
    const decision = tick([late], JUST_AFTER_21, { busyThreads: new Set(['bot-1']) })
    expect(decision.fire).toEqual([])
    expect(decision.defer).toHaveLength(1)
    expect(decision.report).toEqual([])
  })
})

describe('decideRoutineTick — deferrals', () => {
  const pending: PendingDeferral = {
    routineId: 'r1',
    threadId: 'bot-1',
    dueAt: SLOT_21,
    expiresAt: SLOT_22,
    lastRunAt: SLOT_20,
  }

  it('re-checks on the next tick and fires once the Bot is free', () => {
    const decision = tick([routine()], JUST_AFTER_21 + 60_000, { deferrals: [pending] })
    expect(decision.fire).toEqual([
      { routineId: 'r1', threadId: 'bot-1', dueAt: SLOT_21, late: false, lastRunAt: SLOT_20 },
    ])
    expect(decision.defer).toEqual([])
  })

  it('keeps waiting while the Bot is still busy', () => {
    const decision = tick([routine()], JUST_AFTER_21 + 60_000, {
      deferrals: [pending],
      busyThreads: new Set(['bot-1']),
    })
    expect(decision.fire).toEqual([])
    expect(decision.defer).toEqual([pending])
  })

  it('marks a run that finally got its turn hours later as LATE', () => {
    const decision = tick([routine()], SLOT_21 + 4 * 60 * 60 * 1000, { deferrals: [pending] })
    expect(decision.fire[0]?.late).toBe(true)
  })

  it('gives up at the next slot: records `deferred`, and the new slot competes fresh', () => {
    // The bound expires at exactly SLOT_22, which is also when the next slot is
    // due. The abandoned slot is reported and the new one is fired in the SAME
    // tick — a Routine must not lose a slot to its own backlog.
    const decision = tick([routine()], SLOT_22, { deferrals: [pending] })

    expect(decision.report).toEqual([{ routineId: 'r1', dueAt: SLOT_21 }])
    expect(decision.fire).toEqual([
      { routineId: 'r1', threadId: 'bot-1', dueAt: SLOT_22, late: false, lastRunAt: SLOT_20 },
    ])
    expect(decision.defer).toEqual([])
  })

  it('drops a deferral whose Routine was paused or deleted, recording nothing', () => {
    expect(tick([routine({ active: false })], SLOT_22, { deferrals: [pending] })).toEqual({
      fire: [],
      defer: [],
      report: [],
    })
    expect(tick([], SLOT_22, { deferrals: [pending] })).toEqual({ fire: [], defer: [], report: [] })
  })

  it('lets a carried deferral win the Bot over a sibling that only just came due', () => {
    const sibling = routine({ id: 'sibling' })
    const decision = tick([sibling, routine()], SLOT_21 + 30 * 60_000, { deferrals: [pending] })
    expect(decision.fire.map((fire) => fire.routineId)).toEqual(['r1'])
    expect(decision.defer.map((entry) => entry.routineId)).toEqual(['sibling'])
  })
})
