import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The per-Thread visible-conversation transcript we OWN (ADR-0005). The main
 * process tees the conversation INPUTS — the user's prompt, each streamed
 * `session/update` payload, and permission responses — to an append-only JSONL
 * file (`<Thread id>.jsonl`) as they cross the IPC chokepoints. On reopen (TB3)
 * the log replays through the renderer reducer to rebuild the view with NO
 * `vibe-acp` process. The renderer stays pure (ADR-0001) — it never writes here.
 *
 * The entry union mirrors the reducer's INPUTS (`ConversationAction`), so a
 * replay is a near-mechanical map from entry -> dispatched action.
 */
export type TranscriptEntry =
  | { t: 'user-prompt'; id: string; text: string }
  | { t: 'acp-event'; payload: unknown }
  | { t: 'resolve-permission'; requestId: number | string; optionId: string; name: string | null }

/**
 * The injectable seam: where the logs live and how to append a line. Production
 * wires `node:fs/promises` + a `userData` transcripts dir; tests pass a temp dir
 * (and may stub `append` to simulate a failing disk), mirroring MetadataStore.
 */
/** The user's prompt, teed at `sendPrompt` — mirrors the `send-prompt` action. */
export function userPromptEntry(id: string, text: string): TranscriptEntry {
  return { t: 'user-prompt', id, text }
}

/** A streamed payload, teed at the `acp:event` forward — mirrors `acp-event`. */
export function acpEventEntry(payload: unknown): TranscriptEntry {
  return { t: 'acp-event', payload }
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

export interface TranscriptDeps {
  /** Directory holding the `<threadId>.jsonl` files. */
  dir: string
  /** Append a line to a file (created if absent). Defaults to `fs.appendFile`. */
  append?: (path: string, line: string) => Promise<void>
  /** Read a Thread's whole log. Defaults to `fs.readFile`. */
  readFile?: (path: string) => Promise<string>
}

export class TranscriptStore {
  private readonly dir: string
  private readonly appendFn: (path: string, line: string) => Promise<void>
  private readonly readFileFn: (path: string) => Promise<string>

  constructor(deps: TranscriptDeps) {
    this.dir = deps.dir
    this.appendFn = deps.append ?? ((path, line) => appendFile(path, line, 'utf8'))
    this.readFileFn = deps.readFile ?? ((path) => readFile(path, 'utf8'))
  }

  /** Absolute path of a Thread's log. */
  private pathFor(threadId: string): string {
    return join(this.dir, `${threadId}.jsonl`)
  }

  /**
   * Append one entry as a single JSON line to the Thread's log. Best-effort by
   * design (mirrors the guarded metadata writes): a failing append (disk full /
   * read-only `userData`) is swallowed so teeing can NEVER break the live
   * conversation — losing transcript history is preferable to wedging the turn.
   */
  async append(threadId: string, entry: TranscriptEntry): Promise<void> {
    try {
      await this.appendFn(this.pathFor(threadId), `${JSON.stringify(entry)}\n`)
    } catch {
      // A transcript write failure is non-fatal — the conversation proceeds.
    }
  }

  /**
   * Read a Thread's log into its entry array (the TB3 replay source). A missing
   * log yields `[]`; a malformed/partial trailing line is skipped, never fatal.
   */
  async read(threadId: string): Promise<TranscriptEntry[]> {
    let raw: string
    try {
      raw = await this.readFileFn(this.pathFor(threadId))
    } catch {
      // No log yet (ENOENT) — an unwritten Thread reads back empty.
      return []
    }
    return parseTranscript(raw)
  }
}

/**
 * Parse a JSONL transcript into its entries, tolerating a malformed or partial
 * trailing line. A crash mid-append (or a torn write) can leave the final line
 * truncated; we parse each line independently and SKIP any that don't yield a
 * well-formed entry rather than throwing — so the valid prefix always replays.
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

/** Shape-guard a parsed line to a known entry tag — drops foreign/garbled JSON. */
function isTranscriptEntry(value: unknown): value is TranscriptEntry {
  if (!value || typeof value !== 'object') return false
  const t = (value as { t?: unknown }).t
  return t === 'user-prompt' || t === 'acp-event' || t === 'resolve-permission'
}
