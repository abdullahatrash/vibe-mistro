import type { Surface } from './side-panel-store'

/**
 * The renderer-only Side Threads whose composer state must be discarded with their
 * Surface. Durable Threads keep their drafts when merely closing a presentation.
 */
export function unpromptedSideThreadIds(surfaces: readonly Surface[]): string[] {
  return surfaces.flatMap((surface) =>
    surface.kind === 'thread' && surface.lifecycle === 'draft' ? [surface.threadId] : [],
  )
}
