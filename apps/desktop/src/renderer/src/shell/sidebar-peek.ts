/**
 * Hover-to-peek for the collapsed left sidebar: hovering the header's collapse toggle
 * reveals the sidebar as an overlay, and leaving it hides it again.
 *
 * Hover reveals need INTENT, not raw events. A pointer crossing the toggle on its way
 * somewhere else must not fling the sidebar open, and the short gap between the toggle
 * and the revealed sidebar must not slam it shut mid-traverse. Two asymmetric delays do
 * that: a short open delay swallows pass-through, and a longer close delay tolerates the
 * gap. The toggle and the sidebar share ONE controller, so moving between them is just
 * leave-then-enter and the pending close is cancelled.
 *
 * The timer seam is INJECTED so tests drive it synchronously with fakes — the repo tests
 * renderer logic as pure modules in the `node` environment, never through the DOM.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** Pointer must rest this long before the sidebar reveals — swallows pass-through. */
export const PEEK_OPEN_DELAY_MS = 180

/** Grace after the pointer leaves — long enough to cross the gap from toggle to sidebar. */
export const PEEK_CLOSE_DELAY_MS = 260

/** The slice of the timer API we depend on — `window` satisfies it. */
export interface PeekTimers {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(handle: number): void
}

export interface PeekController {
  /** Pointer entered the toggle OR the revealed sidebar. */
  pointerEnter(): void
  /** Pointer left the toggle OR the revealed sidebar. */
  pointerLeave(): void
  /** Close immediately and drop any pending transition (a click pins or unpins instead). */
  cancel(): void
  /** Drop pending timers WITHOUT emitting — for unmount. */
  dispose(): void
}

/**
 * The hover-intent state machine. Pure apart from the injected timers: it owns the
 * open/closed flag and emits every CHANGE through `onChange`, never a repeat.
 */
export function createPeekController({
  onChange,
  timers,
  openDelayMs = PEEK_OPEN_DELAY_MS,
  closeDelayMs = PEEK_CLOSE_DELAY_MS,
}: {
  onChange: (peeking: boolean) => void
  timers: PeekTimers
  openDelayMs?: number
  closeDelayMs?: number
}): PeekController {
  let open = false
  let pending: number | null = null

  function clearPending(): void {
    if (pending === null) return
    timers.clearTimeout(pending)
    pending = null
  }

  function settle(next: boolean): void {
    pending = null
    if (open === next) return
    open = next
    onChange(next)
  }

  return {
    pointerEnter(): void {
      clearPending()
      if (open) return
      pending = timers.setTimeout(() => settle(true), openDelayMs)
    },
    pointerLeave(): void {
      clearPending()
      if (!open) return
      pending = timers.setTimeout(() => settle(false), closeDelayMs)
    },
    cancel(): void {
      clearPending()
      if (!open) return
      open = false
      onChange(false)
    },
    dispose(): void {
      clearPending()
    },
  }
}

/** Mouse handlers to spread onto the toggle and the revealed sidebar. */
export interface PeekHoverProps {
  onMouseEnter: () => void
  onMouseLeave: () => void
}

/**
 * React binding for {@link createPeekController}. `enabled` gates the whole behaviour —
 * an expanded sidebar has nothing to peek at, and flipping to disabled closes any peek
 * in flight.
 *
 * MOUSE events, not pointer events: a pointer enter also fires for touch and pen, where
 * there is no hover and the reveal would strand with no matching leave.
 */
export function useSidebarPeek(enabled: boolean): {
  peeking: boolean
  hoverProps: PeekHoverProps
  cancelPeek: () => void
} {
  const [peeking, setPeeking] = useState(false)
  const controller = useMemo(
    () => createPeekController({ onChange: setPeeking, timers: window }),
    [],
  )
  const controllerRef = useRef(controller)
  controllerRef.current = controller

  useEffect(() => () => controllerRef.current.dispose(), [])
  useEffect(() => {
    if (!enabled) controller.cancel()
  }, [enabled, controller])

  const onMouseEnter = useCallback(() => {
    if (enabled) controller.pointerEnter()
  }, [enabled, controller])
  const onMouseLeave = useCallback(() => {
    controller.pointerLeave()
  }, [controller])
  const cancelPeek = useCallback(() => {
    controller.cancel()
  }, [controller])

  return { peeking, hoverProps: { onMouseEnter, onMouseLeave }, cancelPeek }
}
