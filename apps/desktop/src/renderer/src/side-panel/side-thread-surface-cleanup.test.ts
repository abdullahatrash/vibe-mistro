import { describe, expect, it } from 'vitest'
import type { Surface } from './side-panel-store'
import { unpromptedSideThreadIds } from './side-thread-surface-cleanup'

describe('unpromptedSideThreadIds', () => {
  it('selects only renderer-only Draft Side Threads from a mixed close set', () => {
    const surfaces: Surface[] = [
      { id: 'review', kind: 'review' },
      {
        id: 'thread:draft-thread',
        kind: 'thread',
        threadId: 'draft-thread',
        lifecycle: 'draft',
      },
      {
        id: 'thread:durable-thread',
        kind: 'thread',
        threadId: 'durable-thread',
        lifecycle: 'durable',
      },
      { id: 'terminal:term-1', kind: 'terminal', resourceId: 'term-1' },
    ]

    expect(unpromptedSideThreadIds(surfaces)).toEqual(['draft-thread'])
  })
})
