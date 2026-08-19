import { describe, expect, it } from 'vitest'
import {
  CONTEXT_CRITICAL_RATIO,
  CONTEXT_WARN_RATIO,
  contextUsageLevel,
  contextUsageNotice,
  contextUsagePercent,
  contextUsageRatio,
} from './context-usage'

const SIZE = 200_000

describe('contextUsageLevel', () => {
  it('stays quiet for most of a conversation, including past Vibe\'s own 50% warning', () => {
    expect(contextUsageLevel({ used: 0, size: SIZE })).toBe('normal')
    expect(contextUsageLevel({ used: SIZE * 0.5, size: SIZE })).toBe('normal')
    expect(contextUsageLevel({ used: SIZE * 0.74, size: SIZE })).toBe('normal')
  })

  it('warns from the warn ratio and escalates from the critical ratio', () => {
    expect(contextUsageLevel({ used: SIZE * CONTEXT_WARN_RATIO, size: SIZE })).toBe('warn')
    expect(contextUsageLevel({ used: SIZE * 0.89, size: SIZE })).toBe('warn')
    expect(contextUsageLevel({ used: SIZE * CONTEXT_CRITICAL_RATIO, size: SIZE })).toBe('critical')
  })

  it('stays critical past the threshold — the compaction-thrash case is real, not a glitch', () => {
    // #433 measured context climbing ABOVE the threshold across consecutive
    // compactions, so a ratio > 1 must not wrap around to something reassuring.
    expect(contextUsageLevel({ used: SIZE * 1.4, size: SIZE })).toBe('critical')
    expect(contextUsagePercent({ used: SIZE * 1.4, size: SIZE })).toBe(140)
  })

  it('never cries wolf on an unusable reading', () => {
    for (const usage of [
      { used: 10, size: 0 },
      { used: 10, size: -1 },
      { used: -1, size: SIZE },
      { used: Number.NaN, size: SIZE },
      { used: 10, size: Number.POSITIVE_INFINITY },
    ]) {
      expect(contextUsageLevel(usage)).toBe('normal')
      expect(contextUsageRatio(usage)).toBeNull()
      expect(contextUsagePercent(usage)).toBeNull()
    }
  })
})

describe('contextUsageNotice', () => {
  it('says nothing at normal, and names the consequence at critical', () => {
    expect(contextUsageNotice('normal')).toBeNull()
    expect(contextUsageNotice('warn')).toMatch(/approaching/i)
    // The point of the critical line is that compaction is LOSSY — say so.
    expect(contextUsageNotice('critical')).toMatch(/summarised/i)
  })
})
