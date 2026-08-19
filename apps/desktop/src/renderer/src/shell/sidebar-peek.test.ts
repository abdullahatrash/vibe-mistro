import { describe, expect, it } from 'vitest'
import {
  PEEK_CLOSE_DELAY_MS,
  PEEK_OPEN_DELAY_MS,
  createPeekController,
  type PeekTimers,
} from './sidebar-peek'

/** A synchronous fake clock — the injected timer seam, driven by hand. */
function fakeTimers(): PeekTimers & { advance: (ms: number) => void; pending: () => number } {
  let now = 0
  let nextHandle = 1
  const queued = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimeout(fn: () => void, ms: number): number {
      const handle = nextHandle++
      queued.set(handle, { at: now + ms, fn })
      return handle
    },
    clearTimeout(handle: number): void {
      queued.delete(handle)
    },
    advance(ms: number): void {
      now += ms
      for (const [handle, entry] of [...queued]) {
        if (entry.at <= now) {
          queued.delete(handle)
          entry.fn()
        }
      }
    },
    pending: () => queued.size,
  }
}

function setup() {
  const timers = fakeTimers()
  const changes: boolean[] = []
  const controller = createPeekController({ onChange: (v) => changes.push(v), timers })
  return { timers, changes, controller }
}

describe('createPeekController', () => {
  it('does not reveal until the open delay elapses', () => {
    const { timers, changes, controller } = setup()
    controller.pointerEnter()
    timers.advance(PEEK_OPEN_DELAY_MS - 1)
    expect(changes).toEqual([])
    timers.advance(1)
    expect(changes).toEqual([true])
  })

  it('swallows a pointer passing straight through the toggle', () => {
    const { timers, changes, controller } = setup()
    controller.pointerEnter()
    timers.advance(PEEK_OPEN_DELAY_MS - 50)
    controller.pointerLeave()
    timers.advance(1000)
    expect(changes).toEqual([])
    expect(timers.pending()).toBe(0)
  })

  it('keeps the sidebar open while crossing the gap from toggle to sidebar', () => {
    const { timers, changes, controller } = setup()
    controller.pointerEnter()
    timers.advance(PEEK_OPEN_DELAY_MS)
    expect(changes).toEqual([true])
    // Leaving the toggle, then landing on the sidebar before the grace expires.
    controller.pointerLeave()
    timers.advance(PEEK_CLOSE_DELAY_MS - 60)
    controller.pointerEnter()
    timers.advance(1000)
    expect(changes).toEqual([true])
  })

  it('closes once the pointer stays away past the close delay', () => {
    const { timers, changes, controller } = setup()
    controller.pointerEnter()
    timers.advance(PEEK_OPEN_DELAY_MS)
    controller.pointerLeave()
    timers.advance(PEEK_CLOSE_DELAY_MS - 1)
    expect(changes).toEqual([true])
    timers.advance(1)
    expect(changes).toEqual([true, false])
  })

  it('emits only on CHANGE, never a repeat', () => {
    const { timers, changes, controller } = setup()
    controller.pointerEnter()
    timers.advance(PEEK_OPEN_DELAY_MS)
    controller.pointerEnter()
    timers.advance(1000)
    expect(changes).toEqual([true])
  })

  it('cancel() closes immediately and drops a pending open', () => {
    const { timers, changes, controller } = setup()
    controller.pointerEnter()
    timers.advance(PEEK_OPEN_DELAY_MS)
    controller.cancel()
    expect(changes).toEqual([true, false])
    controller.pointerEnter()
    controller.cancel()
    timers.advance(1000)
    expect(changes).toEqual([true, false])
  })

  it('cancel() on a closed controller emits nothing', () => {
    const { changes, controller } = setup()
    controller.cancel()
    expect(changes).toEqual([])
  })

  it('dispose() drops pending timers WITHOUT emitting', () => {
    const { timers, changes, controller } = setup()
    controller.pointerEnter()
    controller.dispose()
    timers.advance(1000)
    expect(changes).toEqual([])
    expect(timers.pending()).toBe(0)
  })

  it('leaves no timer behind after a full open/close cycle', () => {
    const { timers, controller } = setup()
    controller.pointerEnter()
    timers.advance(PEEK_OPEN_DELAY_MS)
    controller.pointerLeave()
    timers.advance(PEEK_CLOSE_DELAY_MS)
    expect(timers.pending()).toBe(0)
  })

  it('opens faster than it closes, so intent is required but the gap is forgiving', () => {
    expect(PEEK_OPEN_DELAY_MS).toBeLessThan(PEEK_CLOSE_DELAY_MS)
  })
})
