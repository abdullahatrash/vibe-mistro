import { describe, it, expect } from 'vitest'
import { findSelectedThread, initialNavState, navReducer, type NavState } from './nav-reducer'
import type { ListMetadataResult, ThreadMeta } from '../../../shared/ipc'

/**
 * Shell navigation (ADR-0006 decision 2). A pure reducer holding WHICH Workspace
 * and Thread the user is looking at — decoupled from connection lifecycle and
 * mirroring conversation/reducer.ts (no React, no IPC, no router). The invariant
 * under test: a selected Thread always belongs to the selected Workspace.
 */

function thread(id: string, workspaceId: string): ThreadMeta {
  return { id, workspaceId, sessionId: null, title: null, createdAt: 1, lastActiveAt: 1 }
}

describe('navReducer', () => {
  it('starts with nothing selected, in the conversation view', () => {
    expect(initialNavState).toEqual({ selectedWorkspaceId: null, selectedThreadId: null, view: 'conversation' })
  })

  it('select-thread pins both the Thread and its Workspace', () => {
    const next = navReducer(initialNavState, { type: 'select-thread', workspaceId: 'w1', threadId: 't1' })
    expect(next).toEqual({ selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' })
  })

  it('switching to a different Workspace drops the now-foreign Thread selection', () => {
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' }
    const next = navReducer(start, { type: 'select-workspace', workspaceId: 'w2' })
    expect(next).toEqual({ selectedWorkspaceId: 'w2', selectedThreadId: null, view: 'conversation' })
  })

  it('re-selecting the same Workspace while in the conversation view is a no-op (same reference)', () => {
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' }
    const next = navReducer(start, { type: 'select-workspace', workspaceId: 'w1' })
    expect(next).toBe(start) // same reference: no spurious re-render or cleared Thread
  })

  it('clear resets to nothing selected in the conversation view', () => {
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'settings' }
    expect(navReducer(start, { type: 'clear' })).toEqual(initialNavState)
  })

  describe('Settings view (#130)', () => {
    it('open-settings switches to the settings view, preserving the selection', () => {
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' }
      expect(navReducer(start, { type: 'open-settings' })).toEqual({
        selectedWorkspaceId: 'w1',
        selectedThreadId: 't1',
        view: 'settings',
      })
    })

    it('open-settings works with nothing selected', () => {
      expect(navReducer(initialNavState, { type: 'open-settings' })).toEqual({
        selectedWorkspaceId: null,
        selectedThreadId: null,
        view: 'settings',
      })
    })

    it('close-settings returns to the conversation view, PRESERVING the selection', () => {
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'settings' }
      expect(navReducer(start, { type: 'close-settings' })).toEqual({
        selectedWorkspaceId: 'w1',
        selectedThreadId: 't1',
        view: 'conversation',
      })
    })

    it('selecting a Thread while in Settings leaves Settings (resets view)', () => {
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'settings' }
      const next = navReducer(start, { type: 'select-thread', workspaceId: 'w1', threadId: 't2' })
      expect(next).toEqual({ selectedWorkspaceId: 'w1', selectedThreadId: 't2', view: 'conversation' })
    })

    it('selecting a DIFFERENT Workspace while in Settings leaves Settings', () => {
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'settings' }
      const next = navReducer(start, { type: 'select-workspace', workspaceId: 'w2' })
      expect(next).toEqual({ selectedWorkspaceId: 'w2', selectedThreadId: null, view: 'conversation' })
    })

    it('re-selecting the SAME Workspace while in Settings leaves Settings (keeps selection)', () => {
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'settings' }
      const next = navReducer(start, { type: 'select-workspace', workspaceId: 'w1' })
      expect(next).toEqual({ selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' })
      expect(next).not.toBe(start) // not a no-op here: it must exit Settings
    })
  })

  describe('Skills view (#259)', () => {
    it('open-skills / close-skills mirror the Settings contract, preserving the selection', () => {
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' }
      const open = navReducer(start, { type: 'open-skills' })
      expect(open).toEqual({ selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'skills' })
      expect(navReducer(open, { type: 'open-skills' })).toBe(open) // referential no-op
      expect(navReducer(open, { type: 'close-skills' })).toEqual(start)
    })

    it('selecting a Thread while in Skills leaves Skills (resets view)', () => {
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: null, view: 'skills' }
      const next = navReducer(start, { type: 'select-thread', workspaceId: 'w1', threadId: 't2' })
      expect(next).toEqual({ selectedWorkspaceId: 'w1', selectedThreadId: 't2', view: 'conversation' })
    })

    it('open-settings from Skills swaps views directly', () => {
      const start: NavState = { selectedWorkspaceId: null, selectedThreadId: null, view: 'skills' }
      expect(navReducer(start, { type: 'open-settings' }).view).toBe('settings')
    })
  })
})

describe('findSelectedThread (cold-outlet derivation)', () => {
  const workspaces: ListMetadataResult = [
    { id: 'w1', dir: '/a', displayName: 'A', lastOpenedAt: 2, threads: [thread('t1', 'w1'), thread('t2', 'w1')] },
    { id: 'w2', dir: '/b', displayName: 'B', lastOpenedAt: 1, threads: [thread('t3', 'w2')] },
  ]

  it('resolves the selected Thread to its cold metadata', () => {
    const state: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't2', view: 'conversation' }
    expect(findSelectedThread(workspaces, state)?.id).toBe('t2')
  })

  it('returns null when no Thread is selected', () => {
    expect(
      findSelectedThread(workspaces, { selectedWorkspaceId: 'w1', selectedThreadId: null, view: 'conversation' }),
    ).toBeNull()
  })

  it('returns null when the selected Thread no longer exists (e.g. after a delete refreshed the list)', () => {
    const state: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 'gone', view: 'conversation' }
    expect(findSelectedThread(workspaces, state)).toBeNull()
  })

  it('scopes the lookup to the selected Workspace (a Thread id under another Workspace is not matched)', () => {
    const state: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't3', view: 'conversation' }
    expect(findSelectedThread(workspaces, state)).toBeNull()
  })
})
