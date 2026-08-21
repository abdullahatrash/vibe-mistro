import { describe, it, expect } from 'vitest'
import {
  findSelectedThread,
  initialNavState,
  navReducer,
  type NavAction,
  type NavState,
} from './nav-reducer'
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

  it('re-selecting the current Thread while in the conversation view is a no-op (same reference)', () => {
    // Keeps a connect's redundant re-select (applyConnectResult) out of the
    // back/forward history — nav-history only records referentially-new states.
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' }
    const next = navReducer(start, { type: 'select-thread', workspaceId: 'w1', threadId: 't1' })
    expect(next).toBe(start)
  })

  it('re-selecting the current Thread FROM Settings still returns to the conversation view', () => {
    const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'settings' }
    const next = navReducer(start, { type: 'select-thread', workspaceId: 'w1', threadId: 't1' })
    expect(next).toEqual({ selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' })
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

  describe('Bot form view (#447)', () => {
    const editRex: NavAction = { type: 'open-bot-form', target: { mode: 'edit', threadId: 't-rex' } }

    it('open-bot-form / close-bot-form mirror the Settings contract, preserving the selection', () => {
      // The selection MUST survive: the form is opened from a Bot's own
      // conversation ("Edit"), and Cancel has to land back on it.
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' }
      const open = navReducer(start, editRex)
      expect(open).toEqual({
        selectedWorkspaceId: 'w1',
        selectedThreadId: 't1',
        view: 'bot-form',
        botForm: { mode: 'edit', threadId: 't-rex' },
      })
      expect(navReducer(open, editRex)).toBe(open) // referential no-op: same form
      // Closing DROPS the payload: a stale target must not travel with a view that
      // is not showing a form.
      expect(navReducer(open, { type: 'close-bot-form' })).toEqual(start)
    })

    it('carries WHICH form it is, so two edits are two different places (#447 D1)', () => {
      // Without the payload in nav, Back from "Edit Ada" would restore the view with
      // whatever target was set last — showing Ada's form under Rex's history entry.
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 't1', view: 'conversation' }
      const rex = navReducer(start, editRex)
      const ada = navReducer(rex, { type: 'open-bot-form', target: { mode: 'edit', threadId: 't-ada' } })
      expect(ada).not.toBe(rex)
      expect(ada.botForm).toEqual({ mode: 'edit', threadId: 't-ada' })
    })

    it('drops the target on every route back to a conversation', () => {
      // A stale target must never travel into a history entry that shows no form.
      const start: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: null, view: 'conversation' }
      const open = navReducer(start, editRex)
      expect(navReducer(open, { type: 'select-thread', workspaceId: 'w1', threadId: 't-rex' })).toEqual({
        selectedWorkspaceId: 'w1',
        selectedThreadId: 't-rex',
        view: 'conversation',
      })
      for (const action of [
        { type: 'select-workspace', workspaceId: 'w2' },
        { type: 'select-workspace', workspaceId: 'w1' },
        { type: 'open-settings' },
        { type: 'open-skills' },
        { type: 'close-bot-form' },
      ] satisfies NavAction[]) {
        expect(navReducer(open, action).botForm ?? null).toBeNull()
      }
    })

    it('the ＋ works from Settings or Skills — the form swaps in directly', () => {
      const create: NavAction = { type: 'open-bot-form', target: { mode: 'create', workspaceId: 'w1' } }
      const fromSkills: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: null, view: 'skills' }
      expect(navReducer(fromSkills, create).view).toBe('bot-form')
      const fromSettings: NavState = { ...fromSkills, view: 'settings' }
      expect(navReducer(fromSettings, create).view).toBe('bot-form')
    })
  })

  describe('Routine editor view (#471)', () => {
    const inBotForm: NavState = {
      selectedWorkspaceId: 'w1',
      selectedThreadId: 'bot-1',
      view: 'bot-form',
      botForm: { mode: 'edit', threadId: 'bot-1' },
    }
    const open: NavAction = {
      type: 'open-routine-form',
      target: { mode: 'create', threadId: 'bot-1' },
    }

    it('opens over the Bot form, KEEPING it so there is somewhere to close back to', () => {
      const state = navReducer(inBotForm, open)
      expect(state.view).toBe('routine-form')
      expect(state.routineForm).toEqual({ mode: 'create', threadId: 'bot-1' })
      expect(state.botForm).toEqual({ mode: 'edit', threadId: 'bot-1' })
      expect(state.selectedThreadId).toBe('bot-1')
    })

    it('closes back onto the Bot form it was opened from', () => {
      const state = navReducer(navReducer(inBotForm, open), { type: 'close-routine-form' })
      expect(state.view).toBe('bot-form')
      expect(state.botForm).toEqual({ mode: 'edit', threadId: 'bot-1' })
      expect(state.routineForm).toBeUndefined()
    })

    it('closes to the conversation when there is no Bot form behind it', () => {
      const orphan: NavState = { selectedWorkspaceId: 'w1', selectedThreadId: 'bot-1', view: 'routine-form' }
      const state = navReducer(orphan, { type: 'close-routine-form' })
      expect(state.view).toBe('conversation')
      expect(state.selectedThreadId).toBe('bot-1')
    })

    it('carries WHICH routine it is, so two edits are two different places', () => {
      const first = navReducer(inBotForm, {
        type: 'open-routine-form',
        target: { mode: 'edit', threadId: 'bot-1', routineId: 'r1' },
      })
      const second = navReducer(first, {
        type: 'open-routine-form',
        target: { mode: 'edit', threadId: 'bot-1', routineId: 'r2' },
      })
      expect(second.routineForm).toEqual({ mode: 'edit', threadId: 'bot-1', routineId: 'r2' })
      // Re-opening the SAME editor records one move, not two.
      expect(navReducer(second, { type: 'open-routine-form', target: { mode: 'edit', threadId: 'bot-1', routineId: 'r2' } })).toBe(second)
    })

    it('drops the routine target on every route back to a conversation', () => {
      const inEditor = navReducer(inBotForm, open)
      for (const action of [
        { type: 'select-thread', workspaceId: 'w1', threadId: 't9' },
        { type: 'select-workspace', workspaceId: 'w2' },
        { type: 'clear' },
      ] satisfies NavAction[]) {
        const state = navReducer(inEditor, action)
        expect(state.view).toBe('conversation')
        expect(state.routineForm).toBeUndefined()
        expect(state.botForm).toBeUndefined()
      }
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
