import { describe, expect, it } from 'vitest'
import {
  runPromptTurn,
  type PromptTurnAgent,
  type PromptTurnDeps,
  type PromptTurnDelivery,
} from './prompt-turn'
import { WorkspaceAgentError } from './workspace-agent'
import type { SendPromptArgs, ThreadInfo, TranscriptEntry } from '../shared/ipc'

/**
 * One prompt turn, with and without a renderer behind it (#468, ADR-0028).
 *
 * The property this file exists for: **a pre-bind failure writes an entry and
 * touches the Thread on the HEADLESS path, and the user-initiated path is
 * unchanged.** #456 found that an agent that will not spawn, a failed `session/new`
 * and a failed resume all returned from the catch before touching the Thread — the
 * right answer for a user at the composer (who sees the error there, and should not
 * also get a transcript entry for it) and pure silence for a Routine.
 *
 * Everything is driven through injected fakes — no Electron, no `vibe-acp`, no
 * database.
 */

interface Teed {
  threadId: string | null
  entry: TranscriptEntry
}

interface Harness {
  deps: PromptTurnDeps
  teed: Teed[]
  touched: string[]
  sent: Array<{ channel: string; payload: unknown }>
  renderer: PromptTurnDelivery
  headless: PromptTurnDelivery
}

function harness(): Harness {
  const teed: Teed[] = []
  const touched: string[] = []
  const sent: Array<{ channel: string; payload: unknown }> = []
  return {
    teed,
    touched,
    sent,
    renderer: {
      kind: 'renderer',
      sender: {
        isDestroyed: () => false,
        send: (channel, payload) => void sent.push({ channel, payload }),
      },
    },
    headless: { kind: 'headless' },
    deps: {
      store: {
        upsertThread: async (input) => ({
          id: input.id ?? 'minted',
          workspaceId: input.workspaceId,
          sessionId: input.sessionId ?? null,
          title: null,
          createdAt: 0,
          lastActiveAt: 0,
        }),
        snapshot: () => ({ workspaces: [], threads: [] }),
        deleteThread: async () => {},
        touchThread: async (id) => void touched.push(id),
      },
      bridge: {
        bind: () => {},
        tee: (threadId, entry) => void teed.push({ threadId, entry }),
        isTombstoned: () => false,
      },
      bots: { get: () => null },
      attachments: null,
    },
  }
}

const session: ThreadInfo = {
  sessionId: 's1',
  title: null,
  modes: null,
  models: null,
  reasoningEffort: null,
}

/**
 * A fake agent. `openThread` mints (or rejects with `openError`), `prompt` resolves
 * (or rejects with `promptError`); the session it mints is hosted afterwards, like
 * a real one.
 */
function fakeAgent(
  opts: { openError?: unknown; promptError?: unknown; startError?: unknown } = {},
): PromptTurnAgent & { prompts: number; starts: number } {
  const hosted = new Set<string>()
  return {
    prompts: 0,
    starts: 0,
    authMethods: [],
    primarySessionControls: null,
    loadSessionAvailable: true,
    consumePrimarySession: () => null,
    hasSession: (id) => hosted.has(id),
    async loadThread(): Promise<ThreadInfo> {
      throw new Error('loadThread not expected here')
    },
    async openThread(): Promise<ThreadInfo> {
      if (opts.openError) throw opts.openError
      hosted.add(session.sessionId)
      return session
    },
    async start(): Promise<void> {
      this.starts++
      if (opts.startError) throw opts.startError
    },
    async setMode(): Promise<void> {},
    async setModel(): Promise<void> {},
    async setReasoningEffort(): Promise<void> {},
    async prompt() {
      this.prompts++
      if (opts.promptError) throw opts.promptError
      return { stopReason: 'end_turn' }
    },
  }
}

/** A Bot's turn: a draft-shaped first prompt (the bind is what we are testing). */
function args(over: Partial<SendPromptArgs> = {}): SendPromptArgs {
  return {
    agentId: 'a1',
    threadId: 'bot-thread',
    workspaceId: 'w1',
    sessionId: null,
    text: 'Triage the repo and say what changed.',
    ...over,
  }
}

describe('runPromptTurn — a pre-bind failure with nobody watching (#468)', () => {
  it('tees the attempted prompt AND the failure, and touches the Thread', async () => {
    const h = harness()
    const agent = fakeAgent({ openError: new WorkspaceAgentError('vibe-acp is not installed.') })

    const result = await runPromptTurn(h.deps, h.headless, agent, args())

    expect(result).toEqual({ ok: false, kind: 'error', error: 'vibe-acp is not installed.' })
    // Prompt then failure — the same pair a post-bind failure writes, so the Bot's
    // conversation reads the same either side of the bind.
    expect(h.teed.map((t) => t.entry.t)).toEqual(['user-prompt', 'turn-error'])
    expect(h.teed[0].entry).toMatchObject({ text: 'Triage the repo and say what changed.' })
    expect(h.teed[1].entry).toMatchObject({ message: 'vibe-acp is not installed.' })
    expect(h.teed.every((t) => t.threadId === 'bot-thread')).toBe(true)
    // ADR-0028's notifier is the unread dot, which is `lastActiveAt` moving.
    expect(h.touched).toEqual(['bot-thread'])
  })

  it('reports a sign-in expiry into the conversation too, and keeps the typed result', async () => {
    const h = harness()
    const expired = new WorkspaceAgentError('Session expired.', null, 'not-signed-in')
    const agent = fakeAgent({ openError: expired })

    const result = await runPromptTurn(h.deps, h.headless, agent, args())

    expect(result).toMatchObject({ ok: false, kind: 'not-signed-in', agentId: 'a1' })
    expect(h.teed.map((t) => t.entry.t)).toEqual(['user-prompt', 'turn-error'])
    expect(h.touched).toEqual(['bot-thread'])
  })

  it('reports an agent that will not spawn — the case that used to escape entirely', async () => {
    const h = harness()
    const agent = fakeAgent({ startError: new WorkspaceAgentError('Could not start vibe-acp.') })

    const result = await runPromptTurn(h.deps, h.headless, agent, args())

    expect(result).toEqual({ ok: false, kind: 'error', error: 'Could not start vibe-acp.' })
    expect(h.teed.map((t) => t.entry.t)).toEqual(['user-prompt', 'turn-error'])
    expect(h.touched).toEqual(['bot-thread'])
  })

  it('starts the agent itself, because a Routine warms a Workspace nobody selected', async () => {
    const h = harness()
    const agent = fakeAgent()
    await runPromptTurn(h.deps, h.headless, agent, args())
    expect(agent.starts).toBe(1)
  })

  it('never sends thread:bound — a headless turn has no live view to bind', async () => {
    const h = harness()
    await runPromptTurn(h.deps, h.headless, fakeAgent(), args())
    expect(h.sent).toEqual([])
  })
})

describe('runPromptTurn — the user-initiated path is UNCHANGED (#468)', () => {
  it('leaves NO transcript residue for a pre-bind failure (the composer shows it)', async () => {
    const h = harness()
    const agent = fakeAgent({ openError: new WorkspaceAgentError('vibe-acp is not installed.') })

    const result = await runPromptTurn(h.deps, h.renderer, agent, args())

    expect(result).toEqual({ ok: false, kind: 'error', error: 'vibe-acp is not installed.' })
    expect(h.teed).toEqual([]) // no duplicate of what the composer already renders
    expect(h.touched).toEqual([]) // and a failed first prompt is not activity
  })

  it('does NOT re-start the agent — `startThread` already handshook it', async () => {
    const h = harness()
    const agent = fakeAgent()
    await runPromptTurn(h.deps, h.renderer, agent, args())
    expect(agent.starts).toBe(0)
  })

  it('still sends thread:bound on a successful bind', async () => {
    const h = harness()
    await runPromptTurn(h.deps, h.renderer, fakeAgent(), args())
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].payload).toMatchObject({ threadId: 'bot-thread', sessionId: 's1', rebound: false })
  })

  it('skips thread:bound when the window went away mid-turn', async () => {
    const h = harness()
    const gone: PromptTurnDelivery = {
      kind: 'renderer',
      sender: { isDestroyed: () => true, send: () => void h.sent.push({ channel: 'x', payload: null }) },
    }
    await runPromptTurn(h.deps, gone, fakeAgent(), args())
    expect(h.sent).toEqual([])
  })
})

describe('runPromptTurn — the turn itself does not care who is watching', () => {
  it('tees prompt then turn-complete and touches the Thread, headless', async () => {
    const h = harness()
    const agent = fakeAgent()

    const result = await runPromptTurn(h.deps, h.headless, agent, args())

    expect(result).toEqual({ ok: true, result: { stopReason: 'end_turn' }, sessionId: 's1' })
    expect(agent.prompts).toBe(1)
    expect(h.teed.map((t) => t.entry.t)).toEqual(['user-prompt', 'turn-complete'])
    expect(h.touched).toEqual(['bot-thread'])
  })

  it('tees a POST-bind failure exactly as it always did, and carries the code', async () => {
    const h = harness()
    const agent = fakeAgent({ promptError: new WorkspaceAgentError('Context too long.', null, null, -31004) })

    const result = await runPromptTurn(h.deps, h.headless, agent, args())

    expect(result).toEqual({ ok: false, kind: 'error', error: 'Context too long.', code: -31004 })
    expect(h.teed.map((t) => t.entry.t)).toEqual(['user-prompt', 'turn-error'])
    // Touched ONCE: the pre-bind reporter must not double-count a turn that bound.
    expect(h.touched).toEqual(['bot-thread'])
  })

  it('writes the same entries either side of the delivery seam for a bound turn', async () => {
    const withRenderer = harness()
    const withoutRenderer = harness()
    await runPromptTurn(withRenderer.deps, withRenderer.renderer, fakeAgent(), args())
    await runPromptTurn(withoutRenderer.deps, withoutRenderer.headless, fakeAgent(), args())

    expect(withoutRenderer.teed.map((t) => t.entry.t)).toEqual(withRenderer.teed.map((t) => t.entry.t))
  })
})

/**
 * The routine permission gate on a headless turn (#469, ADR-0028 part 4).
 *
 * Two properties, and both are about REFUSING rather than about running: a turn
 * whose gate profile cannot be selected must not be sent at all, and the answerer
 * must be listening before it is.
 */
describe('runPromptTurn — the routine gate (#469)', () => {
  const GATE_PROFILE = 'mistro-routine-11111111-2222-3333-4444-555555555555'

  function gated(over: Partial<{ onSessionBound: (sessionId: string) => void }> = {}): {
    delivery: PromptTurnDelivery
    bound: string[]
  } {
    const bound: string[] = []
    return {
      bound,
      delivery: {
        kind: 'headless',
        gate: {
          profileId: GATE_PROFILE,
          onSessionBound: (sessionId) => {
            bound.push(sessionId)
            over.onSessionBound?.(sessionId)
          },
        },
      },
    }
  }

  it('selects the gate profile before prompting, and reports the bound session', async () => {
    const h = harness()
    const agent = fakeAgent()
    const modes: string[] = []
    agent.setMode = async (_sessionId: string, modeId: string) => void modes.push(modeId)
    const { delivery, bound } = gated()

    const result = await runPromptTurn(h.deps, delivery, agent, args())

    expect(result.ok).toBe(true)
    expect(modes).toEqual([GATE_PROFILE])
    // Reported before the prompt — the only window in which the answerer can be
    // armed, since permission requests only arrive during `session/prompt`.
    expect(bound).toEqual(['s1'])
  })

  it('REFUSES the turn when the gate profile cannot be selected', async () => {
    // `setMode` routes through the validating `session/set_config_option`, so a
    // rejection means the session does not offer the profile — the gate is not on.
    // A routine that cannot be gated must not be prompted at all.
    const h = harness()
    const agent = fakeAgent()
    agent.setMode = async () => {
      throw new Error('-32602 unknown mode')
    }
    const { delivery, bound } = gated()

    const result = await runPromptTurn(h.deps, delivery, agent, args())

    expect(result).toMatchObject({ ok: false, kind: 'error' })
    expect((result as { error: string }).error).toContain('permission gate')
    expect(agent.prompts).toBe(0) // nothing was ever sent to the agent
    expect(bound).toEqual([]) // and nothing was armed
    // It still WRITES: the attempted prompt and the reason land in the Bot's own
    // conversation, like every other headless pre-bind failure.
    expect(h.teed.map((t) => t.entry.t)).toEqual(['user-prompt', 'turn-error'])
    expect(h.touched).toEqual(['bot-thread'])
  })

  it('leaves an UNGATED headless turn exactly as it was', async () => {
    const h = harness()
    const agent = fakeAgent()
    const modes: string[] = []
    agent.setMode = async (_sessionId: string, modeId: string) => void modes.push(modeId)

    await runPromptTurn(h.deps, h.headless, agent, args())

    // No Bot record in this harness, so no persona and no gate: nothing selected.
    expect(modes).toEqual([])
    expect(agent.prompts).toBe(1)
  })
})

/**
 * The live echo of a headless turn (#471): the entries this turn writes reach a
 * window that happens to be watching, instead of appearing only on the next reopen.
 */
describe('runPromptTurn — a headless turn that IS being watched', () => {
  function echoing(h: Harness): { delivery: PromptTurnDelivery; echoed: Teed[] } {
    const echoed: Teed[] = []
    return {
      delivery: {
        kind: 'headless',
        routine: { name: 'Morning triage' },
        // Production hands `createTranscriptEcho`, which tees AND pushes; the fake
        // does both too, so the ordering assertions below are the real ordering.
        echo: (threadId, entry) => {
          h.deps.bridge.tee(threadId, entry)
          echoed.push({ threadId, entry })
        },
      },
      echoed,
    }
  }

  it('echoes the prompt (with its routine chip) and the turn end, in log order', async () => {
    const h = harness()
    const { delivery, echoed } = echoing(h)

    await runPromptTurn(h.deps, delivery, fakeAgent(), args())

    expect(echoed.map((e) => e.entry.t)).toEqual(['user-prompt', 'turn-complete'])
    expect(echoed[0].entry).toMatchObject({ t: 'user-prompt', routine: { name: 'Morning triage' } })
    // The echo REPLACES the tee rather than doubling it: one copy per entry.
    expect(h.teed.map((e) => e.entry.t)).toEqual(['user-prompt', 'turn-complete'])
  })

  it('echoes a pre-bind failure, the case a watcher would otherwise see as silence', async () => {
    const h = harness()
    const { delivery, echoed } = echoing(h)

    await runPromptTurn(h.deps, delivery, fakeAgent({ openError: new Error('no session') }), args())

    expect(echoed.map((e) => e.entry.t)).toEqual(['user-prompt', 'turn-error'])
  })

  it('still writes everything when nobody is watching — the echo is additive', async () => {
    const h = harness()

    await runPromptTurn(h.deps, h.headless, fakeAgent(), args())

    expect(h.teed.map((e) => e.entry.t)).toEqual(['user-prompt', 'turn-complete'])
  })
})
