import { describe, it, expect } from 'vitest'
import {
  bumpConversationEpoch,
  conversationViewKey,
  initialConversationEpochs,
} from './conversation-reset'

describe('conversationViewKey', () => {
  it('is the plain Thread id until a Start over — nothing else may remount', () => {
    expect(conversationViewKey('t1', initialConversationEpochs)).toBe('t1')
  })

  it('changes exactly once per Start over', () => {
    const once = bumpConversationEpoch(initialConversationEpochs, 't1')
    const twice = bumpConversationEpoch(once, 't1')
    expect(conversationViewKey('t1', once)).not.toBe('t1')
    expect(conversationViewKey('t1', twice)).not.toBe(conversationViewKey('t1', once))
  })

  it('leaves the key of every other Thread alone', () => {
    const epochs = bumpConversationEpoch(initialConversationEpochs, 't1')
    expect(conversationViewKey('t2', epochs)).toBe('t2')
  })
})

describe('bumpConversationEpoch', () => {
  it('does not mutate the map it is given', () => {
    const before = initialConversationEpochs
    bumpConversationEpoch(before, 't1')
    expect(before).toEqual({})
  })
})
