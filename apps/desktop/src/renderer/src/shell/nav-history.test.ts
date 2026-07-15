import { describe, expect, it } from 'vitest'
import {
  initialNavHistory,
  navHistoryReducer,
  MAX_NAV_HISTORY,
  type NavHistoryAction,
  type NavHistoryState,
} from './nav-history'
import { initialNavState } from './nav-reducer'

function run(actions: NavHistoryAction[], from: NavHistoryState = initialNavHistory) {
  return actions.reduce(navHistoryReducer, from)
}

describe('navHistoryReducer', () => {
  it('forwards NavActions to navReducer and records the prior state', () => {
    const state = run([{ type: 'select-workspace', workspaceId: 'ws1' }])
    expect(state.present.selectedWorkspaceId).toBe('ws1')
    expect(state.past).toEqual([initialNavState])
    expect(state.future).toEqual([])
  })

  it('history-back returns to the previous state and populates future', () => {
    const moved = run([
      { type: 'select-workspace', workspaceId: 'ws1' },
      { type: 'select-thread', workspaceId: 'ws1', threadId: 't1' },
    ])
    const back = navHistoryReducer(moved, { type: 'history-back' })
    expect(back.present.selectedThreadId).toBeNull()
    expect(back.present.selectedWorkspaceId).toBe('ws1')
    expect(back.future).toEqual([moved.present])
  })

  it('history-forward re-applies an undone move', () => {
    const moved = run([
      { type: 'select-workspace', workspaceId: 'ws1' },
      { type: 'open-settings' },
    ])
    const roundTrip = run([{ type: 'history-back' }, { type: 'history-forward' }], moved)
    expect(roundTrip.present).toEqual(moved.present)
    expect(roundTrip.future).toEqual([])
  })

  it('history-back on an empty past is a referential no-op', () => {
    expect(navHistoryReducer(initialNavHistory, { type: 'history-back' })).toBe(initialNavHistory)
  })

  it('history-forward on an empty future is a referential no-op', () => {
    const moved = run([{ type: 'select-workspace', workspaceId: 'ws1' }])
    expect(navHistoryReducer(moved, { type: 'history-forward' })).toBe(moved)
  })

  it('a referential no-op NavAction records no history entry', () => {
    const moved = run([{ type: 'select-workspace', workspaceId: 'ws1' }])
    // Re-selecting the SAME Workspace while already in the conversation view is a
    // referential no-op in navReducer — the arrows must not walk phantom moves.
    const again = navHistoryReducer(moved, { type: 'select-workspace', workspaceId: 'ws1' })
    expect(again).toBe(moved)
  })

  it('a new move clears the forward stack (browser semantics)', () => {
    const moved = run([
      { type: 'select-workspace', workspaceId: 'ws1' },
      { type: 'select-workspace', workspaceId: 'ws2' },
      { type: 'history-back' },
      { type: 'select-workspace', workspaceId: 'ws3' },
    ])
    expect(moved.present.selectedWorkspaceId).toBe('ws3')
    expect(moved.future).toEqual([])
    // Back walks ws3 -> ws1 -> initial; ws2 was pruned.
    const back = navHistoryReducer(moved, { type: 'history-back' })
    expect(back.present.selectedWorkspaceId).toBe('ws1')
  })

  it('replaces an abandoned Draft Thread without leaving a duplicate back entry', () => {
    const draft = run([
      { type: 'select-thread', workspaceId: 'ws1', threadId: 'existing' },
      { type: 'select-thread', workspaceId: 'ws1', threadId: 'draft' },
    ])

    const replaced = navHistoryReducer(draft, {
      type: 'replace-selection',
      target: {
        selectedWorkspaceId: 'ws1',
        selectedThreadId: 'existing',
        view: 'conversation',
      },
      discarded: { workspaceId: 'ws1', threadId: 'draft' },
    })

    expect(replaced.present.selectedThreadId).toBe('existing')
    expect(replaced.past).toEqual([initialNavState])
    expect(replaced.future).toEqual([])
  })

  it('prunes every older navigation entry for the discarded Draft Thread', () => {
    const draft = run([
      { type: 'select-thread', workspaceId: 'ws1', threadId: 'existing' },
      { type: 'select-thread', workspaceId: 'ws1', threadId: 'draft' },
      { type: 'open-settings' },
      { type: 'close-settings' },
    ])

    const replaced = navHistoryReducer(draft, {
      type: 'replace-selection',
      target: {
        selectedWorkspaceId: 'ws1',
        selectedThreadId: 'existing',
        view: 'conversation',
      },
      discarded: { workspaceId: 'ws1', threadId: 'draft' },
    })

    expect(replaced.present.selectedThreadId).toBe('existing')
    expect(replaced.past).toEqual([initialNavState])
    expect(replaced.future).toEqual([])
  })

  it('replaces a Draft Thread with a Workspace-only selection', () => {
    const draft = run([
      { type: 'select-thread', workspaceId: 'ws1', threadId: 'draft' },
    ])

    const replaced = navHistoryReducer(draft, {
      type: 'replace-selection',
      target: {
        selectedWorkspaceId: 'ws2',
        selectedThreadId: null,
        view: 'conversation',
      },
      discarded: { workspaceId: 'ws1', threadId: 'draft' },
    })

    expect(replaced.present).toEqual({
      selectedWorkspaceId: 'ws2',
      selectedThreadId: null,
      view: 'conversation',
    })
    expect(replaced.past).toEqual([initialNavState])
    expect(replaced.future).toEqual([])
  })

  it('caps the past stack at MAX_NAV_HISTORY', () => {
    const actions: NavHistoryAction[] = []
    for (let i = 0; i < MAX_NAV_HISTORY + 10; i++) {
      actions.push({ type: 'select-workspace', workspaceId: `ws${i}` })
    }
    const state = run(actions)
    expect(state.past.length).toBe(MAX_NAV_HISTORY)
    // The OLDEST entries fell off; the newest survive.
    expect(state.past.at(-1)?.selectedWorkspaceId).toBe(`ws${MAX_NAV_HISTORY + 8}`)
  })
})
