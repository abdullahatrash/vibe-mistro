import { describe, it, expect } from 'vitest'
import { describeToolStatus } from './tool-status'

/**
 * ToolRow status mapping (#115): OUR ACP tool `status` string → the four display
 * buckets + trailing glyph. Pure/DOM-free — exercised as data.
 */
describe('describeToolStatus', () => {
  it('maps completed → done/check', () => {
    expect(describeToolStatus('completed')).toEqual({ state: 'done', glyph: 'check' })
  })

  it('maps failed → failed/x', () => {
    expect(describeToolStatus('failed')).toEqual({ state: 'failed', glyph: 'x' })
  })

  it('maps in_progress → running/spinner (live, no terminal check)', () => {
    expect(describeToolStatus('in_progress')).toEqual({ state: 'running', glyph: 'spinner' })
  })

  it('maps pending → pending/spinner', () => {
    expect(describeToolStatus('pending')).toEqual({ state: 'pending', glyph: 'spinner' })
  })

  it('defaults an unknown status to pending/spinner', () => {
    expect(describeToolStatus('weird-status')).toEqual({ state: 'pending', glyph: 'spinner' })
  })

  it('defaults a missing (null/undefined/empty) status to pending/spinner', () => {
    expect(describeToolStatus(null)).toEqual({ state: 'pending', glyph: 'spinner' })
    expect(describeToolStatus(undefined)).toEqual({ state: 'pending', glyph: 'spinner' })
    expect(describeToolStatus('')).toEqual({ state: 'pending', glyph: 'spinner' })
  })

  // #164 — a non-terminal status is SETTLED once the turn stops streaming: without
  // this the row spins forever if ACP omits a terminal `tool_call_update`.
  describe('settled context (streaming flag)', () => {
    it('keeps the spinner for non-terminal statuses while streaming', () => {
      expect(describeToolStatus('pending', true)).toEqual({ state: 'pending', glyph: 'spinner' })
      expect(describeToolStatus('in_progress', true)).toEqual({ state: 'running', glyph: 'spinner' })
      expect(describeToolStatus('weird-status', true)).toEqual({ state: 'pending', glyph: 'spinner' })
      expect(describeToolStatus(null, true)).toEqual({ state: 'pending', glyph: 'spinner' })
    })

    it('settles non-terminal statuses to a static dot once not streaming', () => {
      expect(describeToolStatus('pending', false)).toEqual({ state: 'settled', glyph: 'dot' })
      expect(describeToolStatus('in_progress', false)).toEqual({ state: 'settled', glyph: 'dot' })
    })

    it('settles unknown/missing statuses to a static dot once not streaming', () => {
      expect(describeToolStatus('weird-status', false)).toEqual({ state: 'settled', glyph: 'dot' })
      expect(describeToolStatus(null, false)).toEqual({ state: 'settled', glyph: 'dot' })
      expect(describeToolStatus(undefined, false)).toEqual({ state: 'settled', glyph: 'dot' })
      expect(describeToolStatus('', false)).toEqual({ state: 'settled', glyph: 'dot' })
    })

    it('leaves terminal statuses unaffected by the streaming flag', () => {
      expect(describeToolStatus('completed', false)).toEqual({ state: 'done', glyph: 'check' })
      expect(describeToolStatus('completed', true)).toEqual({ state: 'done', glyph: 'check' })
      expect(describeToolStatus('failed', false)).toEqual({ state: 'failed', glyph: 'x' })
      expect(describeToolStatus('failed', true)).toEqual({ state: 'failed', glyph: 'x' })
    })
  })
})
