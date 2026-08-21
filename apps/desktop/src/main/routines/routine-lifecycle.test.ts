import { describe, it, expect } from 'vitest'
import type { BotRecord, RoutineRecord } from '../../shared/ipc'
import { MAX_ROUTINES_PER_BOT } from '../../shared/routine-limits'
import { machineTimezone, type RoutineSchedule } from '../../shared/schedule'
import type {
  RoutineInsert,
  RoutinePatch,
  RoutineRunResult,
  RoutineStoreApi,
} from '../persistence/routine-store-api'
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  updateRoutine,
  type RoutineLifecycleDeps,
} from './routine-lifecycle'

/**
 * The Routine CRUD orchestration (#467), against fakes — no Electron, no SQLite.
 * What is asserted here is the DECISIONS: what is refused, what is defaulted,
 * and what the user is told.
 */

const DAILY: RoutineSchedule = { kind: 'daily', at: '09:00', timezone: 'America/New_York' }
const BOT_THREAD = 'thread-bot'

/** An in-memory `RoutineStoreApi` that behaves like the SQLite one, cap included. */
class FakeRoutineStore implements RoutineStoreApi {
  readonly rows: RoutineRecord[] = []
  failWrites = false

  list(): RoutineRecord[] {
    return [...this.rows]
  }
  listByBot(threadId: string): RoutineRecord[] {
    return this.rows.filter((row) => row.threadId === threadId)
  }
  get(id: string): RoutineRecord | null {
    return this.rows.find((row) => row.id === id) ?? null
  }
  insert(input: RoutineInsert): RoutineRecord | null {
    if (this.failWrites) return null
    if (this.listByBot(input.threadId).length >= MAX_ROUTINES_PER_BOT) return null
    const record: RoutineRecord = {
      ...input,
      lastRunAt: null,
      lastOutcome: null,
      lastError: null,
      createdAt: 1000,
      updatedAt: 1000,
    }
    this.rows.push(record)
    return record
  }
  update(id: string, patch: RoutinePatch): RoutineRecord | null {
    if (this.failWrites) return null
    const index = this.rows.findIndex((row) => row.id === id)
    if (index < 0) return null
    const next = { ...this.rows[index], ...patch, updatedAt: 2000 }
    this.rows[index] = next
    return next
  }
  recordRun(id: string, result: RoutineRunResult): RoutineRecord | null {
    const index = this.rows.findIndex((row) => row.id === id)
    if (index < 0) return null
    const next = { ...this.rows[index], ...result, lastError: result.lastError ?? null }
    this.rows[index] = next
    return next
  }
  delete(id: string): boolean {
    const index = this.rows.findIndex((row) => row.id === id)
    if (index < 0) return false
    this.rows.splice(index, 1)
    return true
  }
}

function makeDeps(botThreads: string[] = [BOT_THREAD]) {
  const routines = new FakeRoutineStore()
  let minted = 0
  const deps: RoutineLifecycleDeps = {
    routines,
    bots: {
      get: (threadId: string) =>
        botThreads.includes(threadId) ? ({ threadId } as BotRecord) : null,
    },
    mintRoutineId: () => `routine-${(minted += 1)}`,
  }
  return { deps, routines }
}

const createArgs = (over: Partial<Parameters<typeof createRoutine>[1]> = {}) => ({
  threadId: BOT_THREAD,
  name: 'Morning triage',
  prompt: 'Triage this repo’s issues and say what changed.',
  schedule: DAILY,
  ...over,
})

describe('createRoutine', () => {
  it('mints an id, stores the record and creates it ACTIVE (ADR-0028 part 7)', () => {
    const { deps } = makeDeps()
    const result = createRoutine(deps, createArgs())
    expect(result).toMatchObject({
      ok: true,
      routine: { id: 'routine-1', threadId: BOT_THREAD, active: true, schedule: DAILY },
    })
  })

  it('defaults the allowed commands to EMPTY — never seeded from anything', () => {
    const { deps } = makeDeps()
    const result = createRoutine(deps, createArgs())
    expect(result.ok && result.routine.allowedCommands).toEqual([])
  })

  it('normalizes the allowed commands it is given', () => {
    const { deps } = makeDeps()
    const result = createRoutine(
      deps,
      createArgs({ allowedCommands: [' git status ', 'git status', ''] }),
    )
    expect(result.ok && result.routine.allowedCommands).toEqual(['git status'])
  })

  it('stores the MACHINE’s zone when none was given, and never consults it again', () => {
    const { deps } = makeDeps()
    const schedule = { kind: 'daily', at: '09:00' } as unknown as RoutineSchedule
    const result = createRoutine(deps, createArgs({ schedule }))
    expect(result.ok && result.routine.schedule.timezone).toBe(machineTimezone())
  })

  it('refuses a Thread that is not a Bot — a Routine belongs to a Bot', () => {
    const { deps, routines } = makeDeps()
    const result = createRoutine(deps, createArgs({ threadId: 'thread-plain' }))
    expect(result).toMatchObject({ ok: false, reason: 'notFound' })
    expect(routines.rows).toEqual([])
  })

  it('refuses an unschedulable routine BEFORE anything is written, and says why', () => {
    const { deps, routines } = makeDeps()
    const schedule = { kind: 'daily', at: '9am', timezone: 'UTC' } as unknown as RoutineSchedule
    const result = createRoutine(deps, createArgs({ name: '', schedule }))
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(result.ok === false && result.problems.join(' ')).toMatch(/name|schedule\.at/)
    expect(routines.rows).toEqual([])
  })

  it(`refuses the ${MAX_ROUTINES_PER_BOT + 1}th routine on one Bot, with a message`, () => {
    const { deps } = makeDeps()
    for (let i = 0; i < MAX_ROUTINES_PER_BOT; i += 1) {
      expect(createRoutine(deps, createArgs({ name: `Routine ${i}` })).ok).toBe(true)
    }
    const result = createRoutine(deps, createArgs({ name: 'One too many' }))
    expect(result).toMatchObject({ ok: false, reason: 'capped' })
    expect(result.ok === false && result.problems[0]).toContain(String(MAX_ROUTINES_PER_BOT))
  })

  it('reports a failed write as io rather than throwing', () => {
    const { deps, routines } = makeDeps()
    routines.failWrites = true
    expect(createRoutine(deps, createArgs())).toMatchObject({ ok: false, reason: 'io' })
  })
})

describe('updateRoutine', () => {
  it('patches only what it is given', () => {
    const { deps } = makeDeps()
    createRoutine(deps, createArgs())
    const result = updateRoutine(deps, { id: 'routine-1', name: 'Renamed' })
    expect(result).toMatchObject({
      ok: true,
      routine: { name: 'Renamed', schedule: DAILY, prompt: createArgs().prompt },
    })
  })

  it('pauses and resumes — the prompt survives, which is the point of pausing', () => {
    const { deps } = makeDeps()
    createRoutine(deps, createArgs())
    const paused = updateRoutine(deps, { id: 'routine-1', active: false })
    expect(paused).toMatchObject({ ok: true, routine: { active: false, prompt: createArgs().prompt } })
    expect(updateRoutine(deps, { id: 'routine-1', active: true })).toMatchObject({
      ok: true,
      routine: { active: true },
    })
  })

  it('validates the MERGED record, not just the patch', () => {
    const { deps } = makeDeps()
    createRoutine(deps, createArgs())
    expect(updateRoutine(deps, { id: 'routine-1', name: '  ' })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
    const schedule = { kind: 'weekly', at: '09:00', timezone: 'UTC' } as unknown as RoutineSchedule
    expect(updateRoutine(deps, { id: 'routine-1', schedule })).toMatchObject({
      ok: false,
      reason: 'invalid',
    })
  })

  it('reports an unknown routine', () => {
    const { deps } = makeDeps()
    expect(updateRoutine(deps, { id: 'nope', name: 'x' })).toMatchObject({
      ok: false,
      reason: 'notFound',
    })
  })
})

describe('listRoutines and deleteRoutine', () => {
  it('lists every routine, or one Bot’s', () => {
    const { deps } = makeDeps([BOT_THREAD, 'thread-other'])
    createRoutine(deps, createArgs({ name: 'A' }))
    createRoutine(deps, createArgs({ threadId: 'thread-other', name: 'B' }))

    expect(listRoutines(deps).map((r) => r.name)).toEqual(['A', 'B'])
    expect(listRoutines(deps, { threadId: 'thread-other' }).map((r) => r.name)).toEqual(['B'])
  })

  it('deletes by id and reports an unknown one', () => {
    const { deps } = makeDeps()
    createRoutine(deps, createArgs())
    expect(deleteRoutine(deps, { id: 'routine-1' })).toEqual({ ok: true })
    expect(deleteRoutine(deps, { id: 'routine-1' })).toEqual({ ok: false })
  })
})
