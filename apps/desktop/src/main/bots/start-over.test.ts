import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BotRecord } from '../../shared/ipc'
import { startOverBot, type StartOverDeps } from './start-over'

/**
 * "Start over" (#447, ADR-0027). The tests are written around what it must NOT do:
 * a pressure valve that quietly cost a user their teammate's name, its persona
 * files or weeks of readable history would be the worst button in the app.
 */

const BOT: BotRecord = {
  threadId: 'thread-rex',
  workspaceId: 'ws-1',
  profileId: 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Rex',
  colour: '#e8734a',
  description: 'Reviews my changes',
  instructions: 'Be blunt about correctness.',
  createdAt: 1,
  updatedAt: 2,
}

interface Harness {
  deps: StartOverDeps
  cleared: string[]
  closed: number
  streaming: Set<string>
  clearFailure: boolean
  closeFailure: boolean
}

function harness(bot: BotRecord | null = BOT): Harness {
  const h: Harness = {
    cleared: [],
    closed: 0,
    streaming: new Set(),
    clearFailure: false,
    closeFailure: false,
    deps: {} as StartOverDeps,
  }
  h.deps = {
    bots: { get: (threadId) => (bot && bot.threadId === threadId ? bot : null) },
    threads: {
      clearThreadSession: async (id) => {
        if (h.clearFailure) throw new Error('disk full')
        h.cleared.push(id)
      },
    },
    isStreaming: (threadId) => h.streaming.has(threadId),
    closeSession: async () => {
      h.closed += 1
      if (h.closeFailure) throw new Error('agent gone')
    },
  }
  return h
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('startOverBot', () => {
  it('retires the session cursor so the next prompt mints a fresh session', async () => {
    const h = harness()
    const result = await startOverBot(h.deps, { threadId: BOT.threadId })

    expect(result).toEqual({ ok: true })
    expect(h.cleared).toEqual([BOT.threadId])
  })

  it('closes the retired session on the warm agent that hosts it', async () => {
    const h = harness()
    await startOverBot(h.deps, { threadId: BOT.threadId })

    expect(h.closed).toBe(1)
  })

  it('succeeds with no session to close (a cold Bot)', async () => {
    const h = harness()
    delete h.deps.closeSession
    await expect(startOverBot(h.deps, { threadId: BOT.threadId })).resolves.toEqual({ ok: true })
    expect(h.cleared).toEqual([BOT.threadId])
  })

  it('still succeeds when closing the retired session fails — the cursor is already gone', async () => {
    const h = harness()
    h.closeFailure = true

    await expect(startOverBot(h.deps, { threadId: BOT.threadId })).resolves.toEqual({ ok: true })
    expect(errorSpy).toHaveBeenCalled() // logged, never swallowed
  })

  it('refuses a Thread that is not a Bot', async () => {
    const h = harness(null)
    const result = await startOverBot(h.deps, { threadId: 'some-ordinary-thread' })

    expect(result).toEqual({ ok: false, reason: 'notFound' })
    expect(h.cleared).toEqual([])
  })

  it('refuses mid-turn — retiring a session under a running turn would strand it', async () => {
    const h = harness()
    h.streaming.add(BOT.threadId)

    const result = await startOverBot(h.deps, { threadId: BOT.threadId })

    expect(result).toEqual({ ok: false, reason: 'streaming' })
    expect(h.cleared).toEqual([])
    expect(h.closed).toBe(0)
  })

  it('reports a failed clear instead of closing a session the Thread would still resume', async () => {
    const h = harness()
    h.clearFailure = true

    const result = await startOverBot(h.deps, { threadId: BOT.threadId })

    expect(result).toEqual({ ok: false, reason: 'io' })
    expect(h.closed).toBe(0)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('never touches the record or the profile files — the Bot keeps its identity', async () => {
    // The deps this module is given carry NO profile writer and NO bot mutator, so
    // "does not touch them" is enforced by the type, not by a spy. This test pins
    // that the shape stays that way: `StartOverDeps` may only read the Bot.
    const h = harness()
    await startOverBot(h.deps, { threadId: BOT.threadId })

    expect(Object.keys(h.deps).sort()).toEqual(['bots', 'closeSession', 'isStreaming', 'threads'])
    expect(Object.keys(h.deps.bots)).toEqual(['get'])
  })
})
