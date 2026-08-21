import { describe, expect, it, vi } from 'vitest'
import {
  runRoutineTurn,
  type RoutineTurnAgent,
  type RoutineTurnDeps,
  type RoutineTurnPrompt,
} from './run-routine-turn'
import { ThreadStatusTracker } from '../thread-status'
import type { PromptTurnGate } from '../prompt-turn'
import type { RoutineGateResult } from './write-routine-profile'
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
  lastBlockedCommand: null,
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

const BOT_PROFILE_ID = 'mistro-bot-11111111-2222-3333-4444-555555555555'
const GATE_PROFILE_ID = 'mistro-routine-11111111-2222-3333-4444-555555555555'

const BOT = { threadId: 'bot-thread', name: 'Triager', profileId: BOT_PROFILE_ID } as BotRecord

/**
 * A stand-in agent: the turn itself is `runPromptTurn`'s business, tested there.
 * Since #469 it also carries the four calls the permission gate drives — the raw
 * event stream, the answer, the cancel and the persona restore.
 */
function stubAgent(): RoutineTurnAgent & { modes: string[]; listeners: ((p: unknown) => void)[] } {
  const listeners: ((p: unknown) => void)[] = []
  const modes: string[] = []
  return {
    modes,
    listeners,
    on: (_event: string, listener: (p: unknown) => void) => listeners.push(listener),
    off: (_event: string, listener: (p: unknown) => void) => {
      const at = listeners.indexOf(listener)
      if (at >= 0) listeners.splice(at, 1)
    },
    respondPermission: () => {},
    cancel: () => {},
    setMode: async (_sessionId: string, modeId: string) => void modes.push(modeId),
  } as unknown as RoutineTurnAgent & { modes: string[]; listeners: ((p: unknown) => void)[] }
}

interface Harness {
  deps: RoutineTurnDeps
  runs: RoutineRunResult[]
  prompts: RoutineTurnPrompt[]
  protectedNow: Set<string>
  protectionHistory: string[]
  status: ThreadStatusTracker
  /** Every failure written into the Bot's conversation (#469). */
  failures: { threadId: string; message: string; prompt?: string }[]
  agent: ReturnType<typeof stubAgent>
}

function harness(
  over: {
    routine?: RoutineRecord | null
    bot?: BotRecord | null
    threads?: ThreadMeta[]
    workspaces?: WorkspaceMeta[]
    turn?: (args: RoutineTurnPrompt, gate: PromptTurnGate, agent: RoutineTurnAgent) => Promise<SendPromptResult>
    gate?: RoutineGateResult
  } = {},
): Harness {
  const runs: RoutineRunResult[] = []
  const prompts: RoutineTurnPrompt[] = []
  const protectedNow = new Set<string>()
  const protectionHistory: string[] = []
  const status = new ThreadStatusTracker()
  const failures: { threadId: string; message: string; prompt?: string }[] = []
  const agent = stubAgent()
  const routine = over.routine === undefined ? ROUTINE : over.routine
  return {
    runs,
    prompts,
    protectedNow,
    protectionHistory,
    status,
    failures,
    agent,
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
      acquireAgent: () => ({ agentId: 'a1', agent }),
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
      ensureGate: async () => over.gate ?? { ok: true, profileId: GATE_PROFILE_ID },
      reportFailure: (args) => void failures.push(args),
      runTurn: async (turnAgent, args, gate) => {
        prompts.push(args)
        return over.turn
          ? await over.turn(args, gate, turnAgent)
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
    expect(h.runs).toEqual([
      { lastRunAt: 1_700_000_000_000, lastOutcome: 'ok', lastError: null, lastBlockedCommand: null },
    ])
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
    const held: { finish: (result: SendPromptResult) => void } = { finish: () => {} }
    const h = harness({
      turn: () => new Promise<SendPromptResult>((resolve) => void (held.finish = resolve)),
    })

    const first = runRoutineTurn(h.deps, 'r1')
    const second = runRoutineTurn(h.deps, 'r1') // arrives while the first still streams
    // Both confirm their gate first (#469, an await), so wait for the turn to be
    // genuinely in flight rather than assuming it is by this line.
    await vi.waitFor(() => expect(h.prompts).toHaveLength(1))
    held.finish({ ok: true, result: { stopReason: 'end_turn' }, sessionId: 'sess-1' })
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
      {
        lastRunAt: 1_700_000_000_000,
        lastOutcome: 'deferred',
        lastError: expect.any(String),
        lastBlockedCommand: null,
      },
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
      {
        lastRunAt: 1_700_000_000_000,
        lastOutcome: 'failed',
        lastError: 'Context too long.',
        lastBlockedCommand: null,
      },
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

/**
 * The permission gate (#469, ADR-0028 part 4) — the half of a headless turn that
 * decides what a scheduled agent may do with nobody at the keyboard.
 *
 * The three properties the ticket names, and one the design implies: a routine
 * whose gate cannot be confirmed REFUSES TO RUN; the first denial CANCELS the
 * turn; the written error NAMES THE COMMAND; and the Bot gets its own persona back
 * afterwards, so it is not left read-only for the person who talks to it next.
 */
describe('runRoutineTurn — the permission gate', () => {
  /** Drive one permission request through the gate the runner armed. */
  const askFor = (command: string, agent: ReturnType<typeof stubAgent>): void => {
    const frame = (update: Record<string, unknown>): unknown => ({
      method: 'session/update',
      params: { sessionId: 'sess-1', update },
    })
    for (const listener of agent.listeners) {
      listener(
        frame({
          toolCallId: 't1',
          rawInput: { command },
          _meta: { tool_name: 'bash', effect_kind: 'shell' },
          sessionUpdate: 'tool_call_update',
        }),
      )
      listener({
        id: 7,
        method: 'session/request_permission',
        params: {
          sessionId: 'sess-1',
          toolCall: { toolCallId: 't1' },
          options: [
            { optionId: 'allow_once', kind: 'allow_once' },
            { optionId: 'reject_once', kind: 'reject_once' },
          ],
        },
      })
    }
  }

  it('REFUSES TO RUN when the gate cannot be confirmed, and says why', async () => {
    // The single most important behaviour in the slice. An unknown profile key is
    // ignored in silence, so a typo yields a routine that looks configured and
    // gates nothing — running and hoping is the one thing that must not happen.
    const h = harness({
      gate: { ok: false, reason: 'invalid', problems: ['tools.bash.allowlist: it is ["echo"].'] },
    })

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(result.outcome).toBe('failed')
    expect(result.error).toContain('permission gate could not be confirmed')
    expect(result.error).toContain('tools.bash.allowlist')
    // Nothing was prompted, nothing was claimed, no agent was protected.
    expect(h.prompts).toEqual([])
    expect(h.protectionHistory).toEqual([])
    expect(h.status.statusFor('bot-thread').streaming).toBe(false)
    // And it still WROTE something: a routine turn always writes an entry, and a
    // refusal that only lives in a database row is a routine that looks silent.
    expect(h.failures).toEqual([
      {
        threadId: 'bot-thread',
        message: expect.stringContaining('permission gate'),
        prompt: 'Triage this repo and say what changed.',
      },
    ])
  })

  it('selects the routine-only profile for the turn, not the Bot’s own', async () => {
    const h = harness({
      turn: async (_args, gate) => {
        expect(gate.profileId).toBe(GATE_PROFILE_ID)
        return { ok: true, result: { stopReason: 'end_turn' }, sessionId: 'sess-1' }
      },
    })
    expect((await runRoutineTurn(h.deps, 'r1')).outcome).toBe('ok')
  })

  it('puts the Bot’s OWN persona back when the turn ends', async () => {
    // Otherwise the Bot stays gated on that live session: read-only, and asking
    // about every command, the next time a PERSON talks to it.
    const h = harness({
      turn: async (_args, gate, agent) => {
        gate.onSessionBound('sess-1')
        expect((agent as ReturnType<typeof stubAgent>).modes).toEqual([])
        return { ok: true, result: { stopReason: 'end_turn' }, sessionId: 'sess-1' }
      },
    })
    await runRoutineTurn(h.deps, 'r1')
    expect(h.agent.modes).toEqual([BOT_PROFILE_ID])
    expect(h.agent.listeners).toEqual([]) // and it stopped listening
  })

  it('allows a listed command and lets the turn finish', async () => {
    const routine = { ...ROUTINE, allowedCommands: ['gh issue list --state open'] }
    const h = harness({
      routine,
      turn: async (_args, gate, agent) => {
        gate.onSessionBound('sess-1')
        askFor('gh issue list --state open', agent as ReturnType<typeof stubAgent>)
        return { ok: true, result: { stopReason: 'end_turn' }, sessionId: 'sess-1' }
      },
    })

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(result.outcome).toBe('ok')
    expect(h.failures).toEqual([])
  })

  it('THE FIRST DENIAL cancels the turn, and the written error names the command', async () => {
    // Continuing past a denial is what produced #458's fourteen-attempt evasion
    // loop. Stopping is what produces a message a person can act on.
    const cancelled: string[] = []
    const h = harness({
      turn: async (_args, gate, agent) => {
        const stub = agent as ReturnType<typeof stubAgent>
        stub.cancel = (sessionId: string) => void cancelled.push(sessionId)
        gate.onSessionBound('sess-1')
        askFor('echo hello > notes.txt', stub)
        // The cancel resolves the in-flight prompt through the NORMAL
        // turn-complete path, so the turn itself reports success.
        return { ok: true, result: { stopReason: 'cancelled' }, sessionId: 'sess-1' }
      },
    })

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(cancelled).toEqual(['sess-1'])
    expect(result.outcome).toBe('blocked')
    expect(result.error).toContain('`echo hello > notes.txt`')
    expect(result.blockedCommand).toBe('echo hello > notes.txt')
    // Written into the Bot's own conversation through the turn-error tee. The
    // prompt is NOT re-teed: the turn already teed it before it ran.
    expect(h.failures).toEqual([
      { threadId: 'bot-thread', message: expect.stringContaining('echo hello > notes.txt') },
    ])
    // And recorded as STRUCTURE, so slice 5 can offer to add exactly that string.
    expect(h.runs).toEqual([
      {
        lastRunAt: 1_700_000_000_000,
        lastOutcome: 'blocked',
        lastError: expect.stringContaining('echo hello > notes.txt'),
        lastBlockedCommand: 'echo hello > notes.txt',
      },
    ])
  })

  it('blocks a command that is merely NOT LISTED, with the routine named', async () => {
    const h = harness({
      turn: async (_args, gate, agent) => {
        gate.onSessionBound('sess-1')
        askFor('gh pr merge 12', agent as ReturnType<typeof stubAgent>)
        return { ok: true, result: { stopReason: 'cancelled' }, sessionId: 'sess-1' }
      },
    })

    const result = await runRoutineTurn(h.deps, 'r1')

    expect(result.outcome).toBe('blocked')
    expect(result.error).toContain('Morning triage')
    expect(result.error).toContain('`gh pr merge 12`')
    expect(result.blockedCommand).toBe('gh pr merge 12')
  })
})
