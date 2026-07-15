import { describe, it, expect } from 'vitest'
import { routeThreadSelection, seedSessionId, shouldDiscardDraftThread } from './thread-selection'
import type { ThreadMeta } from '../../../shared/ipc'

/**
 * Switching between a Workspace's Threads (ADR-0005, TB5 #34). A Thread opened
 * or drafted in THIS session is hosted live on the running agent; one bound in a
 * PRIOR launch (its session lives on a now-dead process) replays read-only from
 * JSONL until TB4 adds `session/load`. Pure routing — no React, no IPC.
 */

function thread(id: string, sessionId: string | null): ThreadMeta {
  return { id, workspaceId: 'w1', sessionId, title: null, createdAt: 1, lastActiveAt: 1 }
}

describe('routeThreadSelection', () => {
  it('routes a Thread live when it is hosted on the current agent this session', () => {
    const live = new Set(['t-open', 't-draft'])
    // The auto-opened Thread (already bound this session) and a fresh draft.
    expect(routeThreadSelection(thread('t-open', 'sess-1'), live)).toBe('live')
    expect(routeThreadSelection(thread('t-draft', null), live)).toBe('live')
  })

  it('routes a prior-session Thread cold (read-only replay), even though it has a sessionId', () => {
    const live = new Set(['t-open'])
    // Bound in a previous launch; not hosted on the current agent.
    expect(routeThreadSelection(thread('t-old', 'sess-from-yesterday'), live)).toBe('cold')
  })

  it('routes a draft that is not (yet) tracked live as cold — membership is the source of truth', () => {
    expect(routeThreadSelection(thread('t-unknown', null), new Set())).toBe('cold')
  })
})

describe('seedSessionId (no double-mint on remount)', () => {
  it('prefers a session bound this session over a stale persisted cursor', () => {
    // A draft bound this session (sD lifted via thread:bound) whose persisted
    // record still reads null: a switch-away-and-back must re-seed sD, NOT null —
    // otherwise the next prompt would re-mint a second session.
    const draft = thread('t-draft', null)
    expect(seedSessionId(draft, { 't-draft': 'sD' })).toBe('sD')
    // The seeded sD then flows to sendPrompt, taking ensureBoundSession's reuse
    // branch (no second session/new) — proven in thread-binding.test.ts.
  })

  it('falls back to the persisted cursor when nothing was bound this session', () => {
    expect(seedSessionId(thread('t-open', 'sess-1'), {})).toBe('sess-1')
    expect(seedSessionId(thread('t-fresh', null), {})).toBeNull()
  })
})

describe('shouldDiscardDraftThread', () => {
  const emptyDraft = {
    selectedThread: { workspaceId: 'w1', threadId: 'draft' },
    targetThread: { workspaceId: 'w1', threadId: 'existing' },
    primaryThreadId: 'primary',
    liveThreadIds: new Set(['primary', 'draft']),
    boundSessions: {},
    durableThreadIds: new Set(['existing']),
    composerIsEmpty: true,
    threadIsStreaming: false,
  }

  it('discards an empty renderer-only Draft Thread when selecting another Thread', () => {
    expect(shouldDiscardDraftThread(emptyDraft)).toBe(true)
  })

  it('preserves a Draft Thread with staged composer content', () => {
    expect(shouldDiscardDraftThread({ ...emptyDraft, composerIsEmpty: false })).toBe(false)
  })

  it('preserves the primary, bound, durable, current, and non-live Threads', () => {
    expect(shouldDiscardDraftThread({ ...emptyDraft, primaryThreadId: 'draft' })).toBe(false)
    expect(shouldDiscardDraftThread({ ...emptyDraft, boundSessions: { draft: 'session-draft' } })).toBe(false)
    expect(shouldDiscardDraftThread({ ...emptyDraft, durableThreadIds: new Set(['draft']) })).toBe(false)
    expect(
      shouldDiscardDraftThread({
        ...emptyDraft,
        targetThread: { workspaceId: 'w1', threadId: 'draft' },
      }),
    ).toBe(false)
    expect(shouldDiscardDraftThread({ ...emptyDraft, liveThreadIds: new Set(['primary']) })).toBe(false)
    expect(shouldDiscardDraftThread({ ...emptyDraft, threadIsStreaming: true })).toBe(false)
  })

  it('discards the Draft Thread when selecting a Thread in another Workspace', () => {
    expect(
      shouldDiscardDraftThread({
        ...emptyDraft,
        targetThread: { workspaceId: 'w2', threadId: 'draft' },
      }),
    ).toBe(true)
  })

  it('discards the Draft Thread when leaving for a Workspace with no selected Thread yet', () => {
    expect(
      shouldDiscardDraftThread({
        ...emptyDraft,
        targetThread: { workspaceId: 'w2', threadId: null },
      }),
    ).toBe(true)
  })
})
