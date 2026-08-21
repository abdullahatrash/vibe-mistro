import type { ThreadMeta } from '../../../shared/ipc'
import type { UnifiedThreadRow } from '../shell/unified-threads'

/**
 * What "Remove project" is about to destroy, in words (#447, ADR-0027 —
 * *destruction is honest*).
 *
 * Removing a Workspace drops every Thread under it, which cascades away its Bots
 * and (since #445) deletes their generated profile files. That is the right
 * behaviour and the wrong silence: a routine cleanup can take teammates the user
 * forgot lived there, and unlike a Thread a Bot is not recoverable from anywhere
 * else. So the confirm names them.
 *
 * Pure, and separated from the dialog because the interesting part is the
 * SENTENCE — one Bot reads differently from four, and "and 1 more" is a bug.
 */

/**
 * Cap the names actually spelled out; beyond it the rest are counted.
 *
 * The +1 in {@link formatBotNames} is the point: with a cap of three, FOUR Bots
 * would read "Rex, Ada, Kim and 1 more" — a sentence that spends more characters
 * hiding a name than printing it. So the cap only bites when it saves at least two.
 */
const NAMED_BOT_LIMIT = 3

/**
 * The Bot names among a project's sidebar rows, in row order.
 *
 * The `bot` flag is main's per-row mark (`markBotThreads`), which is why this
 * works for a peeked project as well as the selected one: both render rows built
 * from the same bot-marked metadata.
 */
export function botNamesInRows(rows: readonly UnifiedThreadRow[]): string[] {
  return rows.map((row) => row.thread.bot?.name).filter((name): name is string => Boolean(name))
}

/** The same read over raw metas, for callers that have not derived rows yet. */
export function botNamesInThreads(threads: readonly ThreadMeta[]): string[] {
  return threads.map((thread) => thread.bot?.name).filter((name): name is string => Boolean(name))
}

/**
 * The sentence the confirm dialog adds when a project has Bots — or null when it
 * has none, so the existing copy is untouched in the common case.
 *
 * This is the **Remove project** copy, and it is deliberately harsher than the
 * delete-a-Bot copy: deleting a Bot keeps its conversation as an archived Thread,
 * but removing the project removes every Thread under it, so the conversations go
 * too. The sentence has to say the thing that is actually true here, because this
 * is the path where something irreplaceable is lost.
 */
export function describeBotDestruction(names: readonly string[]): string | null {
  if (names.length === 0) return null
  const noun = names.length === 1 ? 'Bot' : 'Bots'
  return (
    `This also deletes ${names.length} ${noun} — ${formatBotNames(names)}. ` +
    `Their conversations are removed with the project; the ${names.length === 1 ? 'Bot' : 'Bots'} ` +
    `cannot be recovered.`
  )
}

/**
 * `Rex`, `Rex and Ada`, `Rex, Ada and Kim`, `Rex, Ada, Kim and Lou`,
 * `Rex, Ada, Kim and 2 more`.
 *
 * Four names are all printed: a remainder of one is worth less than the name it
 * replaces. Five or more fall back to the count.
 */
export function formatBotNames(names: readonly string[]): string {
  if (names.length <= NAMED_BOT_LIMIT + 1) {
    if (names.length <= 1) return names[0] ?? ''
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  }
  const shown = names.slice(0, NAMED_BOT_LIMIT).join(', ')
  return `${shown} and ${names.length - NAMED_BOT_LIMIT} more`
}
