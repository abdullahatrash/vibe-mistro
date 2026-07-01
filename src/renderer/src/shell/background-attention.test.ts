import { describe, expect, it } from 'vitest'
import { backgroundAttention } from './background-attention'

describe('backgroundAttention', () => {
  it('is all-false for an empty map', () => {
    expect(backgroundAttention({}, 'a')).toEqual({ streaming: false, needsAttention: false })
  })

  it('is all-false when the only flagged Workspace is the active one', () => {
    // The active Workspace's own status is shown in its thread list below the
    // switcher, so it never contributes to the trigger roll-up.
    const flags = { a: { streaming: true, needsAttention: true } }
    expect(backgroundAttention(flags, 'a')).toEqual({ streaming: false, needsAttention: false })
  })

  it('rolls up a background Workspace blocked on a permission (the TB2 finding)', () => {
    const flags = {
      a: { streaming: false, needsAttention: false },
      b: { streaming: false, needsAttention: true },
    }
    expect(backgroundAttention(flags, 'a')).toEqual({ streaming: false, needsAttention: true })
  })

  it('rolls up a background Workspace mid-stream', () => {
    const flags = {
      a: { streaming: false, needsAttention: false },
      b: { streaming: true, needsAttention: false },
    }
    expect(backgroundAttention(flags, 'a')).toEqual({ streaming: true, needsAttention: false })
  })

  it('ORs across multiple background Workspaces (one streams, another needs you)', () => {
    const flags = {
      a: { streaming: false, needsAttention: false },
      b: { streaming: true, needsAttention: false },
      c: { streaming: false, needsAttention: true },
    }
    expect(backgroundAttention(flags, 'a')).toEqual({ streaming: true, needsAttention: true })
  })

  it('counts every Workspace when none is active (null selection)', () => {
    const flags = { a: { streaming: false, needsAttention: true } }
    expect(backgroundAttention(flags, null)).toEqual({ streaming: false, needsAttention: true })
  })

  it('ignores the active Workspace even when a background one is quiet', () => {
    const flags = {
      a: { streaming: true, needsAttention: false },
      b: { streaming: false, needsAttention: false },
    }
    expect(backgroundAttention(flags, 'a')).toEqual({ streaming: false, needsAttention: false })
  })
})
