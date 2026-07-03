import { describe, expect, it } from 'vitest'
import type { ListMetadataResult, ThreadMeta } from '../../shared/ipc'
import {
  DEFAULT_SEARCH_LIMIT,
  foldSearchText,
  searchThreads,
  titleTier,
  tokenizeQuery,
} from './search-threads'

function thread(overrides: Partial<ThreadMeta> & { id: string }): ThreadMeta {
  return {
    workspaceId: 'ws-1',
    sessionId: null,
    title: null,
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  }
}

function snapshot(
  ...workspaces: Array<{ id: string; name: string; threads: ThreadMeta[] }>
): ListMetadataResult {
  return workspaces.map((ws) => ({
    id: ws.id,
    dir: `/tmp/${ws.id}`,
    displayName: ws.name,
    lastOpenedAt: 1,
    threads: ws.threads.map((t) => ({ ...t, workspaceId: ws.id })),
  }))
}

describe('foldSearchText / tokenizeQuery', () => {
  it('folds case and diacritics', () => {
    expect(foldSearchText('RéVisEr le Café')).toBe('reviser le cafe')
  })

  it('tokenizes on whitespace, dropping empties', () => {
    expect(tokenizeQuery('  Warm   Pool ')).toEqual(['warm', 'pool'])
    expect(tokenizeQuery('   ')).toEqual([])
    expect(tokenizeQuery('')).toEqual([])
  })
})

describe('titleTier', () => {
  it('tiers exact > prefix > contains > none (t3code parity)', () => {
    expect(titleTier('warm pool', 'warm pool')).toBe(3)
    expect(titleTier('warm pool eviction', 'warm pool')).toBe(2)
    expect(titleTier('the warm pool fix', 'warm pool')).toBe(1)
    expect(titleTier('cold storage', 'warm pool')).toBe(0)
    expect(titleTier('', 'warm')).toBe(0)
  })
})

describe('searchThreads', () => {
  const ws = snapshot(
    {
      id: 'ws-a',
      name: 'vibe-mistro',
      threads: [
        thread({ id: 't-exact', title: 'Warm pool', lastActiveAt: 10 }),
        thread({ id: 't-prefix', title: 'Warm pool eviction bug', lastActiveAt: 20 }),
        thread({ id: 't-contains', title: 'Fix the warm pool sweep', lastActiveAt: 30 }),
        thread({ id: 't-scattered', title: 'Pool heater went warm', lastActiveAt: 40 }),
        thread({ id: 't-miss', title: 'Composer chips', lastActiveAt: 50 }),
        thread({ id: 't-archived', title: 'Warm pool archive notes', lastActiveAt: 60, archived: true }),
        thread({ id: 't-untitled', title: null, lastActiveAt: 70 }),
      ],
    },
    {
      id: 'ws-b',
      name: 'Café Warm',
      threads: [thread({ id: 't-ws-assist', title: 'Pool ideas', lastActiveAt: 5 })],
    },
  )

  it('requires every token (AND), matching across title + workspace name', () => {
    const hits = searchThreads(ws, 'warm pool')
    const ids = hits.map((h) => h.threadId)
    expect(ids).toContain('t-scattered') // both tokens in title, not contiguous
    expect(ids).toContain('t-ws-assist') // "pool" from title + "warm" from workspace name
    expect(ids).not.toContain('t-miss')
    expect(ids).not.toContain('t-untitled')
  })

  it('ranks title tiers exact > prefix > contains > scattered/assisted, recency within a tier', () => {
    const ids = searchThreads(ws, 'warm pool').map((h) => h.threadId)
    expect(ids.indexOf('t-exact')).toBeLessThan(ids.indexOf('t-prefix'))
    expect(ids.indexOf('t-prefix')).toBeLessThan(ids.indexOf('t-contains'))
    expect(ids.indexOf('t-contains')).toBeLessThan(ids.indexOf('t-scattered'))
    // tier-0 pair: scattered (lastActiveAt 40) beats workspace-assisted (5) on recency
    expect(ids.indexOf('t-scattered')).toBeLessThan(ids.indexOf('t-ws-assist'))
    // archived is INCLUDED under a query, tiered like any other (contains → above tier 0)
    expect(ids).toContain('t-archived')
  })

  it('folds case and accents between query and haystack', () => {
    expect(searchThreads(ws, 'WARM POOL').map((h) => h.threadId)).toContain('t-exact')
    // "café" workspace matches the unaccented query token
    expect(searchThreads(ws, 'cafe pool').map((h) => h.threadId)).toEqual(['t-ws-assist'])
  })

  it('resting state (empty query): recency order, archived EXCLUDED, untitled included', () => {
    const ids = searchThreads(ws, '').map((h) => h.threadId)
    expect(ids[0]).toBe('t-untitled') // lastActiveAt 70
    expect(ids).not.toContain('t-archived')
    expect(ids).toContain('t-miss')
  })

  it('marks archived hits and carries workspace fields for the row', () => {
    const hit = searchThreads(ws, 'archive').find((h) => h.threadId === 't-archived')
    expect(hit).toMatchObject({ archived: true, workspaceName: 'vibe-mistro', workspaceId: 'ws-a' })
  })

  it('caps at the limit (default 20) and tolerates limit 0', () => {
    const many = snapshot({
      id: 'ws-many',
      name: 'many',
      threads: Array.from({ length: 30 }, (_, i) =>
        thread({ id: `t-${i}`, title: `match ${i}`, lastActiveAt: i }),
      ),
    })
    expect(searchThreads(many, 'match')).toHaveLength(DEFAULT_SEARCH_LIMIT)
    expect(searchThreads(many, 'match', 3)).toHaveLength(3)
    expect(searchThreads(many, 'match', 0)).toHaveLength(0)
  })
})
