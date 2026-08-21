import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BotRecord } from '../../../shared/ipc'
import { useBotLifecycle, type BotLifecycleDeps } from './use-bot-lifecycle'

/**
 * The Bot lifecycle choreography (#447). Driven directly, with fake dispatchers and
 * a stubbed `window.api` — the same shape as `use-workspace-actions.test.ts`.
 *
 * The test that earns the seam is the Start-over ORDER: every step is recorded into
 * one log, so "refresh the metadata BEFORE re-hosting and remounting" is asserted
 * rather than assumed. Get it wrong and the remounted view re-seeds the session the
 * user just asked to leave behind — which no type and no reviewer would catch.
 */

const BOT: BotRecord = {
  threadId: 'thread-rex',
  workspaceId: 'ws-1',
  profileId: 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Rex',
  colour: '#e8734a',
  description: '',
  instructions: '',
  createdAt: 10,
  updatedAt: 20,
}

interface Harness {
  deps: BotLifecycleDeps
  log: string[]
  errors: Array<{ threadId: string; message: string } | null>
}

function harness(overrides: Partial<BotLifecycleDeps> = {}): Harness {
  const log: string[] = []
  const errors: Harness['errors'] = []
  const deps: BotLifecycleDeps = {
    connections: { 'ws-1': { status: 'connected' } as never },
    navDispatch: vi.fn((action) => log.push(`nav:${action.type}`)),
    wtDispatch: vi.fn((action) => log.push(`wt:${action.type}`)),
    setConversationEpochs: vi.fn(() => log.push('epoch:bump')),
    refreshBots: vi.fn(() => log.push('refresh:bots')),
    refreshRecents: vi.fn(async () => {
      log.push('refresh:recents')
    }),
    selectThreadInWorkspace: vi.fn(() => log.push('select:thread')),
    continueColdThread: vi.fn(async () => {
      log.push('continue:cold')
    }),
    setActionError: vi.fn((error) => {
      errors.push(error)
      if (error) log.push('error:shown')
    }),
    ...overrides,
  }
  return { deps, log, errors }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('startOver', () => {
  it('refreshes the metadata BEFORE re-hosting and remounting', async () => {
    vi.stubGlobal('window', { api: { botsStartOver: vi.fn(async () => ({ ok: true })) } })
    const h = harness()

    await useBotLifecycle(h.deps).startOver({ threadId: BOT.threadId, name: BOT.name }, 'ws-1')

    // The cleared cursor must be in `recents` before anything re-seeds from it, and
    // `remove` (which drops the bound session) must precede `open`.
    expect(h.log).toEqual(['refresh:recents', 'wt:remove', 'wt:open', 'epoch:bump'])
  })

  it('shows a refusal instead of changing anything', async () => {
    vi.stubGlobal('window', {
      api: { botsStartOver: vi.fn(async () => ({ ok: false, reason: 'streaming' })) },
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness()

    await useBotLifecycle(h.deps).startOver({ threadId: BOT.threadId, name: BOT.name }, 'ws-1')

    expect(h.log).toEqual(['error:shown'])
    expect(h.errors.at(-1)).toEqual({
      threadId: BOT.threadId,
      message: expect.stringContaining('Rex'),
    })
    expect(errorSpy).toHaveBeenCalled() // logged AND surfaced, not one or the other
  })

  it('clears a previous refusal when the user tries again', async () => {
    vi.stubGlobal('window', { api: { botsStartOver: vi.fn(async () => ({ ok: true })) } })
    const h = harness()

    await useBotLifecycle(h.deps).startOver({ threadId: BOT.threadId, name: BOT.name }, 'ws-1')

    expect(h.errors[0]).toBeNull()
  })
})

describe('createBot', () => {
  it('opens the new Bot through the ordinary selection on a connected Project', async () => {
    vi.stubGlobal('window', {
      api: { botsCreate: vi.fn(async () => ({ ok: true, bot: BOT })) },
    })
    const h = harness()

    const result = await useBotLifecycle(h.deps).createBot({
      workspaceId: 'ws-1',
      name: 'Rex',
      colour: '#e8734a',
    })

    expect(result.ok).toBe(true)
    expect(h.log).toEqual(['refresh:bots', 'refresh:recents', 'select:thread'])
  })

  it('continues a never-connected Project on the Bot\'s own Thread', async () => {
    // The row is not in the caller's captured metadata yet, so the cold path is
    // handed a meta built from the record instead of looking one up.
    vi.stubGlobal('window', {
      api: { botsCreate: vi.fn(async () => ({ ok: true, bot: BOT })) },
    })
    const h = harness({ connections: {} })

    await useBotLifecycle(h.deps).createBot({ workspaceId: 'ws-1', name: 'Rex', colour: '#e8734a' })

    expect(h.log).toEqual(['refresh:bots', 'refresh:recents', 'continue:cold'])
    expect(h.deps.continueColdThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: BOT.threadId, workspaceId: 'ws-1', sessionId: null }),
    )
  })

  it('changes nothing when main refuses, so the form can keep what was typed', async () => {
    vi.stubGlobal('window', {
      api: {
        botsCreate: vi.fn(async () => ({ ok: false, reason: 'invalid', problems: ['name: nope'] })),
      },
    })
    const h = harness()

    const result = await useBotLifecycle(h.deps).createBot({
      workspaceId: 'ws-1',
      name: '',
      colour: '#e8734a',
    })

    expect(result).toEqual({ ok: false, reason: 'invalid', problems: ['name: nope'] })
    expect(h.log).toEqual([])
  })
})

describe('saveBot', () => {
  it('re-reads both lists so the rename lands in the sidebar and in Search', async () => {
    vi.stubGlobal('window', {
      api: { botsUpdate: vi.fn(async () => ({ ok: true, bot: { ...BOT, name: 'Rexi' } })) },
    })
    const h = harness()

    await useBotLifecycle(h.deps).saveBot({ threadId: BOT.threadId, name: 'Rexi' })

    expect(h.log).toEqual(['refresh:bots', 'refresh:recents'])
  })
})

describe('deleteBot', () => {
  it('lands back on the now-ordinary conversation and reports no problems', async () => {
    vi.stubGlobal('window', { api: { botsDelete: vi.fn(async () => ({ ok: true })) } })
    const h = harness()

    const problems = await useBotLifecycle(h.deps).deleteBot(BOT)

    expect(problems).toEqual([])
    expect(h.log).toEqual(['refresh:bots', 'refresh:recents', 'select:thread'])
  })

  it('returns something to SHOW when the delete fails, and changes nothing', async () => {
    vi.stubGlobal('window', { api: { botsDelete: vi.fn(async () => ({ ok: false })) } })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const h = harness()

    const problems = await useBotLifecycle(h.deps).deleteBot(BOT)

    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('Rex')
    expect(h.log).toEqual([])
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe('openForm', () => {
  it('carries the target INTO nav, so a history entry knows which form it was', () => {
    const h = harness()
    useBotLifecycle(h.deps).openForm({ mode: 'edit', threadId: BOT.threadId })

    expect(h.deps.navDispatch).toHaveBeenCalledWith({
      type: 'open-bot-form',
      target: { mode: 'edit', threadId: BOT.threadId },
    })
  })
})
