import type { TranscriptEntry } from '../../shared/ipc'

/**
 * The public surface of the per-Thread transcript store — the SEAM CONTRACT
 * boundary from ADR-0005, shared by the legacy JSONL `TranscriptStore` (kept
 * for one release behind the construction seam, ADR-0019) and the SQLite
 * `SqliteTranscriptStore`. The bridge's `TranscriptSink` is the append subset
 * of this; `MainDeps` carries the full surface.
 */
export interface TranscriptStoreApi {
  /** Persist one conversation entry, in call order. Best-effort: never rejects the live flow. */
  append(threadId: string, entry: TranscriptEntry): Promise<void>
  /** A Thread's full entry log (the replay source). Missing/unwritten Thread reads `[]`. */
  read(threadId: string): Promise<TranscriptEntry[]>
  /** Drop a Thread's log. Idempotent, best-effort. */
  delete(threadId: string): Promise<void>
}
