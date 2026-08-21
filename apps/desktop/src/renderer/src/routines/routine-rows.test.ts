import { describe, expect, it } from 'vitest'
import type { RoutineRecord } from '../../../shared/ipc'
import type { RoutineSchedule } from '../../../shared/schedule'
import {
  describeInstant,
  describeLastRun,
  describeNextRun,
  describeSchedule,
  routineRow,
  routineRows,
} from './routine-rows'

/**
 * The Routines list's view-model (#471). Every clock is injected, so these are
 * assertions about wording and ordering rather than about what time it is here.
 *
 * The one that matters most is "never run yet": ADR-0028 part 6 exists so that a
 * routine which never fired can never be mistaken for one that fired and found
 * nothing, and this list is where that distinction is either kept or lost.
 */

/** A Wednesday, 08:00 UTC. */
const NOW = Date.UTC(2026, 7, 19, 8, 0)

function schedule(over: Partial<RoutineSchedule> = {}): RoutineSchedule {
  return { kind: 'daily', at: '09:00', timezone: 'UTC', ...over } as RoutineSchedule
}

function routine(over: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: 'r1',
    threadId: 'bot-1',
    name: 'Morning triage',
    prompt: 'Triage the repo.',
    schedule: schedule(),
    allowedCommands: [],
    active: true,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    lastBlockedCommand: null,
    createdAt: NOW - 86_400_000,
    updatedAt: NOW - 86_400_000,
    ...over,
  }
}

describe('describeSchedule', () => {
  it('says each kind in plain words', () => {
    expect(describeSchedule(schedule({ kind: 'daily' }), 'UTC')).toBe('Every day at 09:00')
    expect(describeSchedule(schedule({ kind: 'weekdays' }), 'UTC')).toBe('Weekdays at 09:00')
    expect(describeSchedule({ kind: 'weekly', weekday: 2, at: '17:30', timezone: 'UTC' }, 'UTC')).toBe(
      'Every Tuesday at 17:30',
    )
  })

  it('names the zone only when it is not this machine’s', () => {
    expect(describeSchedule(schedule({ timezone: 'Europe/Berlin' }), 'Europe/Berlin')).toBe(
      'Every day at 09:00',
    )
    expect(describeSchedule(schedule({ timezone: 'Europe/Berlin' }), 'UTC')).toBe(
      'Every day at 09:00 (Europe/Berlin)',
    )
  })
})

describe('describeInstant', () => {
  it('says today, tomorrow and a weekday by CALENDAR day, not by hours away', () => {
    expect(describeInstant(Date.UTC(2026, 7, 19, 9, 0), NOW, 'UTC', 'UTC')).toBe('today at 09:00')
    // 25 hours away, but the next calendar day — "tomorrow" is what a reader means.
    expect(describeInstant(Date.UTC(2026, 7, 20, 9, 0), NOW, 'UTC', 'UTC')).toBe('tomorrow at 09:00')
    expect(describeInstant(Date.UTC(2026, 7, 21, 9, 0), NOW, 'UTC', 'UTC')).toBe('on Friday at 09:00')
  })

  it('falls back to a date past the coming week', () => {
    expect(describeInstant(Date.UTC(2026, 8, 12, 9, 0), NOW, 'UTC', 'UTC')).toBe('on Sep 12 at 09:00')
  })
})

describe('describeNextRun', () => {
  it('is DERIVED from the schedule, never read off the record', () => {
    const daily = schedule()
    expect(describeNextRun(daily, Date.UTC(2026, 7, 19, 9, 0), NOW, 'UTC')).toBe(
      'Next run today at 09:00',
    )
  })

  it('says a schedule it cannot compute is unreadable, rather than showing nothing', () => {
    expect(describeNextRun(schedule({ timezone: 'Mars/Olympus' }), null, NOW, 'UTC')).toMatch(
      /cannot be read/,
    )
  })
})

describe('describeLastRun', () => {
  it('gives a routine that has NEVER run its own sentence', () => {
    expect(describeLastRun(routine(), NOW)).toBe('Never run yet')
  })

  it('names the outcome of a run that did happen', () => {
    const ran = (outcome: RoutineRecord['lastOutcome']): string =>
      describeLastRun(routine({ lastRunAt: NOW - 2 * 60 * 60 * 1000, lastOutcome: outcome }), NOW)
    expect(ran('ok')).toBe('Ran 2h ago')
    expect(ran('failed')).toBe('Failed 2h ago')
    expect(ran('blocked')).toBe('Blocked 2h ago')
    expect(ran('deferred')).toBe('Deferred 2h ago — the Bot was busy')
  })

  it('reads naturally for a run that just happened', () => {
    expect(describeLastRun(routine({ lastRunAt: NOW - 1_000, lastOutcome: 'ok' }), NOW)).toBe(
      'Ran just now',
    )
  })
})

describe('routineRow', () => {
  it('offers the blocked invocation to repair, taken from the structured field', () => {
    const row = routineRow(
      routine({
        lastRunAt: NOW - 3_600_000,
        lastOutcome: 'blocked',
        lastError: 'stopped before running `gh pr list`',
        lastBlockedCommand: 'gh pr list',
      }),
      NOW,
      'UTC',
    )
    expect(row.repairCommand).toBe('gh pr list')
    expect(row.tone).toBe('warn')
    expect(row.lastErrorText).toBe('stopped before running `gh pr list`')
  })

  it('offers no repair for any other outcome, even with a stale command stored', () => {
    const row = routineRow(
      routine({ lastRunAt: NOW, lastOutcome: 'ok', lastBlockedCommand: 'gh pr list' }),
      NOW,
      'UTC',
    )
    expect(row.repairCommand).toBeNull()
    expect(row.lastErrorText).toBeNull()
  })

  it('says a paused routine will not run, and shows no next run for it', () => {
    const row = routineRow(routine({ active: false }), NOW, 'UTC')
    expect(row.paused).toBe(true)
    expect(row.nextRunAt).toBeNull()
    expect(row.nextRunText).toMatch(/Paused/)
  })
})

describe('routineRows ordering', () => {
  it('puts active routines before paused ones, soonest first', () => {
    const rows = routineRows(
      [
        routine({ id: 'paused-early', name: 'Paused', active: false, schedule: schedule({ at: '08:30' }) }),
        routine({ id: 'late', name: 'Evening', schedule: schedule({ at: '18:00' }) }),
        routine({ id: 'soon', name: 'Morning', schedule: schedule({ at: '09:00' }) }),
      ],
      NOW,
      'UTC',
    )
    expect(rows.map((row) => row.routine.id)).toEqual(['soon', 'late', 'paused-early'])
  })

  it('sinks a routine whose schedule cannot be computed — it will never be next', () => {
    const rows = routineRows(
      [
        routine({ id: 'broken', name: 'Broken', schedule: schedule({ timezone: 'Mars/Olympus' }) }),
        routine({ id: 'fine', name: 'Fine' }),
      ],
      NOW,
      'UTC',
    )
    expect(rows.map((row) => row.routine.id)).toEqual(['fine', 'broken'])
  })

  it('breaks a tie by name, so the order does not wander between renders', () => {
    const rows = routineRows(
      [routine({ id: 'b', name: 'Beta' }), routine({ id: 'a', name: 'Alpha' })],
      NOW,
      'UTC',
    )
    expect(rows.map((row) => row.routine.id)).toEqual(['a', 'b'])
  })
})
