import type { TranscriptEntry } from '../../shared/ipc'

/**
 * Prose extraction for Search slice 2 (#174): pull the CONVERSATION PROPER out
 * of a Thread's transcript — the user's prompts and the agent's replies, and
 * nothing else (CONTEXT.md "Search"). Reasoning (`agent_thought_chunk`) and tool
 * payloads (`tool_call*` rawInput/rawOutput) are deliberately not searchable:
 * they poison ranking (every grep the agent ran would hit) and aren't "what was
 * said". Shapes verified against docs/acp-capture.md §4:
 * `agent_message_chunk` = `{content:{type:"text",text}, messageId}`.
 */

/** One searchable prose piece: its transcript line index + the CONVERSATION ITEM
 * id the replay reducer will mint for it (the jump-to-message anchor) + raw text. */
export interface ProseEntry {
  /** Index of the source line in the Thread's transcript (replay order). */
  index: number
  /**
   * The reducer's item id for this entry — `user-prompt` replays as a user item
   * with the prompt's own id; an `agent_message_chunk` folds into the assistant
   * item keyed `assistant:${messageId}` (reducer.ts `appendChunk`). Null when
   * the id can't be derived (e.g. a chunk with no messageId) — still searchable,
   * just not jumpable.
   */
  itemId: string | null
  text: string
}

/** Extract an entry's searchable prose + jump anchor, or null when it carries none. */
export function extractProse(entry: TranscriptEntry): { text: string; itemId: string | null } | null {
  if (entry.t === 'user-prompt') {
    return entry.text ? { text: entry.text, itemId: entry.id || null } : null
  }
  if (entry.t !== 'acp-event') return null
  const message = entry.payload as { method?: unknown; params?: unknown } | null
  if (!message || message.method !== 'session/update') return null
  const update = (message.params as { update?: unknown } | undefined)?.update as
    | { sessionUpdate?: unknown; content?: unknown; messageId?: unknown }
    | undefined
  if (!update || update.sessionUpdate !== 'agent_message_chunk') return null
  const content = update.content as { type?: unknown; text?: unknown } | undefined
  if (content?.type !== 'text' || typeof content.text !== 'string' || !content.text) return null
  const itemId = typeof update.messageId === 'string' ? `assistant:${update.messageId}` : null
  return { text: content.text, itemId }
}

/**
 * A transcript's prose pieces, indexed by transcript line. Adjacent
 * agent_message_chunk deltas are NOT merged — each chunk is one entry; token-AND
 * matching happens per-entry, and the first strong entry seeds the snippet.
 */
export function proseEntries(entries: TranscriptEntry[]): ProseEntry[] {
  const prose: ProseEntry[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry) continue
    const extracted = extractProse(entry)
    if (extracted) prose.push({ index, ...extracted })
  }
  return prose
}

/** Max snippet length (one palette row line). */
const SNIPPET_MAX = 90
/** Context kept before the first matched token. */
const SNIPPET_LEAD = 20

/**
 * One display line around the first occurrence of any token: whitespace
 * collapsed, windowed to ~{@link SNIPPET_MAX} chars, ellipsized at cut edges.
 * Position finding is case-folded only (not accent-folded) — an accent-mismatch
 * falls back to the entry's start, which still shows the right message.
 */
export function buildSnippet(text: string, tokens: readonly string[]): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  const lowered = collapsed.toLowerCase()
  let matchAt = -1
  for (const token of tokens) {
    const at = lowered.indexOf(token)
    if (at !== -1 && (matchAt === -1 || at < matchAt)) matchAt = at
  }
  const start = matchAt === -1 ? 0 : Math.max(0, matchAt - SNIPPET_LEAD)
  const end = Math.min(collapsed.length, start + SNIPPET_MAX)
  const head = start > 0 ? '…' : ''
  const tail = end < collapsed.length ? '…' : ''
  return `${head}${collapsed.slice(start, end).trim()}${tail}`
}
