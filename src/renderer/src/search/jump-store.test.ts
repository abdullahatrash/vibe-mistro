import { describe, expect, it } from 'vitest'
import { consumePendingJump, peekPendingJump, setPendingJump } from './jump-store'

describe('jump-store', () => {
  it('is single-shot per Thread and keyed by threadId', () => {
    setPendingJump('t1', 'assistant:m1')
    setPendingJump('t2', 'p9')
    expect(peekPendingJump('t1')).toBe('assistant:m1') // peek does not consume
    expect(peekPendingJump('t1')).toBe('assistant:m1')
    expect(consumePendingJump('t1')).toBe('assistant:m1')
    expect(consumePendingJump('t1')).toBeNull() // consumed exactly once
    expect(peekPendingJump('t1')).toBeNull()
    expect(consumePendingJump('t2')).toBe('p9') // other Threads unaffected
  })

  it('overwrites a prior target for the same Thread and misses cleanly', () => {
    setPendingJump('t3', 'old')
    setPendingJump('t3', 'new')
    expect(consumePendingJump('t3')).toBe('new')
    expect(peekPendingJump('never-set')).toBeNull()
    expect(consumePendingJump('never-set')).toBeNull()
  })
})
