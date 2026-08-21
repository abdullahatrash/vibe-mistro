import type { ListMetadataResult, ThreadMeta } from '../../shared/ipc'
import type { BotRecord } from '../../shared/ipc'

/**
 * Tag the Threads that are **Mistro Bot** conversations (#446, ADR-0027) with the
 * per-row `bot` flag, over the grouped cold snapshot both `metadata:list` and
 * `search:query` are served from.
 *
 * This is the whole visibility mechanism, and its SHAPE is the load-bearing part.
 * ADR-0027: "The Search exclusion cannot be a store-level filter. The Thread list
 * and Search share one expression, so hiding Bots in the store would hide them
 * from Search too. It is a per-row flag, read differently by each side."
 *
 * Concretely: `listMetadata` and `searchQuery` both call
 * `groupThreadsByWorkspace(store.snapshot())`. A filter in the store, in
 * `snapshot()`, or in `groupThreadsByWorkspace` would delete Bots from Search as
 * well as from the sidebar — so this MARKS and never drops. The sidebar does the
 * dropping (`partitionBots`, renderer-side); Search keeps every row and badges it;
 * the FTS prose projection needs no change at all, because it keys on `threadId`
 * alone and never consults this snapshot.
 *
 * Pure and allocation-frugal: with no Bots the input is returned untouched, and a
 * Workspace with no Bot in it keeps its original `threads` array.
 */
export function markBotThreads(
  workspaces: ListMetadataResult,
  botNamesByThread: ReadonlyMap<string, string>,
): ListMetadataResult {
  if (botNamesByThread.size === 0) return workspaces
  return workspaces.map((workspace) => {
    if (!workspace.threads.some((thread) => botNamesByThread.has(thread.id))) return workspace
    return {
      ...workspace,
      threads: workspace.threads.map((thread) => {
        const name = botNamesByThread.get(thread.id)
        return name === undefined ? thread : markBotThread(thread, name)
      }),
    }
  })
}

/** Each Bot's name keyed by its Thread id, for {@link markBotThreads}. */
export function botNamesByThread(bots: readonly BotRecord[]): ReadonlyMap<string, string> {
  return new Map(bots.map((bot) => [bot.threadId, bot.name]))
}

/** One row, flagged. Split out so the flag's shape is written down exactly once. */
function markBotThread(thread: ThreadMeta, name: string): ThreadMeta {
  return { ...thread, bot: { name } }
}
