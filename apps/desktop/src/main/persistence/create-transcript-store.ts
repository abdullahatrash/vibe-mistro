import { importLegacyTranscripts } from './import-legacy-transcripts'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import type { TranscriptStoreApi } from './transcript-store-api'
import type { StateDb } from './sqlite-db'

/**
 * The transcript-store construction seam (ADR-0019). The store shares the
 * metadata store's `stateDb` (same `state.sqlite`, never split-brain) and runs
 * the one-time JSONL import (per-file self-gating; the legacy dir renames to
 * `transcripts.bak` when fully handled). The legacy JSONL engine was removed
 * in #298 — on the in-memory failure fallback this store simply rides the same
 * non-durable db.
 */

export interface CreateTranscriptStoreDeps {
  /** From `createMetadataStore` — the one open state database. */
  stateDb: StateDb
  /** The legacy `userData/transcripts` dir (import source only). */
  transcriptsDir: string
  /** Skip the import (the in-memory fallback: imported rows would evaporate
   * while the rename tombstones the real files). */
  skipImport?: boolean
}

export async function createTranscriptStore(
  deps: CreateTranscriptStoreDeps,
): Promise<TranscriptStoreApi> {
  const store = new SqliteTranscriptStore({ stateDb: deps.stateDb })
  if (!deps.stateDb.locked && !deps.skipImport) {
    try {
      await importLegacyTranscripts({ dir: deps.transcriptsDir, store })
    } catch (err) {
      console.error('[create-transcript-store] legacy transcript import failed:', err)
    }
  }
  return store
}
