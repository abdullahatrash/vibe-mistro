import { describe, it, expect } from 'vitest'
import { resolveAutocomplete, type Detection } from './autocomplete-machine'

/**
 * The unified composer autocomplete machine (quality-review slice 4a): the pure priority +
 * Esc-dismiss-latch resolution that replaced the two mirrored `/` and `@` refresh functions.
 * DOM-free, so these exercise the winner selection, latch lifecycle, and `onOpen` reporting
 * as plain data.
 */

const D = (start: number, query = ''): Detection => ({ start, query })

describe('resolveAutocomplete — priority (array order) wins', () => {
  it('opens the first detected source when several detect', () => {
    const r = resolveAutocomplete([D(0, 'a'), D(4, 'b')], [null, null])
    expect(r.winner).toEqual({ sourceIndex: 0, start: 0, query: 'a' })
  })

  it('reports EVERY eligible source in `opened`, not just the winner', () => {
    // Both detected + neither dismissed: both fire onOpen (the hidden `@` still fetches).
    const r = resolveAutocomplete([D(0), D(4)], [null, null])
    expect(r.opened).toEqual([0, 1])
  })

  it('lets a lower-priority source win when the higher one is dismissed', () => {
    // Source 0 detected but its latch equals its start → stays closed; source 1 wins.
    const r = resolveAutocomplete([D(0), D(4)], [0, null])
    expect(r.winner).toEqual({ sourceIndex: 1, start: 4, query: '' })
    expect(r.opened).toEqual([1])
  })

  it('winner is null when every source is inactive', () => {
    const r = resolveAutocomplete([null, null], [null, null])
    expect(r.winner).toBeNull()
    expect(r.opened).toEqual([])
  })
})

describe('resolveAutocomplete — Esc-dismiss latch lifecycle', () => {
  it('holds the latch while the same dismissed token stays detected', () => {
    const r = resolveAutocomplete([D(0, 'foo')], [0])
    expect(r.winner).toBeNull()
    expect(r.dismissed).toEqual([0])
    expect(r.opened).toEqual([])
  })

  it('clears the latch when the token goes inactive (a later trigger reopens fresh)', () => {
    const r = resolveAutocomplete([null], [0])
    expect(r.dismissed).toEqual([null])
  })

  it('clears the latch when the token moves to a different start', () => {
    const r = resolveAutocomplete([D(5, 'x')], [0])
    expect(r.winner).toEqual({ sourceIndex: 0, start: 5, query: 'x' })
    expect(r.dismissed).toEqual([null])
    expect(r.opened).toEqual([0])
  })
})
