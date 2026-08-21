import { describe, it, expect } from 'vitest'
import type { ThreadMeta } from '../../../shared/ipc'
import type { UnifiedThreadRow } from '../shell/unified-threads'
import {
  botNamesInRows,
  botNamesInThreads,
  describeBotDestruction,
  formatBotNames,
} from './bot-destruction'

function meta(id: string, botName?: string): ThreadMeta {
  return {
    id,
    workspaceId: 'ws-1',
    sessionId: null,
    title: null,
    createdAt: 0,
    lastActiveAt: 0,
    ...(botName ? { bot: { name: botName } } : {}),
  }
}

function row(id: string, botName?: string): UnifiedThreadRow {
  return { thread: meta(id, botName), live: false, streaming: false, needsAttention: false }
}

describe('botNamesInRows', () => {
  it('names only the Bot rows, in row order', () => {
    expect(botNamesInRows([row('a'), row('rex', 'Rex'), row('b'), row('ada', 'Ada')])).toEqual([
      'Rex',
      'Ada',
    ])
  })

  it('is empty for a project with no Bots', () => {
    expect(botNamesInRows([row('a'), row('b')])).toEqual([])
  })
})

describe('botNamesInThreads', () => {
  it('reads the same flag off raw metas', () => {
    expect(botNamesInThreads([meta('a'), meta('rex', 'Rex')])).toEqual(['Rex'])
  })
})

describe('formatBotNames', () => {
  it('reads as a sentence at every size', () => {
    expect(formatBotNames(['Rex'])).toBe('Rex')
    expect(formatBotNames(['Rex', 'Ada'])).toBe('Rex and Ada')
    expect(formatBotNames(['Rex', 'Ada', 'Kim'])).toBe('Rex, Ada and Kim')
  })

  it('names all four rather than saying "and 1 more" — the boundary the cap exists for', () => {
    expect(formatBotNames(['Rex', 'Ada', 'Kim', 'Lou'])).toBe('Rex, Ada, Kim and Lou')
  })

  it('counts the rest rather than turning the confirm into a list', () => {
    expect(formatBotNames(['Rex', 'Ada', 'Kim', 'Lou', 'Max'])).toBe('Rex, Ada, Kim and 2 more')
  })

  it('never emits "and 1 more" at any size', () => {
    const names = Array.from({ length: 12 }, (_, i) => `Bot ${i + 1}`)
    for (let count = 1; count <= names.length; count += 1) {
      expect(formatBotNames(names.slice(0, count))).not.toContain('and 1 more')
    }
  })
})

describe('describeBotDestruction', () => {
  it('says nothing when the project has no Bots', () => {
    expect(describeBotDestruction([])).toBeNull()
  })

  it('names the Bot and admits it cannot be recovered', () => {
    const text = describeBotDestruction(['Rex'])
    expect(text).toContain('1 Bot')
    expect(text).toContain('Rex')
    expect(text).toContain('cannot be recovered')
  })

  it('pluralises', () => {
    expect(describeBotDestruction(['Rex', 'Ada'])).toContain('2 Bots')
  })
})
