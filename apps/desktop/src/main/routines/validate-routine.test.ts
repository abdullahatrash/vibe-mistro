import { describe, it, expect } from 'vitest'
import {
  ALLOWED_COMMAND_MAX_LENGTH,
  MAX_ALLOWED_COMMANDS,
  ROUTINE_NAME_MAX_LENGTH,
  ROUTINE_PROMPT_MAX_LENGTH,
} from '../../shared/routine-limits'
import type { RoutineSchedule } from '../../shared/schedule'
import {
  collectRoutineProblems,
  describeRoutineProblems,
  normalizeAllowedCommands,
  validateRoutineFields,
  validateRoutineSchedule,
} from './validate-routine'

/**
 * The rules that keep an unattended Routine from being stored in a state where
 * it silently never reports (#467, ADR-0028).
 */

const fields = (over: Partial<{ name: string; prompt: string; allowedCommands: string[] }> = {}) =>
  validateRoutineFields({
    name: 'Morning triage',
    prompt: 'Triage this repo’s issues and say what changed.',
    allowedCommands: [],
    ...over,
  })

const problemFields = (result: ReturnType<typeof validateRoutineFields>) =>
  collectRoutineProblems(result).map((problem) => problem.field)

describe('validateRoutineFields', () => {
  it('accepts a plain routine with no allowed commands — empty is the default', () => {
    expect(fields()).toEqual({ ok: true })
  })

  it('requires a name (ADR-0028 part 7: a list of identical schedules is unreadable)', () => {
    expect(problemFields(fields({ name: '' }))).toEqual(['name'])
    expect(problemFields(fields({ name: '   ' }))).toEqual(['name'])
  })

  it('bounds the name and refuses line breaks in it', () => {
    expect(problemFields(fields({ name: 'x'.repeat(ROUTINE_NAME_MAX_LENGTH + 1) }))).toEqual(['name'])
    expect(problemFields(fields({ name: 'Morning\ntriage' }))).toEqual(['name'])
    expect(fields({ name: 'x'.repeat(ROUTINE_NAME_MAX_LENGTH) })).toEqual({ ok: true })
  })

  it('requires a prompt — a blank one would report daily that it had nothing to ask', () => {
    expect(problemFields(fields({ prompt: '  ' }))).toEqual(['prompt'])
    expect(problemFields(fields({ prompt: 'x'.repeat(ROUTINE_PROMPT_MAX_LENGTH + 1) }))).toEqual([
      'prompt',
    ])
  })

  it('checks the SHAPE of each allowed command', () => {
    expect(fields({ allowedCommands: ['gh issue list --state open', 'git status'] })).toEqual({
      ok: true,
    })
    expect(problemFields(fields({ allowedCommands: [''] }))).toEqual(['allowedCommands'])
    expect(problemFields(fields({ allowedCommands: ['a'.repeat(ALLOWED_COMMAND_MAX_LENGTH + 1)] }))).toEqual(
      ['allowedCommands'],
    )
    // Two invocations in one entry: only one of them would ever be read.
    expect(problemFields(fields({ allowedCommands: ['git status\nrm -rf /'] }))).toEqual([
      'allowedCommands',
    ])
    expect(
      problemFields(fields({ allowedCommands: Array(MAX_ALLOWED_COMMANDS + 1).fill('git status') })),
    ).toEqual(['allowedCommands'])
  })

  it('reports every problem at once, so a form shows them together', () => {
    const result = fields({ name: '', prompt: '', allowedCommands: [''] })
    expect(problemFields(result).sort()).toEqual(['allowedCommands', 'name', 'prompt'])
    expect(describeRoutineProblems(collectRoutineProblems(result))[0]).toMatch(/^name: /)
  })
})

describe('validateRoutineSchedule', () => {
  it('accepts the three kinds', () => {
    const zone = 'America/New_York'
    expect(validateRoutineSchedule({ kind: 'daily', at: '09:00', timezone: zone })).toEqual({ ok: true })
    expect(validateRoutineSchedule({ kind: 'weekdays', at: '09:00', timezone: zone })).toEqual({
      ok: true,
    })
    expect(
      validateRoutineSchedule({ kind: 'weekly', at: '17:00', weekday: 5, timezone: zone }),
    ).toEqual({ ok: true })
  })

  it('refuses a malformed time of day', () => {
    const bad = { kind: 'daily', at: '9am', timezone: 'UTC' } as unknown as RoutineSchedule
    expect(collectRoutineProblems(validateRoutineSchedule(bad)).map((p) => p.field)).toEqual([
      'schedule.at',
    ])
  })

  it('refuses a weekly schedule with no weekday to key on', () => {
    const bad = { kind: 'weekly', at: '09:00', timezone: 'UTC' } as unknown as RoutineSchedule
    expect(collectRoutineProblems(validateRoutineSchedule(bad)).map((p) => p.field)).toEqual([
      'schedule.weekday',
    ])
  })

  it('refuses an unknown kind — a cron variant is a future branch, not a free-for-all', () => {
    const bad = { kind: 'hourly', at: '09:00', timezone: 'UTC' } as unknown as RoutineSchedule
    expect(collectRoutineProblems(validateRoutineSchedule(bad)).map((p) => p.field)).toEqual([
      'schedule.kind',
    ])
  })

  it('refuses a timezone Intl does not know, and a missing one', () => {
    expect(
      collectRoutineProblems(
        validateRoutineSchedule({ kind: 'daily', at: '09:00', timezone: 'Mars/Olympus_Mons' }),
      ).map((p) => p.field),
    ).toEqual(['schedule.timezone'])
    expect(
      collectRoutineProblems(
        validateRoutineSchedule({ kind: 'daily', at: '09:00', timezone: '' }),
      ).map((p) => p.field),
    ).toEqual(['schedule.timezone'])
  })
})

describe('normalizeAllowedCommands', () => {
  it('trims, drops blanks and duplicates, and keeps the order', () => {
    expect(
      normalizeAllowedCommands(['  git status ', '', 'gh issue list', 'git status', '   ']),
    ).toEqual(['git status', 'gh issue list'])
  })

  it('leaves the invocation itself alone — only the surrounding whitespace goes', () => {
    expect(normalizeAllowedCommands([' gh issue list --state open '])).toEqual([
      'gh issue list --state open',
    ])
  })
})
