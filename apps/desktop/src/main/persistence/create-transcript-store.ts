import { mkdir } from 'node:fs/promises'
import { importLegacyTranscripts } from './import-legacy-transcripts'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import { TranscriptStore } from './transcript'
import type { TranscriptStoreApi } from './transcript-store-api'
import type { StateDb } from './sqlite-db'

/**
 * The transcript-store construction seam (ADR-0019). The engine FOLLOWS the
 * metadata store's: `stateDb` is non-null exactly when `createMetadataStore`
 * selected SQLite, so both stores always run on the same engine — never a
 * split-brain where metadata rows and transcript files disagree about where
 * truth lives. Runs the one-time JSONL import (per-file self-gating; the dir
 * renames to `transcripts.bak` when fully handled).
 *
 * The legacy path keeps its existing semantics: mkdir the transcripts dir and
 * return null on failure — teeing then no-ops inside the bridge (best-effort).
 */

export interface CreateTranscriptStoreResult {
  transcript: TranscriptStoreApi | null
  engine: 'sqlite' | 'json'
}

export interface CreateTranscriptStoreDeps {
  /** From `createMetadataStore` — non-null selects the SQLite engine. */
  stateDb: StateDb | null
  /** The legacy `userData/transcripts` dir (import source / legacy home). */
  transcriptsDir: string
}

export async function createTranscriptStore(
  deps: CreateTranscriptStoreDeps,
): Promise<CreateTranscriptStoreResult> {
  if (deps.stateDb) {
    const store = new SqliteTranscriptStore({ stateDb: deps.stateDb })
    if (!deps.stateDb.locked) {
      // Best-effort: a failed import logs and leaves the dir for the next
      // launch's retry — it must never block the store (or launch) itself.
      try {
        await importLegacyTranscripts({ dir: deps.transcriptsDir, store })
      } catch (err) {
        console.error('[create-transcript-store] legacy transcript import failed:', err)
      }
    }
    return { transcript: store, engine: 'sqlite' }
  }

  try {
    await mkdir(deps.transcriptsDir, { recursive: true })
    return { transcript: new TranscriptStore({ dir: deps.transcriptsDir }), engine: 'json' }
  } catch {
    return { transcript: null, engine: 'json' }
  }
}
