/**
 * Responsive collapse + overlay presentation for the left sidebar.
 *
 * Two behaviours resolve here, as ONE pure function, because they interact:
 *
 * 1. RESPONSIVE COLLAPSE — below a width threshold the sidebar folds itself, and
 *    unfolds when the window grows back.
 * 2. OVERLAY — a temporarily-revealed sidebar (hover-peek, or the toggle pressed
 *    while the window is narrow) floats ABOVE the outlet instead of pushing it, so
 *    a hover never reflows the conversation under the pointer.
 *
 * The breakpoint is 1160px: the point where the sidebar's default 338px and the
 * conversation's 830px reading measure stop both fitting. It deliberately does NOT
 * reuse the side panel's 980px `NARROW_QUERY` (`side-panel/SurfacePanel.tsx`) —
 * staggering the two thresholds degrades the shell in two calm steps as the window
 * narrows, instead of folding the sidebar AND swapping the side panel to a Sheet at
 * the same instant.
 *
 * CRITICAL: the responsive state is an OVERRIDE, never a write. `sidebar-collapsed-store`
 * holds the user's explicit choice and this module never touches it, so widening the
 * window restores whatever they picked. Persisting `true` on resize would silently
 * destroy that preference — the sidebar would stay shut after the window grew back.
 */

/** Below this width the sidebar folds itself. Stable module constant — `useMediaQuery` re-subscribes on a new string. */
export const SIDEBAR_COLLAPSE_QUERY = '(max-width: 1160px)'

/** How the sidebar renders: whether the outlet reclaims its space, and whether it floats. */
export interface SidebarLayout {
  /** The outlet reclaims the sidebar's space (the aside animates to 0 width). */
  collapsed: boolean
  /** The aside floats ABOVE the outlet at full width, leaving the layout untouched. */
  overlay: boolean
}

export interface SidebarLayoutInput {
  /** The user's persisted choice (`sidebar-collapsed-store`). */
  stored: boolean
  /** Whether the window is under {@link SIDEBAR_COLLAPSE_QUERY}. */
  narrow: boolean
  /** Whether a hover-peek is currently revealing the sidebar. */
  peeking: boolean
  /** Whether the toggle pinned the sidebar open WHILE narrow (transient, never persisted). */
  narrowOpen: boolean
}

/**
 * Resolve the sidebar's presentation. Pure — the single source of truth for
 * "is it folded, and is it floating".
 *
 * While narrow the layout is ALWAYS collapsed: a narrow window has no room to give,
 * so any reveal is an overlay. While wide the stored preference wins, and a peek can
 * only overlay a sidebar that is already collapsed (there is nothing to reveal otherwise).
 */
export function resolveSidebarLayout(input: SidebarLayoutInput): SidebarLayout {
  if (input.narrow) {
    return { collapsed: true, overlay: input.peeking || input.narrowOpen }
  }
  return { collapsed: input.stored, overlay: input.stored && input.peeking }
}

/** The state the toggle button moves to. Separated from the reducer so App stays a thin wrapper. */
export interface SidebarToggleState {
  stored: boolean
  narrowOpen: boolean
}

/**
 * What pressing the collapse toggle does.
 *
 * While NARROW it opens/closes the transient overlay and leaves the stored preference
 * alone — otherwise the button would look broken, since `resolveSidebarLayout` forces
 * `collapsed` regardless of what is stored. While WIDE it flips the stored preference
 * and clears any transient overlay.
 */
export function nextSidebarToggle(input: {
  stored: boolean
  narrow: boolean
  narrowOpen: boolean
}): SidebarToggleState {
  if (input.narrow) return { stored: input.stored, narrowOpen: !input.narrowOpen }
  return { stored: !input.stored, narrowOpen: false }
}

/** Whether the toggle currently reads as "will expand" — drives its label and tooltip. */
export function sidebarToggleExpands(layout: SidebarLayout): boolean {
  return layout.collapsed && !layout.overlay
}
