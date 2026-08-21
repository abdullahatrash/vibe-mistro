import { useCallback, useEffect, useState } from 'react'
import type { BotRecord } from '../../../shared/ipc'

/**
 * The Mistro Bot RECORDS (#446): name, colour, description, instructions, Project.
 * Read once over `bots:list` and refreshed only when a record changes — creating,
 * editing or deleting a Bot, all of which arrive in slice 3 (#447), which is why
 * `refresh` is returned rather than called on a timer.
 *
 * The rows' ORDER and their timestamps deliberately do NOT come from here: a
 * record only moves on an edit, so `deriveBotRows` joins these against the Threads'
 * `lastActiveAt` from the metadata list, which the app already refreshes on the
 * events that matter.
 */
export function useBots(): { bots: BotRecord[]; refreshBots: () => void } {
  const [bots, setBots] = useState<BotRecord[]>([])

  const refreshBots = useCallback(() => {
    void window.api
      .botsList()
      .then((result) => setBots(result.bots))
      .catch((err: unknown) => {
        // Log, don't swallow — but never break the sidebar over it. An empty Bots
        // section is a survivable degradation; a thrown render is not.
        console.error('[vibe-mistro:bots] could not list Bots:', err)
      })
  }, [])

  useEffect(() => {
    refreshBots()
  }, [refreshBots])

  return { bots, refreshBots }
}
