import type { TranscriptEntry, TranscriptImageRef } from '../../shared/ipc'

/**
 * The transcript ENTRY VOCABULARY + legacy-JSONL parsing (ADR-0005/0019). The
 * live store is `SqliteTranscriptStore` (the `transcript_entries` event log);
 * what remains here is engine-independent:
 *
 *  - the entry builders main's tee chokepoints use (mirroring the reducer's
 *    `ConversationAction` inputs — `TranscriptEntry` itself lives in shared/ipc
 *    so the renderer replay can name it);
 *  - the pure payload extractors (`sessionIdFromPayload`,
 *    `titleFromSessionInfoUpdate`) used for event routing + auto-title capture;
 *  - `parseTranscript`/`isTranscriptEntry`/`transcriptVersionOf` — the tolerant
 *    legacy-JSONL reader the ONE-TIME importer (`import-legacy-transcripts`)
 *    still needs for pre-SQLite `transcripts/*.jsonl` files (torn trailing
 *    lines skipped, the version-header line dropped).
 *
 * The legacy JSONL `TranscriptStore` engine was removed in #298 after the
 * migration soak; `.bak` files remain on disk as the rollback path.
 */
export type { TranscriptEntry }

/**
 * The on-disk format version, written as the first line of every new transcript.
 * Bump ONLY on a backward-incompatible change to the entry format, and teach the
 * reader/migrator to branch on the header version. A log with no header is v1.
 */
export const TRANSCRIPT_SCHEMA_VERSION = 1

/** The header line's discriminator tag. Deliberately outside the entry union so
 * `isTranscriptEntry` drops it and replay never sees it as a conversation event. */
const TRANSCRIPT_HEADER_TAG = '__transcript_header'

/**
 * The format version of a raw transcript: the `v` from its header line, or `1`
 * for a legacy header-less log. For future migrators (JSONL→SQLite) to branch on;
 * `parseTranscript` itself is version-agnostic today (only v1 exists).
 */
export function transcriptVersionOf(raw: string): number {
  const first = raw.split('\n', 1)[0]
  if (!first) return TRANSCRIPT_SCHEMA_VERSION
  try {
    const parsed = JSON.parse(first) as { t?: unknown; v?: unknown }
    if (parsed.t === TRANSCRIPT_HEADER_TAG && typeof parsed.v === 'number') return parsed.v
  } catch {
    // First line isn't a header (legacy log starts with a real entry) — v1.
  }
  return TRANSCRIPT_SCHEMA_VERSION
}

/**
 * The user's prompt, teed at `sendPrompt` — mirrors the `send-prompt` action.
 * `images` are the refs of the prompt's attachments already persisted by the
 * `AttachmentStore` (omitted entirely when none survived — an image-less entry
 * stays byte-identical to the legacy shape).
 */
export function userPromptEntry(
  id: string,
  text: string,
  images?: TranscriptImageRef[],
): TranscriptEntry {
  return images && images.length > 0 ? { t: 'user-prompt', id, text, images } : { t: 'user-prompt', id, text }
}

/** A streamed payload, teed at the `acp:event` forward — mirrors `acp-event`. */
export function acpEventEntry(payload: unknown): TranscriptEntry {
  return { t: 'acp-event', payload }
}

/**
 * The turn ended cleanly, teed at `sendPrompt` once `session/prompt` resolves —
 * mirrors `turn-complete`. Captured here because that signal lives only in the
 * `sendPrompt` IPC RESPONSE (never an `acp:event`), so without it a replay would
 * leave `isProcessing` stuck true.
 */
export function turnCompleteEntry(): TranscriptEntry {
  return { t: 'turn-complete' }
}

/** The turn failed, teed at `sendPrompt` on a thrown/errored prompt — mirrors `turn-error`. */
export function turnErrorEntry(message: string): TranscriptEntry {
  return { t: 'turn-error', message }
}

/**
 * The agent's context was reset on a reopen (TB4 #33), teed at `sendPrompt` when a
 * `session/load` resume failed and main re-bound a fresh `session/new` — mirrors
 * the `agent-rebound` reducer action. Persisted so the notice survives a later
 * reopen; the user-facing copy is a renderer-side constant, so it carries none.
 */
export function agentReboundEntry(): TranscriptEntry {
  return { t: 'agent-rebound' }
}

/**
 * A permission response, teed at `respondPermission` — mirrors `resolve-permission`.
 * Main observes `requestId` + `optionId` at the chokepoint but not the option's
 * display `name` (that lives in the renderer's permission item), so `name`
 * defaults to `null`; TB3 replay can recover it from the matching request event.
 */
export function resolvePermissionEntry(
  requestId: number | string,
  optionId: string,
  name: string | null = null,
): TranscriptEntry {
  return { t: 'resolve-permission', requestId, optionId, name }
}

/**
 * Extract the ACP `sessionId` an `acp:event` payload is FOR (`session/update`
 * and `session/request_permission` both carry `params.sessionId`). Lets the tee
 * route each event to its OWN Thread via the store's sessionId lookup, rather
 * than an agent's last-opened Thread — correct when an agent hosts several
 * Threads in sequence (late events from a prior session must not misroute).
 * Lifecycle payloads (`{type:'exit'|...}`) carry none -> `null`.
 */
export function sessionIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const params = (payload as { params?: unknown }).params
  if (!params || typeof params !== 'object') return null
  const sessionId = (params as { sessionId?: unknown }).sessionId
  return typeof sessionId === 'string' ? sessionId : null
}

/**
 * Extract the TITLE from a `session_info_update` session-update, else `null`.
 * vibe-acp auto-titles a session from its FIRST prompt (first ~50 chars, not an LLM
 * summary) and pushes the result LAZILY as
 * `{ method:'session/update', params:{ update:{ sessionUpdate:'session_info_update', title } } }`
 * — never in the `session/new` response, which is why an un-listening client shows
 * every Thread as "Untitled". Pairs with `sessionIdFromPayload` (same payload) to
 * route the title to its Thread. Any other payload (a chunk, a tool call, a blank
 * title) yields `null` so callers skip it.
 */
export function titleFromSessionInfoUpdate(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  if ((payload as { method?: unknown }).method !== 'session/update') return null
  const params = (payload as { params?: unknown }).params
  if (!params || typeof params !== 'object') return null
  const update = (params as { update?: unknown }).update
  if (!update || typeof update !== 'object') return null
  if ((update as { sessionUpdate?: unknown }).sessionUpdate !== 'session_info_update') return null
  const title = (update as { title?: unknown }).title
  return typeof title === 'string' && title.length > 0 ? title : null
}

/**
 * Parse a JSONL transcript into its entries, tolerating a malformed or partial
 * trailing line. A crash mid-append (or a torn write) can leave the final line
 * truncated; we parse each line independently and SKIP any that don't yield a
 * well-formed entry rather than throwing — so the valid prefix always replays.
 *
 * The version-header line (present on logs written since the versioning change)
 * is not a conversation entry, so `isTranscriptEntry` drops it here — replay is
 * unaffected. Read the version separately via `transcriptVersionOf` if needed.
 */
export function parseTranscript(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue // blank/final newline — not a torn record
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue // malformed/partial line (e.g. a torn trailing write) — skip it
    }
    if (isTranscriptEntry(parsed)) entries.push(parsed)
  }
  return entries
}

/** Shape-guard a parsed line to a known entry tag — drops foreign/garbled JSON.
 * Exported for the SQLite store (ADR-0019), which guards each row's payload the
 * same way a JSONL line is guarded here. */
export function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false
  const t = (value as { t?: unknown }).t
  return (
    t === 'user-prompt' ||
    t === 'acp-event' ||
    t === 'turn-complete' ||
    t === 'turn-error' ||
    t === 'resolve-permission' ||
    t === 'agent-rebound'
  )
}
