import { describe, expect, it } from 'vitest'
import { runRoutineTurn, type RoutineTurnDeps, type RoutineTurnPrompt } from './run-routine-turn'
import { ThreadStatusTracker } from '../thread-status'
import type { PromptTurnAgent } from '../prompt-turn'
import type {
  BotRecord,
  RoutineRecord,
  SendPromptResult,
  ThreadMeta,
  WorkspaceMeta,
} from '../../shared/ipc'
import type { RoutineRunResult } from '../persistence/routine-store-api'

/**
 * The one entry point that runs a Routine's prompt with nobody watching (#468,
 * ADR-0028) — resolution, the ATOMIC busy claim, eviction protection across the
 * whole run, and the outcome recorded on the Routine, success or failure.
 *
 * The claim is exercised against the REAL `ThreadStatusTracker`, because the
 * property under test — two concurrent attempts on one Bot produce one turn and one
 * defer — is a property of that pair, not of a stub that always says yes.
 */

const ROUTINE: RoutineRecord = {
  id: 'r1',
  threadId: 'bot-thread',
  name: 'Morning triage',
  prompt: 'Triage this repo and say what changed.',
  schedule: { kind: 'weekdays', at: '09:00', timezone: 'Europe/Berlin' },
  allowedCommands: [],
  active: true,
  lastRunAt: null,
  lastOutcome: null,
  lastError: null,
  createdAt: 0,
  updatedAt: 0,
}

const THREAD: ThreadMeta = {
  id: 'bot-thread',
  workspaceId: 'w1',
  sessionId: 'sess-1',
  title: 'Morning triage',
  createdAt: 0,
  lastActiveAt: 0,
}

const WORKSPACE: WorkspaceMeta = { id: 'w1', dir: '/proj/a', displayName: 'a', lastOpenedAt: 0 }

const BOT = { threadId: 'bot-thread', name: 'Triager' } as BotRecord

/** A stand-in agent: the turn itself is `runPromptTurn`'s business, tested there. */
const AGENT = {} as PromptTurnAgent

interface Harness {
  deps: RoutineTurnDeps
  runs: RoutineRunResult[]
  prompts: RoutineTurnPrompt[]
  protectedNow: Set<string>
  protectionHistory: string[]
  status: ThreadStatusTracker
}

function harness(
  over: {
    routine?: RoutineRecord | null
    bot?: BotRecord | null
    threads?: ThreadMeta[]
    workspaces?: WorkspaceMeta[]
    turn?: (args: RoutineTurnPrompt) => Promise<SendPromptResult>
  } = {},
): Harness {
  const runs: RoutineRunResult[] = []
  const prompts: RoutineTurnPrompt[] = []
  const protectedNow = new Set<string>()
  const protectionHistory: string[] = []
  const status = new ThreadStatusTracker()
  const routine = over.routine === undefined ? ROUTINE : over.routine
  return {
    runs,
    prompts,
    protectedNow,
    protectionHistory,
    status,
    deps: {
      routines: {
        get: (id) => (routine && routine.id === id ? routine : null),
        recordRun: (_id, result) => {
          runs.push(result)
          return null
        },
      },
      bots: { get: () => (over.bot === undefined ? BOT : over.bot) },
      threads: {
        snapshot: () => ({
          threads: over.threads ?? [THREAD],
          workspaces: over.workspaces ?? [WORKSPACE],
        }),
      },
      acquireAgent: () => ({ agentId: 'a1', agent: AGENT }),
      claimThread: (agentId, threadId) => status.tryBeginTurn(agentId, threadId).claimed,
      releaseThread: (agentId, threadId) => void status.endTurn(agentId, threadId),
      beginProtection: (agentId) => {
        protectedNow.add(agentId)
        protectionHistory.push(`begin ${agentId}`)
      },
      endProtection: (agentId) => {
        protectedNow.delete(agentId)
        protectionHistory.push(`end ${agentId}`)
      },
      runTurn: async (_agent, args) => {
        prompts.push(args)
        return over.turn
          ? await over.turn(args)
          : { ok: true, result: { stopReason: 'end_turn' }, sessionId: 'sess-1' }
      },
      now: () => 1_700_000_000_000,
    },
  }
}

describe('runRoutineTurn — the happy path', () => {
  it("sends the Routine's prompt into the Bot's OWN Thread and session", async () => {
    const h = harness()

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(result).toEqual({ outcome: 'ok', error: null, sessionId: 'sess-1' })
    expect(h.prompts).toEqual([
      {
        agentId: 'a1',
        threadId: 'bot-thread',
        workspaceId: 'w1',
        sessionId: 'sess-1', // the Bot's continuing conversation, never a fresh Thread
        text: 'Triage this repo and say what changed.',
      },
    ])
  })

  it('records the run on the Routine, clearing the failure it recovered from', async () => {
    const h = harness()
    await runRoutineTurn(h.deps, 'r1')
    expect(h.runs).toEqual([{ lastRunAt: 1_700_000_000_000, lastOutcome: 'ok', lastError: null }])
  })

  it('protects the agent for the whole run and releases it afterwards', async () => {
    const h = harness({
      turn: async () => {
        // Mid-turn: the sweep must find this agent protected.
        expect(h.protectedNow.has('a1')).toBe(true)
        return { ok: true, result: { stopReason: 'end_turn' }, sessionId: 'sess-1' }
      },
    })

    await runRoutineTurn(h.deps, 'r1')

    expect(h.protectionHistory).toEqual(['begin a1', 'end a1'])
    expect(h.protectedNow.size).toBe(0)
  })

  it('leaves the Thread unclaimed at the end, so the next run can take it', async () => {
    const h = harness()
    await runRoutineTurn(h.deps, 'r1')
    expect(h.status.statusFor('bot-thread').streaming).toBe(false)
  })
})

describe('runRoutineTurn — the busy claim (#456, atomically)', () => {
  it('two concurrent attempts on one Bot produce ONE turn and ONE defer', async () => {
    // A turn held open until the test lets it finish, so the second attempt lands
    // while the first is genuinely mid-stream.
    const gate: { finish: (result: SendPromptResult) => void } = { finish: () => {} }
    const h = harness({
      turn: () => new Promise<SendPromptResult>((resolve) => void (gate.finish = resolve)),
    })

    const first = runRoutineTurn(h.deps, 'r1')
    const second = runRoutineTurn(h.deps, 'r1') // arrives while the first still streams
    gate.finish({ ok: true, result: { stopReason: 'end_turn' }, sessionId: 'sess-1' })
    const outcomes = (await Promise.all([first, second])).map((r) => r.outcome)

    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'deferred')).toHaveLength(1)
    expect(h.prompts).toHaveLength(1) // exactly one `session/prompt` was sent
  })

  it('defers when the user is already talking to the Bot, and never spawns a turn', async () => {
    const h = harness()
    h.status.beginTurn('a1', 'bot-thread') // a user-initiated turn holds the Thread

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(result.outcome).toBe('deferred')
    expect(h.prompts).toEqual([])
    // Recorded on the Routine — ADR-0028 keeps a defer OUT of the conversation.
    expect(h.runs).toEqual([
      { lastRunAt: 1_700_000_000_000, lastOutcome: 'deferred', lastError: expect.any(String) },
    ])
    // The refusal did not disturb the user's own turn.
    expect(h.status.statusFor('bot-thread').streaming).toBe(true)
  })

  it('does not protect an agent it never claimed', async () => {
    const h = harness()
    h.status.beginTurn('a1', 'bot-thread')
    await runRoutineTurn(h.deps, 'r1')
    expect(h.protectionHistory).toEqual([])
  })
})

describe('runRoutineTurn — every failure is an outcome, never a rejection', () => {
  it('records a failed turn with the message that makes it fixable', async () => {
    const h = harness({
      turn: async () => ({ ok: false, kind: 'error', error: 'Context too long.', code: -31004 }),
    })

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(result).toEqual({ outcome: 'failed', error: 'Context too long.', code: -31004 })
    expect(h.runs).toEqual([
      { lastRunAt: 1_700_000_000_000, lastOutcome: 'failed', lastError: 'Context too long.' },
    ])
  })

  it('turns a sign-in expiry into a failure that says what to do, not a browser at 07:00', async () => {
    const h = harness({
      turn: async () => ({ ok: false, kind: 'not-signed-in', agentId: 'a1', authMethods: [] }),
    })

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(result.outcome).toBe('failed')
    expect(result.error).toMatch(/sign in/i)
  })

  it('still releases the claim and the protection when the turn throws', async () => {
    const h = harness({
      turn: async () => {
        throw new Error('boom')
      },
    })

    await expect(runRoutineTurn(h.deps, 'r1')).rejects.toThrow('boom')
    expect(h.protectedNow.size).toBe(0)
    expect(h.status.statusFor('bot-thread').streaming).toBe(false)
  })

  it('refuses a Routine whose Bot is gone, and records why', async () => {
    const h = harness({ bot: null })
    const result = await runRoutineTurn(h.deps, 'r1')
    expect(result.outcome).toBe('failed')
    expect(h.runs).toHaveLength(1)
    expect(h.prompts).toEqual([])
  })

  it('refuses rather than guessing a directory when the project record is missing', async () => {
    const h = harness({ workspaces: [] })
    const result = await runRoutineTurn(h.deps, 'r1')
    expect(result.outcome).toBe('failed')
    expect(h.prompts).toEqual([])
  })

  it('answers an unknown Routine id without recording anything', async () => {
    const h = harness({ routine: null })
    expect(await runRoutineTurn(h.deps, 'r1')).toEqual({
      outcome: 'failed',
      error: 'No routine r1.',
    })
    expect(h.runs).toEqual([])
  })
})
