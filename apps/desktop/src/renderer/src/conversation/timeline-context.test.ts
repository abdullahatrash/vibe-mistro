import { describe, expect, it } from 'vitest'
import { SETTLED_ACTIVITY, isRowStreaming } from './timeline-context'

describe('isRowStreaming', () => {
  it('is false for every row while no turn is in flight', () => {
    const activity = { isProcessing: false, lastUserIndex: 2 }
    expect(isRowStreaming(activity, 0)).toBe(false)
    expect(isRowStreaming(activity, 3)).toBe(false)
  })

  it('streams only the rows AFTER the last user message while a turn is in flight', () => {
    const activity = { isProcessing: true, lastUserIndex: 2 }
    // Prior turns (at or before the boundary) stay settled.
    expect(isRowStreaming(activity, 0)).toBe(false)
    expect(isRowStreaming(activity, 2)).toBe(false)
    // The live turn's rows stream.
    expect(isRowStreaming(activity, 3)).toBe(true)
    expect(isRowStreaming(activity, 9)).toBe(true)
  })

  it('streams every row when no user message exists yet (lastUserIndex -1)', () => {
    const activity = { isProcessing: true, lastUserIndex: -1 }
    expect(isRowStreaming(activity, 0)).toBe(true)
  })

  it('SETTLED_ACTIVITY never streams (the ColdThread contract)', () => {
    expect(isRowStreaming(SETTLED_ACTIVITY, 0)).toBe(false)
    expect(isRowStreaming(SETTLED_ACTIVITY, 100)).toBe(false)
  })
})
