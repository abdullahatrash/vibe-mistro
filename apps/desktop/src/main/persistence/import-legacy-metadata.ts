import { access, rename } from 'node:fs/promises'
import { MetadataStore } from './metadata-store'
import type { SqliteMetadataStore } from './sqlite-metadata-store'

/**
 * One-time import of the legacy `metadata.json` into the SQLite metadata store
 * (ADR-0019). Runs at every launch and self-gates:
 *
 * - legacy file absent → nothing to do (the steady state after migration);
 * - legacy file written by a NEWER schema (fail-closed lock) → left untouched;
 * - state db non-empty → already imported; only the `.bak` rename is retried
 *   (covers a crash between commit and rename) — records are NEVER merged into
 *   existing data, so a re-run can't clobber newer SQLite rows with stale JSON;
 * - otherwise → parse through the legacy store itself (its envelope handling,
 *   per-record shape guards, and flag normalization for free), insert verbatim
 *   in one transaction, then rename the file to `metadata.json.bak` — kept, not
 *   deleted, as the rollback path.
 *
 * A failed import rolls back (the db stays empty) and returns 'failed' so the
 * construction seam can run THIS session on the legacy JSON store and retry on
 * the next launch. A failed rename after a successful import is best-effort:
 * logged, retried next launch via the non-empty branch.
 */

export type ImportLegacyMetadataResult =
  | 'imported'
  | 'skipped-absent'
  | 'skipped-locked'
  | 'skipped-nonempty'
  | 'failed'

export interface ImportLegacyMetadataDeps {
  /** Absolute path of the legacy `metadata.json`. */
  filePath: string
  store: SqliteMetadataStore
  /** fs seams (tests) — default to node:fs/promises. */
  exists?: (path: string) => Promise<boolean>
  renameFile?: (from: string, to: string) => Promise<void>
}

export async function importLegacyMetadata(
  deps: ImportLegacyMetadataDeps,
): Promise<ImportLegacyMetadataResult> {
  const exists = deps.exists ?? defaultExists
  const renameFile = deps.renameFile ?? rename
  const bakPath = `${deps.filePath}.bak`

  if (!(await exists(deps.filePath))) return 'skipped-absent'

  const legacy = new MetadataStore({ filePath: deps.filePath })
  await legacy.load()
  if (legacy.isLocked()) {
    // Written by a newer build than even this one understands — preserve it.
    console.error(`[import-legacy-metadata] ${deps.filePath} is newer than this build; left as-is`)
    return 'skipped-locked'
  }

  if (!deps.store.isEmpty()) {
    // Already imported (or real SQLite data exists) — never merge. Retry only
    // the rename a previous run may have crashed before.
    try {
      await renameFile(deps.filePath, bakPath)
      console.log(`[import-legacy-metadata] retried rename of ${deps.filePath} -> .bak`)
    } catch (err) {
      console.error(`[import-legacy-metadata] rename retry failed:`, err)
    }
    return 'skipped-nonempty'
  }

  try {
    deps.store.importSnapshot(legacy.snapshot())
  } catch (err) {
    console.error(`[import-legacy-metadata] import failed (rolled back):`, err)
    return 'failed'
  }

  try {
    await renameFile(deps.filePath, bakPath)
  } catch (err) {
    // Import committed; only the tombstone rename failed. Next launch hits the
    // non-empty branch and retries it — never a re-import.
    console.error(`[import-legacy-metadata] imported, but rename to .bak failed:`, err)
  }
  return 'imported'
}

async function defaultExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}
