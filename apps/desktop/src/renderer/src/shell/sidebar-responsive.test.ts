import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_COLLAPSE_QUERY,
  nextSidebarToggle,
  resolveSidebarLayout,
  sidebarToggleExpands,
} from './sidebar-responsive'

const WIDE = { narrow: false, peeking: false, narrowOpen: false }
const NARROW = { narrow: true, peeking: false, narrowOpen: false }

describe('SIDEBAR_COLLAPSE_QUERY', () => {
  it('is a stable module constant, and staggers ABOVE the side panel 980px breakpoint', () => {
    expect(SIDEBAR_COLLAPSE_QUERY).toBe('(max-width: 1160px)')
  })
})

describe('resolveSidebarLayout', () => {
  it('expands inline on a wide window when nothing is stored', () => {
    expect(resolveSidebarLayout({ ...WIDE, stored: false })).toEqual({
      collapsed: false,
      overlay: false,
    })
  })

  it('honours the stored collapse on a wide window', () => {
    expect(resolveSidebarLayout({ ...WIDE, stored: true })).toEqual({
      collapsed: true,
      overlay: false,
    })
  })

  it('collapses on a narrow window even when the user stored EXPANDED', () => {
    expect(resolveSidebarLayout({ ...NARROW, stored: false })).toEqual({
      collapsed: true,
      overlay: false,
    })
  })

  it('overlays — never un-collapses — when peeking a collapsed sidebar', () => {
    expect(resolveSidebarLayout({ ...WIDE, stored: true, peeking: true })).toEqual({
      collapsed: true,
      overlay: true,
    })
  })

  it('ignores a peek while the sidebar is already expanded', () => {
    expect(resolveSidebarLayout({ ...WIDE, stored: false, peeking: true })).toEqual({
      collapsed: false,
      overlay: false,
    })
  })

  it('overlays a peek on a narrow window regardless of what is stored', () => {
    expect(resolveSidebarLayout({ ...NARROW, stored: false, peeking: true })).toEqual({
      collapsed: true,
      overlay: true,
    })
  })

  it('overlays when the toggle pinned it open while narrow', () => {
    expect(resolveSidebarLayout({ ...NARROW, stored: false, narrowOpen: true })).toEqual({
      collapsed: true,
      overlay: true,
    })
  })

  it('keeps the outlet full-width in EVERY narrow case (an overlay never pushes)', () => {
    for (const peeking of [true, false]) {
      for (const narrowOpen of [true, false]) {
        for (const stored of [true, false]) {
          expect(resolveSidebarLayout({ narrow: true, peeking, narrowOpen, stored }).collapsed).toBe(
            true,
          )
        }
      }
    }
  })
})

describe('nextSidebarToggle', () => {
  it('flips the stored preference on a wide window', () => {
    expect(nextSidebarToggle({ stored: false, narrow: false, narrowOpen: false })).toEqual({
      stored: true,
      narrowOpen: false,
    })
    expect(nextSidebarToggle({ stored: true, narrow: false, narrowOpen: false })).toEqual({
      stored: false,
      narrowOpen: false,
    })
  })

  it('clears a transient narrow overlay when the window is wide', () => {
    expect(nextSidebarToggle({ stored: true, narrow: false, narrowOpen: true }).narrowOpen).toBe(
      false,
    )
  })

  it('toggles the transient overlay while narrow and LEAVES the stored preference alone', () => {
    expect(nextSidebarToggle({ stored: false, narrow: true, narrowOpen: false })).toEqual({
      stored: false,
      narrowOpen: true,
    })
    expect(nextSidebarToggle({ stored: true, narrow: true, narrowOpen: true })).toEqual({
      stored: true,
      narrowOpen: false,
    })
  })

  it('never leaves the button inert while narrow — one press always changes the layout', () => {
    // The regression this guards: with a naive `stored || narrow`, pressing the toggle
    // while narrow flips a flag nothing reads, so the sidebar never moves.
    const before = resolveSidebarLayout({ stored: false, narrow: true, peeking: false, narrowOpen: false })
    const next = nextSidebarToggle({ stored: false, narrow: true, narrowOpen: false })
    const after = resolveSidebarLayout({ ...next, narrow: true, peeking: false })
    expect(after).not.toEqual(before)
    expect(after.overlay).toBe(true)
  })
})

describe('sidebarToggleExpands', () => {
  it('reads as "will expand" only when nothing is on screen', () => {
    expect(sidebarToggleExpands({ collapsed: true, overlay: false })).toBe(true)
    expect(sidebarToggleExpands({ collapsed: true, overlay: true })).toBe(false)
    expect(sidebarToggleExpands({ collapsed: false, overlay: false })).toBe(false)
  })
})
