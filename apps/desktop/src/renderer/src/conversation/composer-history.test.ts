import { describe, expect, it } from 'vitest'
import {
  buildComposerHistoryEntries,
  createComposerHistoryState,
  navigateComposerHistory,
  reconcileComposerHistoryEdit,
  resetComposerHistoryState,
  shouldNavigateComposerHistory,
} from './composer-history'

describe('buildComposerHistoryEntries', () => {
  it('keeps visible sent prompt text and removes structured supporting-context blocks', () => {
    expect(
      buildComposerHistoryEntries([
        '/teach explain this\n\n<attached_files>\n@src/app.ts\n</attached_files>',
        'inspect [terminal:term-1:2]\n\n<terminal_context>\nTerminal output for [terminal:term-1:2] from term-1:\nboom\n</terminal_context>',
        'review it\n\n<review_comments>\nReview comment on src/app.ts (line 2)\nnote: rename this\n```diff\n-old\n+new\n```\n</review_comments>',
      ]),
    ).toEqual(['/teach explain this', 'inspect [terminal:term-1:2]', 'review it'])
  })

  it('drops blank entries and consecutive duplicates without reordering history', () => {
    expect(buildComposerHistoryEntries(['first', 'first', ' ', 'second', 'first'])).toEqual([
      'first',
      'second',
      'first',
    ])
  })
})

describe('navigateComposerHistory', () => {
  it('walks backward and forward, then restores the scratch draft', () => {
    const entries = ['one', 'two', 'three']
    const initial = createComposerHistoryState()

    const latest = navigateComposerHistory(entries, initial, 'working draft', 'previous')
    expect(latest).toEqual({
      state: { cursor: 2, scratch: 'working draft' },
      value: 'three',
    })
    const older = navigateComposerHistory(entries, latest!.state, latest!.value, 'previous')
    expect(older).toEqual({ state: { cursor: 1, scratch: 'working draft' }, value: 'two' })
    const newer = navigateComposerHistory(entries, older!.state, older!.value, 'next')
    expect(newer).toEqual({ state: { cursor: 2, scratch: 'working draft' }, value: 'three' })
    expect(navigateComposerHistory(entries, newer!.state, newer!.value, 'next')).toEqual({
      state: createComposerHistoryState(),
      value: 'working draft',
    })
  })

  it('stays at the oldest entry and does nothing when Next has not entered history', () => {
    const entries = ['one', 'two']
    const oldest = { cursor: 0, scratch: 'draft' }

    expect(navigateComposerHistory(entries, oldest, 'one', 'previous')).toEqual({
      state: oldest,
      value: 'one',
    })
    expect(
      navigateComposerHistory(entries, createComposerHistoryState(), 'draft', 'next'),
    ).toBeNull()
  })

  it('keeps navigation state independent when callers own one state per Thread', () => {
    const entries = ['old', 'new']
    const threadOne = navigateComposerHistory(
      entries,
      createComposerHistoryState(),
      'thread one draft',
      'previous',
    )
    const threadTwo = navigateComposerHistory(
      entries,
      createComposerHistoryState(),
      'thread two draft',
      'previous',
    )

    expect(threadOne?.state.scratch).toBe('thread one draft')
    expect(threadTwo?.state.scratch).toBe('thread two draft')
  })

  it('keeps controlled echoes in recall mode, then resets when the recalled prompt is edited', () => {
    const recalled = { cursor: 1, scratch: 'working draft' }

    expect(reconcileComposerHistoryEdit(recalled, 'two', 'two')).toEqual({
      state: recalled,
      appliedValue: 'two',
    })
    expect(reconcileComposerHistoryEdit(recalled, 'two', 'two edited')).toEqual({
      state: createComposerHistoryState(),
      appliedValue: null,
    })
  })

  it('resets the cursor and scratch after send', () => {
    const recalled = { cursor: 0, scratch: 'working draft' }
    expect(resetComposerHistoryState()).toEqual(createComposerHistoryState())
    expect(resetComposerHistoryState()).not.toBe(recalled)
  })
})

describe('shouldNavigateComposerHistory', () => {
  it('gives autocomplete priority and requires a collapsed selection at the boundary line', () => {
    expect(
      shouldNavigateComposerHistory({
        direction: 'previous',
        autocompleteOpen: true,
        selectionCollapsed: true,
        caretLine: 'only',
      }),
    ).toBe(false)
    expect(
      shouldNavigateComposerHistory({
        direction: 'previous',
        autocompleteOpen: false,
        selectionCollapsed: false,
        caretLine: 'only',
      }),
    ).toBe(false)
    expect(
      shouldNavigateComposerHistory({
        direction: 'previous',
        autocompleteOpen: false,
        selectionCollapsed: true,
        caretLine: 'middle',
      }),
    ).toBe(false)
    expect(
      shouldNavigateComposerHistory({
        direction: 'previous',
        autocompleteOpen: false,
        selectionCollapsed: true,
        caretLine: 'first',
      }),
    ).toBe(true)
    expect(
      shouldNavigateComposerHistory({
        direction: 'next',
        autocompleteOpen: false,
        selectionCollapsed: true,
        caretLine: 'last',
      }),
    ).toBe(true)
  })
})
