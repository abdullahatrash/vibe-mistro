import { describe, expect, it } from 'vitest'
import {
  canGoBackNav,
  canGoForwardNav,
  goBackNav,
  goForwardNav,
  INITIAL_NAV,
  pushNav,
} from './browser-nav-history'

describe('browser nav-history model', () => {
  // The webview element's own canGoBack()/canGoForward() are unreliable in Electron's
  // <webview> tag (they return false with a genuine multi-entry history), so #216
  // tracks availability from navigation EVENTS through this pure index/length model.

  it('starts empty — nowhere to go', () => {
    expect(canGoBackNav(INITIAL_NAV)).toBe(false)
    expect(canGoForwardNav(INITIAL_NAV)).toBe(false)
  })

  it('a first navigation lands on a single entry with no back/forward', () => {
    const s = pushNav(INITIAL_NAV)
    expect(canGoBackNav(s)).toBe(false)
    expect(canGoForwardNav(s)).toBe(false)
  })

  it('a second navigation enables Back but not Forward', () => {
    const s = pushNav(pushNav(INITIAL_NAV))
    expect(canGoBackNav(s)).toBe(true)
    expect(canGoForwardNav(s)).toBe(false)
  })

  it('going back enables Forward and (from the middle) keeps Back', () => {
    const s = goBackNav(pushNav(pushNav(pushNav(INITIAL_NAV)))) // 3 entries, index 2 → 1
    expect(canGoBackNav(s)).toBe(true)
    expect(canGoForwardNav(s)).toBe(true)
  })

  it('going back to the first entry disables Back', () => {
    const s = goBackNav(pushNav(pushNav(INITIAL_NAV))) // 2 entries, index 1 → 0
    expect(canGoBackNav(s)).toBe(false)
    expect(canGoForwardNav(s)).toBe(true)
  })

  it('back then forward returns to the tip', () => {
    const s = goForwardNav(goBackNav(pushNav(pushNav(INITIAL_NAV))))
    expect(canGoBackNav(s)).toBe(true)
    expect(canGoForwardNav(s)).toBe(false)
  })

  it('a new navigation after going back truncates the forward entries', () => {
    // 3 entries, back to index 1, then a fresh navigation replaces the tail.
    const middle = goBackNav(pushNav(pushNav(pushNav(INITIAL_NAV)))) // index 1, length 3
    const s = pushNav(middle) // index 2, length 3 — forward is gone
    expect(canGoBackNav(s)).toBe(true)
    expect(canGoForwardNav(s)).toBe(false)
  })

  it('goBack/goForward at the ends are no-ops (same state)', () => {
    expect(goBackNav(INITIAL_NAV)).toBe(INITIAL_NAV)
    const tip = pushNav(pushNav(INITIAL_NAV))
    expect(goForwardNav(tip)).toBe(tip)
  })
})
