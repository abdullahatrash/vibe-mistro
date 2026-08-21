import { describe, it, expect } from 'vitest'
import type { BotRecord, ListMetadataResult } from '../../shared/ipc'
import { botNamesByThread, markBotThreads } from './mark-bot-threads'
import { searchThreads } from '../search/search-threads'

function workspaces(): ListMetadataResult {
  return [
    {
      id: 'ws-1',
      dir: '/tmp/one',
      displayName: 'one',
      lastOpenedAt: 10,
      threads: [
        { id: 't-bot', workspaceId: 'ws-1', sessionId: null, title: 'Fix the parser', createdAt: 1, lastActiveAt: 9 },
        { id: 't-plain', workspaceId: 'ws-1', sessionId: null, title: 'chore', createdAt: 1, lastActiveAt: 8 },
      ],
    },
    {
      id: 'ws-2',
      dir: '/tmp/two',
      displayName: 'two',
      lastOpenedAt: 5,
      threads: [
        { id: 't-other', workspaceId: 'ws-2', sessionId: null, title: 'other', createdAt: 1, lastActiveAt: 4 },
      ],
    },
  ]
}

function botRecord(threadId: string): BotRecord {
  return {
    threadId,
    workspaceId: 'ws-1',
    profileId: 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'Rex',
    colour: '#e8734a',
    description: 'reviews my changes',
    instructions: 'Be blunt.',
    createdAt: 1,
    updatedAt: 2,
  }
}

describe('markBotThreads', () => {
  it('flags a Bot Thread and leaves every ordinary Thread untouched', () => {
    const marked = markBotThreads(workspaces(), botNamesByThread([botRecord('t-bot')]))
    const [first, second] = marked
    expect(first?.threads[0]?.bot).toEqual({ name: 'Rex' })
    expect(first?.threads[1]?.bot).toBeUndefined()
    expect(second?.threads[0]?.bot).toBeUndefined()
  })

  it('NEVER drops a row — the marked snapshot is the same shape as the input', () => {
    // The whole point (ADR-0027): a filter here would delete Bots from Search too.
    const input = workspaces()
    const marked = markBotThreads(input, botNamesByThread([botRecord('t-bot')]))
    expect(marked.map((w) => w.threads.map((t) => t.id))).toEqual(
      input.map((w) => w.threads.map((t) => t.id)),
    )
  })

  it('returns the input untouched when there are no Bots', () => {
    const input = workspaces()
    expect(markBotThreads(input, botNamesByThread([]))).toBe(input)
  })

  it('leaves a Workspace with no Bot in it referentially unchanged', () => {
    const input = workspaces()
    const marked = markBotThreads(input, botNamesByThread([botRecord('t-bot')]))
    expect(marked[1]).toBe(input[1])
  })

  it('does not mutate the snapshot it was given', () => {
    const input = workspaces()
    markBotThreads(input, botNamesByThread([botRecord('t-bot')]))
    expect(input[0]?.threads[0]?.bot).toBeUndefined()
  })
})

describe('the Thread-list / Search split (#446)', () => {
  const marked = markBotThreads(workspaces(), botNamesByThread([botRecord('t-bot')]))

  it('Search finds a Bot by its NAME — not by the title Vibe generated', () => {
    const hits = searchThreads(marked, 'Rex')
    expect(hits.map((h) => h.threadId)).toContain('t-bot')
    expect(hits.find((h) => h.threadId === 't-bot')?.botName).toBe('Rex')
  })

  it('Search keeps a Bot in the RESTING recents (a switcher lists what you switch to)', () => {
    const resting = searchThreads(marked, '')
    expect(resting.map((h) => h.threadId)).toContain('t-bot')
    expect(resting.find((h) => h.threadId === 't-bot')?.botName).toBe('Rex')
  })

  it('reports an ordinary Thread with no bot identity at all', () => {
    const hit = searchThreads(marked, 'chore').find((h) => h.threadId === 't-plain')
    expect(hit?.botName).toBeUndefined()
  })

  it('demotes a Bot Thread title without making it unsearchable', () => {
    // The name takes the title tier, but the Vibe-generated title still joins the
    // haystack — so it ranks lower than a name match rather than vanishing.
    const hits = searchThreads(marked, 'Fix the parser')
    expect(hits.map((h) => h.threadId)).toContain('t-bot')
  })

  it('still finds a Bot by what was SAID in it (the prose half, PRD story 11)', () => {
    const prose = new Map([
      ['t-bot', [{ index: 0, text: 'we decided to keep the parser as it is', itemId: 'u-1' }]],
    ])
    const hits = searchThreads(marked, 'parser', 20, prose)
    expect(hits.map((h) => h.threadId)).toContain('t-bot')
    expect(hits.find((h) => h.threadId === 't-bot')?.snippet).toContain('parser')
  })
})
