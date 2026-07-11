import type { ThreadStatus, ThreadStatusMap } from '../conversation/thread-status'
import type { Surface } from './side-panel-store'

const IDLE_THREAD_STATUS: ThreadStatus = {
  streaming: false,
  needsAttention: false,
}

/**
 * Project main's authoritative per-Thread status onto a Side Thread Surface.
 * Non-Thread Surfaces have no agent lifecycle of their own; a Thread omitted from
 * the registry is idle because main only needs to seed non-default statuses.
 */
export function surfaceThreadStatus(
  surface: Surface,
  statuses: ThreadStatusMap,
): ThreadStatus | null {
  if (surface.kind !== 'thread') return null
  return statuses[surface.threadId] ?? IDLE_THREAD_STATUS
}
