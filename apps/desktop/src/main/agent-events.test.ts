import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { teeAgentEvent, wireAgentEvents, type AgentEventDeps } from './agent-events'
import type { TranscriptEntry } from '../shared/ipc'

/**
 * The tee/forward split (#468, ADR-0028) — the property the whole Routines feature
 * rests on: **a turn nobody is watching is still captured**.
 *
 * #456 verified on the wire that the transcript tee never depended on a
 * subscriber; these tests make that a pinned property of our code rather than a
 * happy accident of statement order, and cover the case that used to be
 * unreachable: an agent wired with NO renderer behind it at all.
 */

interface Recorded {
  threadId: string | null
  entry: TranscriptEntry
}

/** A fake bridge + the main-side callbacks, recording everything the tee does. */
function makeDeps(
  threadId: string | null = 't1',
  routineThreads: string[] = [],
): {
  deps: AgentEventDeps
  teed: Recorded[]
  titles: Array<{ sessionId: string | null; title: string }>
  permissions: Array<{ agentId: string; threadId: string; requestId: number | string }>
} {
  const teed: Recorded[] = []
  const titles: Array<{ sessionId: string | null; title: string }> = []
  const permissions: Array<{ agentId: string; threadId: string; requestId: number | string }> = []
  return {
    teed,
    titles,
    permissions,
    deps: {
      bridge: {
        tee: (id, entry) => void teed.push({ threadId: id, entry }),
        threadIdFor: () => threadId,
      },
      recordTitle: (sessionId, title) => void titles.push({ sessionId, title }),
      notePermission: (agentId, thread, requestId) =>
        void permissions.push({ agentId, threadId: thread, requestId }),
      isRoutineThread: (thread) => routineThreads.includes(thread),
    },
  }
}

/** A `session/update` payload carrying an agent message chunk. */
function chunk(sessionId: string): unknown {
  return {
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk' } },
  }
}

describe('teeAgentEvent (the half main owns)', () => {
  it('tees the payload to the Thread the event names', () => {
    const { deps, teed } = makeDeps('bot-thread')
    teeAgentEvent(deps, 'a1', chunk('s1'))
    expect(teed).toEqual([{ threadId: 'bot-thread', entry: { t: 'acp-event', payload: chunk('s1') } }])
  })

  it('captures a lazily pushed auto-title, routed by the event OWN sessionId', () => {
    const { deps, titles } = makeDeps()
    teeAgentEvent(deps, 'a1', {
      method: 'session/update',
      params: { sessionId: 's7', update: { sessionUpdate: 'session_info_update', title: 'Triage' } },
    })
    expect(titles).toEqual([{ sessionId: 's7', title: 'Triage' }])
  })

  it('records a blocking permission request as the Thread needing attention', () => {
    const { deps, permissions } = makeDeps('t9')
    teeAgentEvent(deps, 'a1', { id: 12, method: 'session/request_permission', params: { sessionId: 's1' } })
    expect(permissions).toEqual([{ agentId: 'a1', threadId: 't9', requestId: 12 }])
  })

  it('skips an unattributable permission request rather than inventing a Thread', () => {
    const { deps, permissions } = makeDeps(null) // no Thread resolves
    teeAgentEvent(deps, 'a1', { id: 12, method: 'session/request_permission', params: {} })
    expect(permissions).toEqual([])
  })
})

describe('wireAgentEvents (tee first, forward second)', () => {
  it('TEES with no subscriber attached — the property Routines rests on (#456)', () => {
    const { deps, teed } = makeDeps('bot-thread')
    const agent = new EventEmitter()
    // A forward that reaches NOBODY: production broadcasts to whatever windows
    // exist, and on macOS with the window closed that is zero of them.
    wireAgentEvents(deps, 'a1', agent, () => {})

    agent.emit('event', chunk('s1'))
    agent.emit('event', chunk('s1'))

    expect(teed).toHaveLength(2)
    expect(teed[0]).toEqual({ threadId: 'bot-thread', entry: { t: 'acp-event', payload: chunk('s1') } })
  })

  it('forwards every payload tagged by agentId when a window IS listening', () => {
    const { deps } = makeDeps()
    const agent = new EventEmitter()
    const forwarded: Array<{ agentId: string; payload: unknown }> = []
    wireAgentEvents(deps, 'a1', agent, (agentId, payload) => void forwarded.push({ agentId, payload }))

    agent.emit('event', chunk('s1'))

    expect(forwarded).toEqual([{ agentId: 'a1', payload: chunk('s1') }])
  })

  it('tees BEFORE it forwards, so the durable order never depends on a renderer', () => {
    const order: string[] = []
    const { deps } = makeDeps()
    const wrapped: AgentEventDeps = {
      ...deps,
      bridge: { ...deps.bridge, tee: () => void order.push('tee') },
    }
    const agent = new EventEmitter()
    wireAgentEvents(wrapped, 'a1', agent, () => void order.push('forward'))

    agent.emit('event', chunk('s1'))

    expect(order).toEqual(['tee', 'forward'])
  })
})

/**
 * A **Routine**'s permission request is main's to answer (#471, #469) — so it is
 * dropped whole rather than shown to somebody whose click cannot change it.
 */
describe('a Routine turn permission request', () => {
  const request = (sessionId: string): unknown => ({
    id: 4,
    method: 'session/request_permission',
    params: { sessionId, toolCall: { toolCallId: 'tc1' } },
  })

  it('is neither teed, noted nor forwarded while the Routine runs', () => {
    const { deps, teed, permissions } = makeDeps('bot-thread', ['bot-thread'])
    const agent = new EventEmitter()
    const forwarded: unknown[] = []
    wireAgentEvents(deps, 'a1', agent, (_id, payload) => void forwarded.push(payload))

    agent.emit('event', request('s1'))

    expect(teed).toEqual([])
    expect(permissions).toEqual([])
    expect(forwarded).toEqual([])
  })

  it('leaves the rest of the Routine turn alone — only the request is dropped', () => {
    const { deps, teed } = makeDeps('bot-thread', ['bot-thread'])
    const agent = new EventEmitter()
    const forwarded: unknown[] = []
    wireAgentEvents(deps, 'a1', agent, (_id, payload) => void forwarded.push(payload))

    agent.emit('event', chunk('s1'))

    expect(teed).toHaveLength(1)
    expect(forwarded).toHaveLength(1)
  })

  it('does not suppress a genuine request on a Thread no Routine is running', () => {
    const { deps, teed, permissions } = makeDeps('user-thread', ['bot-thread'])
    const agent = new EventEmitter()
    const forwarded: unknown[] = []
    wireAgentEvents(deps, 'a1', agent, (_id, payload) => void forwarded.push(payload))

    agent.emit('event', request('s1'))

    expect(teed).toHaveLength(1)
    expect(permissions).toEqual([{ agentId: 'a1', threadId: 'user-thread', requestId: 4 }])
    expect(forwarded).toHaveLength(1)
  })
})
