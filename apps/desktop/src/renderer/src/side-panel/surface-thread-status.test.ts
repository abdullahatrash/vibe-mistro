import { describe, expect, it } from 'vitest'
import type { ThreadStatusMap } from '../conversation/thread-status'
import type { Surface } from './side-panel-store'
import { surfaceThreadStatus } from './surface-thread-status'

describe('surfaceThreadStatus', () => {
  it('projects the authoritative Thread status onto its Side Thread Surface', () => {
    const surface: Surface = {
      id: 'thread:side-1',
      kind: 'thread',
      threadId: 'side-1',
      lifecycle: 'durable',
    }
    const statuses: ThreadStatusMap = {
      'side-1': { streaming: true, needsAttention: true },
    }

    expect(surfaceThreadStatus(surface, statuses)).toEqual({
      streaming: true,
      needsAttention: true,
    })
  })

  it('treats an omitted Side Thread as idle and ignores non-Thread Surfaces', () => {
    const draft: Surface = {
      id: 'thread:draft',
      kind: 'thread',
      threadId: 'draft',
      lifecycle: 'draft',
    }

    expect(surfaceThreadStatus(draft, {})).toEqual({
      streaming: false,
      needsAttention: false,
    })
    expect(surfaceThreadStatus({ id: 'files', kind: 'files' }, {})).toBeNull()
  })
})
