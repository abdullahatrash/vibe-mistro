import { describe, it, expect } from 'vitest'
import type { BotRecord, ListMetadataResult } from '../../../shared/ipc'
import type { ThreadStatusMap } from '../conversation/thread-status'
import { deriveBotRows, isBotUnread } from './bot-rows'

function bot(name: string, threadId: string, updatedAt = 100): BotRecord {
  return {
    threadId,
    workspaceId: 'ws-1',
    profileId: `mistro-bot-${threadId}`,
    name,
    colour: '#e8734a',
    description: '',
    instructions: '',
    createdAt: 1,
    updatedAt,
  }
}

function workspaces(threads: Array<{ id: string; lastActiveAt: number }>): ListMetadataResult {
  return [
    {
      id: 'ws-1',
      dir: '/tmp/one',
      displayName: 'one',
      lastOpenedAt: 1,
      threads: threads.map((t) => ({
        id: t.id,
        workspaceId: 'ws-1',
        sessionId: null,
        title: null,
        createdAt: 1,
        lastActiveAt: t.lastActiveAt,
        bot: { name: t.id },
      })),
    },
  ]
}

const noStatus: ThreadStatusMap = {}

describe('deriveBotRows — ordering', () => {
  it('orders most-recently-ACTIVE first, from the Thread not the record', () => {
    // Rex was EDITED last (updatedAt 900) but Ada was SPOKEN TO last. PRD story 5
    // asks who I spoke to most recently, so Ada leads.
    const rows = deriveBotRows({
      bots: [bot('Rex', 't-rex', 900), bot('Ada', 't-ada', 100)],
      workspaces: workspaces([
        { id: 't-rex', lastActiveAt: 10 },
        { id: 't-ada', lastActiveAt: 50 },
      ]),
      statuses: noStatus,
      seen: {},
      selectedThreadId: null,
    })
    expect(rows.map((r) => r.bot.name)).toEqual(['Ada', 'Rex'])
  })

  it('breaks ties on name so the section never jitters', () => {
    const rows = deriveBotRows({
      bots: [bot('Zed', 't-z'), bot('Ada', 't-a')],
      workspaces: workspaces([
        { id: 't-z', lastActiveAt: 5 },
        { id: 't-a', lastActiveAt: 5 },
      ]),
      statuses: noStatus,
      seen: {},
      selectedThreadId: null,
    })
    expect(rows.map((r) => r.bot.name)).toEqual(['Ada', 'Zed'])
  })

  it('falls back to the record timestamp for a Bot whose Thread is not listed yet', () => {
    const rows = deriveBotRows({
      bots: [bot('Rex', 't-rex', 777)],
      workspaces: workspaces([]),
      statuses: noStatus,
      seen: {},
      selectedThreadId: null,
    })
    expect(rows[0]?.lastActiveAt).toBe(777)
  })

  it('drops a Bot whose Project is gone — a row that cannot be opened is worse than none', () => {
    const orphan = { ...bot('Ghost', 't-ghost'), workspaceId: 'ws-removed' }
    const rows = deriveBotRows({
      bots: [orphan, bot('Rex', 't-rex')],
      workspaces: workspaces([{ id: 't-rex', lastActiveAt: 1 }]),
      statuses: noStatus,
      seen: {},
      selectedThreadId: null,
    })
    expect(rows.map((r) => r.bot.name)).toEqual(['Rex'])
  })

  it('is empty when there are no Bots', () => {
    expect(
      deriveBotRows({
        bots: [],
        workspaces: workspaces([]),
        statuses: noStatus,
        seen: {},
        selectedThreadId: null,
      }),
    ).toEqual([])
  })
})

describe('deriveBotRows — live flags', () => {
  it('carries streaming and needsAttention from the status registry', () => {
    const statuses: ThreadStatusMap = {
      't-rex': { streaming: true, needsAttention: false },
      't-ada': { streaming: false, needsAttention: true },
    }
    const rows = deriveBotRows({
      bots: [bot('Rex', 't-rex'), bot('Ada', 't-ada')],
      workspaces: workspaces([
        { id: 't-rex', lastActiveAt: 2 },
        { id: 't-ada', lastActiveAt: 1 },
      ]),
      statuses,
      seen: { 't-rex': 99, 't-ada': 99 },
      selectedThreadId: null,
    })
    expect(rows.find((r) => r.bot.name === 'Rex')).toMatchObject({ streaming: true })
    expect(rows.find((r) => r.bot.name === 'Ada')).toMatchObject({ needsAttention: true })
  })

  it('defaults both flags to false for a Bot with no status entry', () => {
    const rows = deriveBotRows({
      bots: [bot('Rex', 't-rex')],
      workspaces: workspaces([{ id: 't-rex', lastActiveAt: 1 }]),
      statuses: noStatus,
      seen: { 't-rex': 99 },
      selectedThreadId: null,
    })
    expect(rows[0]).toMatchObject({ streaming: false, needsAttention: false, unread: false })
  })
})

describe('isBotUnread', () => {
  it('is unread when the Bot moved since it was last opened', () => {
    expect(isBotUnread({ lastActiveAt: 20, seenAt: 10, needsAttention: false, selected: false })).toBe(true)
  })

  it('is read when nothing happened since it was last opened', () => {
    expect(isBotUnread({ lastActiveAt: 10, seenAt: 10, needsAttention: false, selected: false })).toBe(false)
  })

  it('is unread when never opened', () => {
    expect(isBotUnread({ lastActiveAt: 1, seenAt: undefined, needsAttention: false, selected: false })).toBe(true)
  })

  it('is unread whenever it needs an answer, read or not', () => {
    expect(isBotUnread({ lastActiveAt: 1, seenAt: 99, needsAttention: true, selected: false })).toBe(true)
  })

  it('is never unread while it is the Bot on screen', () => {
    expect(isBotUnread({ lastActiveAt: 99, seenAt: 0, needsAttention: true, selected: true })).toBe(false)
  })
})
