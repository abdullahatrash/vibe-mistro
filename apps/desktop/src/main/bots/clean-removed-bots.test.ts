import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BotRecord } from '../../shared/ipc'
import { cleanRemovedBots } from './clean-removed-bots'

function bot(threadId: string, profileId: string, workspaceId = 'ws-1'): BotRecord {
  return {
    threadId,
    workspaceId,
    profileId,
    name: threadId,
    colour: '#fff',
    description: '',
    instructions: '',
    createdAt: 1,
    updatedAt: 1,
  }
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('cleanRemovedBots', () => {
  it('cleans the profile of every candidate whose Thread the removal took down', async () => {
    const removed: string[] = []
    const cleaned = await cleanRemovedBots({
      candidates: [bot('t1', 'p1'), bot('t2', 'p2')],
      removedThreadIds: ['t1', 't2', 't3'],
      removeProfile: async (profileId) => {
        removed.push(profileId)
        return true
      },
    })

    expect(removed).toEqual(['p1', 'p2'])
    expect(cleaned).toEqual(['p1', 'p2'])
  })

  it('leaves a Bot alone when its Thread survived the removal', async () => {
    const removed: string[] = []
    await cleanRemovedBots({
      candidates: [bot('t1', 'p1'), bot('t2', 'p2')],
      removedThreadIds: ['t2'],
      removeProfile: async (profileId) => {
        removed.push(profileId)
        return true
      },
    })
    expect(removed).toEqual(['p2'])
  })

  it('does nothing when the removal took no Threads down', async () => {
    const removed: string[] = []
    const cleaned = await cleanRemovedBots({
      candidates: [bot('t1', 'p1')],
      removedThreadIds: [],
      removeProfile: async (profileId) => {
        removed.push(profileId)
        return true
      },
    })
    expect(removed).toEqual([])
    expect(cleaned).toEqual([])
  })

  it('keeps going after a failure, so one bad unlink never skips the rest', async () => {
    const removed: string[] = []
    const cleaned = await cleanRemovedBots({
      candidates: [bot('t1', 'p1'), bot('t2', 'p2'), bot('t3', 'p3')],
      removedThreadIds: ['t1', 't2', 't3'],
      removeProfile: async (profileId) => {
        if (profileId === 'p2') throw new Error('EPERM')
        removed.push(profileId)
        return true
      },
    })

    expect(removed).toEqual(['p1', 'p3'])
    expect(cleaned).toEqual(['p1', 'p3'])
  })
})
