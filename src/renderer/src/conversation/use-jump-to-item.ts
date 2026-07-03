import { useEffect, type RefObject } from 'react'
import { consumePendingJump, peekPendingJump } from '../search/jump-store'

/** Paint-timing retries: `ready` handles data timing; these bridge layout only. */
const JUMP_RETRIES = 5
const JUMP_RETRY_MS = 80

/**
 * Land a Search jump (#174 slice 3): when this Thread has a pending jump target,
 * scroll its conversation item into view (centered) and flash it once. Scoped to
 * `container` — several conversation views stay keep-mounted (hidden) at once,
 * so a document-wide query could hit the wrong one. Runs when `ready` flips
 * (items rendered); a missing item (transcript drifted) consumes the target and
 * gives up quietly — the Thread just opens at the bottom, per the epic's
 * "droppable" stance. The instant scroll also releases MessageScroller's
 * stick-to-bottom pin, exactly as a user scroll would.
 */
export function useJumpToItem(
  threadId: string,
  ready: boolean,
  container: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    if (!ready || peekPendingJump(threadId) === null) return
    let cancelled = false
    let tries = 0
    const attempt = (): void => {
      if (cancelled) return
      const itemId = peekPendingJump(threadId)
      if (itemId === null) return
      const el = container.current?.querySelector(`[data-item-id="${CSS.escape(itemId)}"]`)
      if (el instanceof HTMLElement) {
        consumePendingJump(threadId)
        el.scrollIntoView({ block: 'center' })
        // Re-assert once after late layout shifts (code highlight, images) —
        // content growing above the target would otherwise push it off-screen.
        setTimeout(() => {
          if (!cancelled) el.scrollIntoView({ block: 'center' })
        }, 300)
        // A brief accent wash so the eye lands on the matched message — Web
        // Animations API, so no stylesheet coupling; cleans itself up on finish.
        el.animate(
          [
            { backgroundColor: 'color-mix(in srgb, var(--accent) 18%, transparent)' },
            { backgroundColor: 'transparent' },
          ],
          { duration: 1600, easing: 'ease-out' },
        )
      } else if (tries < JUMP_RETRIES) {
        tries += 1
        setTimeout(attempt, JUMP_RETRY_MS)
      } else {
        consumePendingJump(threadId) // item not in this replay — open-at-bottom
      }
    }
    requestAnimationFrame(attempt)
    return () => {
      cancelled = true
    }
  }, [threadId, ready, container])
}
