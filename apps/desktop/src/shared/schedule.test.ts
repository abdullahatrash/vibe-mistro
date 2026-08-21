import { describe, it, expect } from 'vitest'
import {
  expectedLastDue,
  isRoutineSchedule,
  isSupportedTimezone,
  machineTimezone,
  nextRunAfter,
  parseTimeOfDay,
  type RoutineSchedule,
} from './schedule'

/**
 * The load-bearing suite of the Routines slice (#467, ADR-0028 parts 2 and 6).
 *
 * The firer asks `nextRunAfter`; the detector asks `expectedLastDue`, and the two
 * share no code anywhere ABOVE this module — which is only safe if they agree
 * about time. "They agree" is the round-trip property at the bottom of this file,
 * and everything downstream of this slice assumes it.
 *
 * Instants are written as UTC ISO strings so the wall clock a rule is about and
 * the instant it resolves to are both visible in the assertion.
 */

const at = (iso: string) => Date.parse(iso)
const iso = (instant: number | null) => (instant === null ? null : new Date(instant).toISOString())

const NY = 'America/New_York'
const BERLIN = 'Europe/Berlin'
const SYDNEY = 'Australia/Sydney'

describe('parseTimeOfDay', () => {
  it('accepts a zero-padded 24-hour wall clock', () => {
    expect(parseTimeOfDay('00:00')).toEqual({ hours: 0, minutes: 0 })
    expect(parseTimeOfDay('09:05')).toEqual({ hours: 9, minutes: 5 })
    expect(parseTimeOfDay('23:59')).toEqual({ hours: 23, minutes: 59 })
  })

  it('refuses everything else — a malformed time must never become a guessed one', () => {
    for (const bad of ['', '9:05', '24:00', '23:60', '09:5', '0905', 'noon', '09:05:00', '-1:00']) {
      expect(parseTimeOfDay(bad)).toBeNull()
    }
  })
})

describe('isSupportedTimezone', () => {
  it('accepts IANA names Intl knows, and refuses the rest', () => {
    expect(isSupportedTimezone('UTC')).toBe(true)
    expect(isSupportedTimezone(NY)).toBe(true)
    expect(isSupportedTimezone(SYDNEY)).toBe(true)
    expect(isSupportedTimezone('Mars/Olympus_Mons')).toBe(false)
    expect(isSupportedTimezone('')).toBe(false)
  })

  it('reports the machine zone as usable — it is what a new Routine defaults to', () => {
    expect(isSupportedTimezone(machineTimezone())).toBe(true)
  })
})

describe('isRoutineSchedule — the guard stored rows are read through', () => {
  it('accepts each kind, and weekly only with a weekday', () => {
    expect(isRoutineSchedule({ kind: 'daily', at: '09:00', timezone: 'UTC' })).toBe(true)
    expect(isRoutineSchedule({ kind: 'weekdays', at: '23:59', timezone: NY })).toBe(true)
    expect(isRoutineSchedule({ kind: 'weekly', at: '09:00', weekday: 0, timezone: NY })).toBe(true)
    expect(isRoutineSchedule({ kind: 'weekly', at: '09:00', timezone: NY })).toBe(false)
    expect(isRoutineSchedule({ kind: 'weekly', at: '09:00', weekday: 7, timezone: NY })).toBe(false)
  })

  it('refuses an unknown kind, a malformed time and a missing zone', () => {
    expect(isRoutineSchedule({ kind: 'cron', at: '09:00', timezone: 'UTC' })).toBe(false)
    expect(isRoutineSchedule({ kind: 'daily', at: '9:00', timezone: 'UTC' })).toBe(false)
    expect(isRoutineSchedule({ kind: 'daily', at: '09:00', timezone: '' })).toBe(false)
    expect(isRoutineSchedule(null)).toBe(false)
    expect(isRoutineSchedule('daily')).toBe(false)
  })

  it('does NOT ask Intl about the zone — an unknown zone stays readable and editable', () => {
    // Structure only: the row must list, so the user can fix or delete it. The
    // schedule simply computes no next run until then.
    const schedule = { kind: 'daily', at: '09:00', timezone: 'Mars/Olympus_Mons' }
    expect(isRoutineSchedule(schedule)).toBe(true)
    expect(nextRunAfter(schedule as RoutineSchedule, 0)).toBeNull()
  })
})

describe('nextRunAfter across the three kinds', () => {
  it('fires daily at the local wall clock', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '09:00', timezone: NY }
    // 2026-06-15 is a Monday; NY is on EDT (-04:00) in June.
    expect(iso(nextRunAfter(schedule, at('2026-06-15T08:00:00Z')))).toBe('2026-06-15T13:00:00.000Z')
    // Past today's slot, so tomorrow's.
    expect(iso(nextRunAfter(schedule, at('2026-06-15T14:00:00Z')))).toBe('2026-06-16T13:00:00.000Z')
  })

  it('fires on weekdays only, skipping the weekend in the schedule’s OWN zone', () => {
    const schedule: RoutineSchedule = { kind: 'weekdays', at: '09:00', timezone: NY }
    // Friday 2026-06-19 after the slot -> Monday 2026-06-22, not Saturday.
    expect(iso(nextRunAfter(schedule, at('2026-06-19T14:00:00Z')))).toBe('2026-06-22T13:00:00.000Z')
    // Sunday -> Monday.
    expect(iso(nextRunAfter(schedule, at('2026-06-21T00:00:00Z')))).toBe('2026-06-22T13:00:00.000Z')
  })

  it('fires weekly on its own weekday (0 = Sunday)', () => {
    const friday: RoutineSchedule = { kind: 'weekly', at: '17:00', weekday: 5, timezone: NY }
    // Monday 2026-06-15 -> Friday 2026-06-19 17:00 EDT.
    expect(iso(nextRunAfter(friday, at('2026-06-15T08:00:00Z')))).toBe('2026-06-19T21:00:00.000Z')
    // On the day, past the slot -> next week.
    expect(iso(nextRunAfter(friday, at('2026-06-19T22:00:00Z')))).toBe('2026-06-26T21:00:00.000Z')

    const sunday: RoutineSchedule = { kind: 'weekly', at: '08:00', weekday: 0, timezone: NY }
    expect(iso(nextRunAfter(sunday, at('2026-06-15T08:00:00Z')))).toBe('2026-06-21T12:00:00.000Z')
  })

  it('is STRICTLY after — asked at a fire instant it answers with the NEXT one', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '09:00', timezone: NY }
    const fire = at('2026-06-15T13:00:00Z')
    expect(iso(nextRunAfter(schedule, fire))).toBe('2026-06-16T13:00:00.000Z')
  })

  it('answers null for a malformed time or a zone Intl does not know', () => {
    expect(nextRunAfter({ kind: 'daily', at: '9:00', timezone: NY }, 0)).toBeNull()
    expect(nextRunAfter({ kind: 'daily', at: '09:00', timezone: 'Mars/Olympus_Mons' }, 0)).toBeNull()
    expect(expectedLastDue({ kind: 'daily', at: '25:00', timezone: NY }, 0)).toBeNull()
    expect(expectedLastDue({ kind: 'daily', at: '09:00', timezone: '' }, 0)).toBeNull()
  })
})

describe('expectedLastDue — the backwards computation the detector runs (ADR-0028 part 6)', () => {
  it('answers the most recent slot at or before now', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '09:00', timezone: NY }
    expect(iso(expectedLastDue(schedule, at('2026-06-15T14:00:00Z')))).toBe('2026-06-15T13:00:00.000Z')
    // Before today's slot -> yesterday's.
    expect(iso(expectedLastDue(schedule, at('2026-06-15T08:00:00Z')))).toBe('2026-06-14T13:00:00.000Z')
  })

  it('is INCLUSIVE of now — a fire instant is its own last-due', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '09:00', timezone: NY }
    const fire = at('2026-06-15T13:00:00Z')
    expect(expectedLastDue(schedule, fire)).toBe(fire)
  })

  it('reaches back over a closed weekend for a weekdays routine (PRD story 8)', () => {
    const schedule: RoutineSchedule = { kind: 'weekdays', at: '09:00', timezone: NY }
    // Laptop opened Monday 08:00 local: the last due was FRIDAY, not the weekend.
    expect(iso(expectedLastDue(schedule, at('2026-06-22T12:00:00Z')))).toBe('2026-06-19T13:00:00.000Z')
  })

  it('reaches back a whole week for a weekly routine', () => {
    const schedule: RoutineSchedule = { kind: 'weekly', at: '17:00', weekday: 5, timezone: NY }
    expect(iso(expectedLastDue(schedule, at('2026-06-25T00:00:00Z')))).toBe('2026-06-19T21:00:00.000Z')
  })
})

describe('the stored timezone is what decides (ADR-0028 part 2)', () => {
  it('gives the same schedule different instants in different zones', () => {
    const from = at('2026-06-15T00:00:00Z')
    const inNy = nextRunAfter({ kind: 'daily', at: '09:00', timezone: NY }, from)
    const inBerlin = nextRunAfter({ kind: 'daily', at: '09:00', timezone: BERLIN }, from)
    const inUtc = nextRunAfter({ kind: 'daily', at: '09:00', timezone: 'UTC' }, from)
    expect(iso(inNy)).toBe('2026-06-15T13:00:00.000Z')
    expect(iso(inBerlin)).toBe('2026-06-15T07:00:00.000Z')
    expect(iso(inUtc)).toBe('2026-06-15T09:00:00.000Z')
  })
})

describe('DST rule 1 — a REPEATED hour fires at the FIRST occurrence', () => {
  it('New York, autumn: 01:30 exists twice on 2026-11-01, and the earlier one wins', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '01:30', timezone: NY }
    // 02:00 EDT -> 01:00 EST at 06:00Z. 01:30 EDT = 05:30Z; 01:30 EST = 06:30Z.
    expect(iso(nextRunAfter(schedule, at('2026-11-01T00:00:00Z')))).toBe('2026-11-01T05:30:00.000Z')
    expect(iso(expectedLastDue(schedule, at('2026-11-01T12:00:00Z')))).toBe('2026-11-01T05:30:00.000Z')
  })

  it('Berlin, autumn: 02:30 exists twice on 2026-10-25, and the earlier one wins', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '02:30', timezone: BERLIN }
    // 03:00 CEST -> 02:00 CET at 01:00Z. 02:30 CEST = 00:30Z; 02:30 CET = 01:30Z.
    expect(iso(nextRunAfter(schedule, at('2026-10-24T23:00:00Z')))).toBe('2026-10-25T00:30:00.000Z')
  })

  it('Sydney, autumn (southern hemisphere): 02:30 twice on 2026-04-05', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '02:30', timezone: SYDNEY }
    // 03:00 AEDT -> 02:00 AEST at 2026-04-04T16:00Z. 02:30 AEDT = 15:30Z the day before.
    expect(iso(nextRunAfter(schedule, at('2026-04-04T12:00:00Z')))).toBe('2026-04-04T15:30:00.000Z')
  })
})

describe('DST rule 3 — at most once per scheduled slot', () => {
  it('does not fire again in the second pass of a repeated hour', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '01:30', timezone: NY }
    const fired = at('2026-11-01T05:30:00Z') // the first 01:30
    // The second 01:30 (06:30Z) is NOT a slot — the next one is the following day.
    expect(iso(nextRunAfter(schedule, fired))).toBe('2026-11-02T06:30:00.000Z')
  })

  it('and the detector agrees: mid-repeat, the last due is still the first occurrence', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '01:30', timezone: NY }
    // Asked between the two 01:30s, the last due is the first one, never the second.
    expect(iso(expectedLastDue(schedule, at('2026-11-01T06:45:00Z')))).toBe(
      '2026-11-01T05:30:00.000Z',
    )
  })
})

describe('DST rule 2 — a SKIPPED hour fires at the next valid local time', () => {
  it('New York, spring: 02:30 does not exist on 2026-03-08, so 03:00 local fires', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '02:30', timezone: NY }
    // 02:00 EST -> 03:00 EDT at 07:00Z; 07:00Z reads 03:00 local, the first valid time.
    expect(iso(nextRunAfter(schedule, at('2026-03-08T00:00:00Z')))).toBe('2026-03-08T07:00:00.000Z')
    expect(iso(expectedLastDue(schedule, at('2026-03-08T12:00:00Z')))).toBe(
      '2026-03-08T07:00:00.000Z',
    )
  })

  it('Berlin, spring: 02:30 does not exist on 2026-03-29, so 03:00 local fires', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '02:30', timezone: BERLIN }
    // 02:00 CET -> 03:00 CEST at 01:00Z.
    expect(iso(nextRunAfter(schedule, at('2026-03-28T23:00:00Z')))).toBe('2026-03-29T01:00:00.000Z')
  })

  it('Sydney, spring (southern hemisphere): 02:30 does not exist on 2026-10-04', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '02:30', timezone: SYDNEY }
    // 02:00 AEST -> 03:00 AEDT at 2026-10-03T16:00Z.
    expect(iso(nextRunAfter(schedule, at('2026-10-03T12:00:00Z')))).toBe('2026-10-03T16:00:00.000Z')
  })

  it('still fires exactly once on the day the hour was skipped', () => {
    const schedule: RoutineSchedule = { kind: 'daily', at: '02:30', timezone: NY }
    const fired = at('2026-03-08T07:00:00Z')
    expect(iso(nextRunAfter(schedule, fired))).toBe('2026-03-09T06:30:00.000Z')
  })
})

describe('the round-trip property — the firer and the detector agree', () => {
  /**
   * THE test of this slice. `nextRunAfter` produces a fire instant; feeding that
   * instant back to `expectedLastDue` must return it unchanged. If it ever did
   * not, the detector would either see a run it had already recorded as missed,
   * or miss one that never happened — and every downstream slice believes it.
   */
  const zones = ['UTC', NY, BERLIN, SYDNEY, 'Asia/Kolkata', 'Pacific/Chatham']
  const times = ['00:00', '01:30', '02:30', '09:00', '23:59']
  const probes = [
    // Ordinary instants, plus both DST transitions in every direction above.
    '2026-01-01T00:00:00Z',
    '2026-03-08T06:59:00Z',
    '2026-03-08T07:01:00Z',
    '2026-03-29T00:30:00Z',
    '2026-04-04T15:45:00Z',
    '2026-06-15T11:11:11Z',
    '2026-10-03T15:59:00Z',
    '2026-10-25T00:45:00Z',
    '2026-11-01T06:15:00Z',
    '2026-12-31T23:59:59Z',
  ]

  it('holds for every kind, zone, time and probe instant', () => {
    for (const timezone of zones) {
      for (const time of times) {
        const schedules: RoutineSchedule[] = [
          { kind: 'daily', at: time, timezone },
          { kind: 'weekdays', at: time, timezone },
          { kind: 'weekly', at: time, weekday: 3, timezone },
          { kind: 'weekly', at: time, weekday: 0, timezone },
        ]
        for (const schedule of schedules) {
          for (const probe of probes) {
            const fire = nextRunAfter(schedule, at(probe))
            expect(fire).not.toBeNull()
            expect({ schedule, probe, lastDue: iso(expectedLastDue(schedule, fire as number)) })
              .toEqual({ schedule, probe, lastDue: iso(fire) })
          }
        }
      }
    }
  })

  it('holds in a zone that is NOT this machine’s', () => {
    // Whatever the machine is set to, at least one of these is somewhere else.
    const elsewhere = zones.find((zone) => zone !== machineTimezone())
    expect(elsewhere).toBeDefined()
    const schedule: RoutineSchedule = { kind: 'daily', at: '09:00', timezone: elsewhere as string }
    const fire = nextRunAfter(schedule, at('2026-06-15T11:11:11Z'))
    expect(fire).not.toBeNull()
    expect(expectedLastDue(schedule, fire as number)).toBe(fire)
  })

  it('walks a whole year of daily fires without drifting or repeating', () => {
    // Every consecutive pair is strictly increasing and each is its own last-due,
    // which is rule 3 stated over the sequence rather than over one transition.
    const schedule: RoutineSchedule = { kind: 'daily', at: '02:30', timezone: NY }
    let cursor = at('2026-01-01T00:00:00Z')
    for (let day = 0; day < 366; day += 1) {
      const fire = nextRunAfter(schedule, cursor)
      expect(fire).not.toBeNull()
      expect(fire as number).toBeGreaterThan(cursor)
      expect(expectedLastDue(schedule, fire as number)).toBe(fire)
      cursor = fire as number
    }
    // 366 daily fires from New Year’s Day land inside the following year.
    expect(new Date(cursor).getUTCFullYear()).toBe(2027)
  })
})
