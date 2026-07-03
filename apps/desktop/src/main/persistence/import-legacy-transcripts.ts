import { readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { parseTranscript } from './transcript'
import type { SqliteTranscriptStore } from './sqlite-transcript-store'

/**
 * One-time import of the legacy per-Thread JSONL transcripts into the SQLite
 * event log (ADR-0019). Runs at every launch after the metadata import (the FK
 * needs the Thread rows) and self-gates PER FILE, so a partial failure is
 * self-healing:
 *
 * - transcripts dir absent → nothing to do (the steady state after migration);
 * - a Thread that already has entries → skipped (imported on a previous run);
 * - an ORPHAN file (no metadata row — its Thread was lost before the swap) →
 *   skipped-but-handled: it could never render anyway, and the `.bak` rename
 *   preserves the bytes;
 * - otherwise → parse through the legacy tolerant line parser (torn trailing
 *   lines and the version header handled for free) and insert in file order
 *   inside one transaction per file.
 *
 * Only when EVERY file was handled is the whole dir renamed to
 * `transcripts.bak` — kept, never deleted, as the rollback path. Any per-file
 * failure leaves the dir in place; the next launch retries just the files that
 * didn't land (the per-Thread `hasEntries` gate skips the ones that did).
 */

export interface ImportLegacyTranscriptsResult {
  outcome: 'imported' | 'skipped-absent' | 'partial'
  imported: number
  skipped: number
  orphans: number
  failures: number
}

export interface ImportLegacyTranscriptsDeps {
  /** The legacy `userData/transcripts` dir. */
  dir: string
  store: SqliteTranscriptStore
  /** fs seams (tests) — default to node:fs/promises. */
  readdirDir?: (dir: string) => Promise<string[]>
  readFileAt?: (path: string) => Promise<string>
  renameDir?: (from: string, to: string) => Promise<void>
}

export async function importLegacyTranscripts(
  deps: ImportLegacyTranscriptsDeps,
): Promise<ImportLegacyTranscriptsResult> {
  const readdirDir = deps.readdirDir ?? ((dir: string) => readdir(dir))
  const readFileAt = deps.readFileAt ?? ((path: string) => readFile(path, 'utf8'))
  const renameDir = deps.renameDir ?? rename

  let names: string[]
  try {
    names = await readdirDir(deps.dir)
  } catch {
    return { outcome: 'skipped-absent', imported: 0, skipped: 0, orphans: 0, failures: 0 }
  }

  let imported = 0
  let skipped = 0
  let orphans = 0
  let failures = 0

  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue // foreign files ride along into the .bak
    const threadId = name.slice(0, -'.jsonl'.length)
    try {
      if (deps.store.hasEntries(threadId)) {
        skipped++ // landed on a previous (partially-failed) run
        continue
      }
      if (!deps.store.threadExists(threadId)) {
        orphans++ // no metadata row — unreachable data, preserved in the .bak
        continue
      }
      const entries = parseTranscript(await readFileAt(join(deps.dir, name)))
      deps.store.importEntries(threadId, entries)
      imported++
    } catch (err) {
      failures++
      console.error(`[import-legacy-transcripts] ${name} failed (will retry next launch):`, err)
    }
  }

  if (failures > 0) {
    console.error(
      `[import-legacy-transcripts] ${failures} file(s) failed — keeping ${deps.dir} for retry`,
    )
    return { outcome: 'partial', imported, skipped, orphans, failures }
  }

  try {
    await renameDir(deps.dir, `${deps.dir}.bak`)
  } catch (err) {
    // Everything imported; only the tombstone rename failed. Next launch skips
    // every file via the per-Thread gate and retries the rename here.
    console.error(`[import-legacy-transcripts] rename to .bak failed (retried next launch):`, err)
  }
  if (imported + skipped + orphans > 0) {
    console.log(
      `[import-legacy-transcripts] done: ${imported} imported, ${skipped} already-imported, ${orphans} orphan(s)`,
    )
  }
  return { outcome: 'imported', imported, skipped, orphans, failures }
}
