import { describe, expect, it } from 'vitest'
import type { RoutineRecord } from '../../../shared/ipc'
import { MAX_ALLOWED_COMMANDS, MAX_ROUTINES_PER_BOT } from '../../../shared/routine-limits'
import {
  allowedCommandProblem,
  allowedCommandWarning,
  canSubmitRoutineForm,
  initialRoutineFormValues,
  isRoutineFormDirty,
  routineCapProblem,
  routineCreateArgs,
  routineScheduleOf,
  routineUpdateArgs,
  validateRoutineForm,
  type RoutineFormValues,
} from './routine-form'

/**
 * The Routine editor's rules (#471). Pure, so "what this form refuses" is a list of
 * assertions rather than a sequence of clicks.
 *
 * Two of them are the load-bearing ones. The **cap** must be stated before anything
 * is typed, because main answering `capped` after a prompt is written throws away
 * the only part the user actually authored. And an **allowed command** must be
 * judged by what the matcher will do with it: it compares the whole invocation
 * verbatim, so an entry written as a pattern silently matches nothing, and only
 * this form can say so while it is still editable.
 */

function values(over: Partial<RoutineFormValues> = {}): RoutineFormValues {
  return {
    name: 'Morning triage',
    prompt: 'Triage the repo and say what changed.',
    kind: 'weekdays',
    at: '09:00',
    weekday: 1,
    timezone: 'Europe/Berlin',
    allowedCommands: [],
    active: true,
    ...over,
  }
}

function record(over: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: 'r1',
    threadId: 'bot-1',
    name: 'Morning triage',
    prompt: 'Triage the repo and say what changed.',
    schedule: { kind: 'weekdays', at: '09:00', timezone: 'Europe/Berlin' },
    allowedCommands: ['gh issue list'],
    active: true,
    lastRunAt: null,
    lastOutcome: null,
    lastError: null,
    lastBlockedCommand: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('initialRoutineFormValues', () => {
  it('starts a new routine ACTIVE, on weekdays at 09:00', () => {
    const initial = initialRoutineFormValues({ target: { mode: 'create', threadId: 'bot-1' }, routines: [] })
    expect(initial.active).toBe(true)
    expect(initial.kind).toBe('weekdays')
    expect(initial.at).toBe('09:00')
    expect(initial.allowedCommands).toEqual([])
    expect(initial.timezone).toBeTruthy()
  })

  it('seeds an edit from the record, weekday included', () => {
    const routine = record({ schedule: { kind: 'weekly', at: '17:30', weekday: 5, timezone: 'UTC' } })
    const initial = initialRoutineFormValues({
      target: { mode: 'edit', threadId: 'bot-1', routineId: 'r1' },
      routines: [routine],
    })
    expect(initial).toMatchObject({ kind: 'weekly', at: '17:30', weekday: 5, timezone: 'UTC' })
  })

  it('falls back to an empty form when the record vanished under it', () => {
    const initial = initialRoutineFormValues({
      target: { mode: 'edit', threadId: 'bot-1', routineId: 'gone' },
      routines: [],
    })
    expect(initial.name).toBe('')
  })
})

describe('validateRoutineForm', () => {
  it('accepts a complete routine', () => {
    expect(validateRoutineForm(values())).toEqual({})
    expect(canSubmitRoutineForm(values())).toBe(true)
  })

  it('requires a name — slices 3 and 4 already write messages that use it', () => {
    expect(validateRoutineForm(values({ name: '  ' })).name).toBe('A routine needs a name.')
  })

  it('requires a prompt, or the routine reports daily that it had nothing to ask', () => {
    expect(validateRoutineForm(values({ prompt: '' })).prompt).toBeTruthy()
  })

  it('refuses a malformed time', () => {
    expect(validateRoutineForm(values({ at: '9am' })).at).toBeTruthy()
    expect(validateRoutineForm(values({ at: '25:00' })).at).toBeTruthy()
    expect(validateRoutineForm(values({ at: '9:00' })).at).toBeTruthy()
    expect(validateRoutineForm(values({ at: '09:00' })).at).toBeUndefined()
  })

  it('refuses a zone this app cannot resolve, because 09:00 must be 09:00 somewhere', () => {
    expect(validateRoutineForm(values({ timezone: 'Mars/Olympus' })).timezone).toBeTruthy()
    expect(validateRoutineForm(values({ timezone: '' })).timezone).toBeTruthy()
    expect(validateRoutineForm(values({ timezone: 'America/New_York' })).timezone).toBeUndefined()
  })

  it('bounds the allowed commands at the number main bounds them at', () => {
    const many = Array.from({ length: MAX_ALLOWED_COMMANDS + 1 }, (_, i) => `echo ${i}`)
    expect(validateRoutineForm(values({ allowedCommands: many })).allowedCommands).toBeTruthy()
  })
})

describe('routineCapProblem', () => {
  it('states the 5-per-Bot cap BEFORE the form is filled in', () => {
    expect(
      routineCapProblem({ target: { mode: 'create', threadId: 'bot-1' }, routineCount: MAX_ROUTINES_PER_BOT }),
    ).toMatch(/already has 5 routines/)
  })

  it('stays quiet below the cap', () => {
    expect(
      routineCapProblem({ target: { mode: 'create', threadId: 'bot-1' }, routineCount: MAX_ROUTINES_PER_BOT - 1 }),
    ).toBeNull()
  })

  it('never blocks an EDIT — editing the fifth routine is not adding a sixth', () => {
    expect(
      routineCapProblem({
        target: { mode: 'edit', threadId: 'bot-1', routineId: 'r1' },
        routineCount: MAX_ROUTINES_PER_BOT,
      }),
    ).toBeNull()
  })
})

describe('allowedCommandProblem — what the stored list cannot carry', () => {
  it('refuses a blank entry', () => {
    expect(allowedCommandProblem('   ', [])).toBeTruthy()
  })

  it('refuses a duplicate, comparing it the way the matcher will (trimmed)', () => {
    expect(allowedCommandProblem('  gh issue list ', ['gh issue list'])).toMatch(/already on the list/)
  })

  it('refuses a multi-line entry — a line break makes it two commands', () => {
    expect(allowedCommandProblem('gh issue list\nrm -rf /', [])).toBeTruthy()
  })

  it('refuses one past the cap', () => {
    const full = Array.from({ length: MAX_ALLOWED_COMMANDS }, (_, i) => `echo ${i}`)
    expect(allowedCommandProblem('gh issue list', full)).toBeTruthy()
  })

  it('accepts an ordinary invocation', () => {
    expect(allowedCommandProblem('gh issue list --state open', ['git log'])).toBeNull()
  })
})

describe('allowedCommandWarning — what the matcher will do that surprises', () => {
  it('warns that a wildcard is not expanded', () => {
    expect(allowedCommandWarning('gh issue *')).toMatch(/Wildcards are not expanded/)
  })

  it('warns that a combined command is only ever matched verbatim', () => {
    expect(allowedCommandWarning('echo hi > file.txt')).toMatch(/combines commands/)
    expect(allowedCommandWarning('git log | head')).toMatch(/combines commands/)
  })

  it('says nothing about a plain invocation', () => {
    expect(allowedCommandWarning('gh issue list --state open')).toBeNull()
  })
})

describe('what the form SENDS', () => {
  it('builds a weekly schedule with its weekday, and a daily one without', () => {
    expect(routineScheduleOf(values({ kind: 'weekly', weekday: 3 }))).toEqual({
      kind: 'weekly',
      weekday: 3,
      at: '09:00',
      timezone: 'Europe/Berlin',
    })
    expect(routineScheduleOf(values({ kind: 'daily' }))).toEqual({
      kind: 'daily',
      at: '09:00',
      timezone: 'Europe/Berlin',
    })
  })

  it('trims and de-duplicates the commands exactly as main stores them', () => {
    const args = routineCreateArgs(
      'bot-1',
      values({ allowedCommands: [' gh issue list ', 'gh issue list', '', 'git log'] }),
    )
    expect(args.allowedCommands).toEqual(['gh issue list', 'git log'])
    expect(args.threadId).toBe('bot-1')
  })

  it('carries `active` on an update, so the editor can pause as well as the list can', () => {
    expect(routineUpdateArgs('r1', values({ active: false }))).toMatchObject({
      id: 'r1',
      active: false,
    })
  })
})

describe('isRoutineFormDirty', () => {
  it('is false for an untouched edit', () => {
    const routine = record()
    const initial = initialRoutineFormValues({
      target: { mode: 'edit', threadId: 'bot-1', routineId: 'r1' },
      routines: [routine],
    })
    expect(isRoutineFormDirty(initial, routine)).toBe(false)
  })

  it('notices every field that would change the record', () => {
    const routine = record()
    const from = (over: Partial<RoutineFormValues>): boolean =>
      isRoutineFormDirty(values({ allowedCommands: ['gh issue list'], ...over }), routine)
    expect(from({ name: 'Evening triage' })).toBe(true)
    expect(from({ at: '10:00' })).toBe(true)
    expect(from({ kind: 'daily' })).toBe(true)
    expect(from({ timezone: 'UTC' })).toBe(true)
    expect(from({ active: false })).toBe(true)
    expect(from({ allowedCommands: ['gh issue list', 'git log'] })).toBe(true)
    expect(from({})).toBe(false)
  })

  it('sees a changed weekday on a weekly schedule', () => {
    const routine = record({ schedule: { kind: 'weekly', at: '09:00', weekday: 1, timezone: 'UTC' } })
    const base = values({ kind: 'weekly', weekday: 1, timezone: 'UTC', allowedCommands: ['gh issue list'] })
    expect(isRoutineFormDirty(base, routine)).toBe(false)
    expect(isRoutineFormDirty({ ...base, weekday: 4 }, routine)).toBe(true)
  })
})
