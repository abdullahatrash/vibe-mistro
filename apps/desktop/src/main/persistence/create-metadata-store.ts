import { join } from 'node:path'
import { MetadataStore } from './metadata-store'
import type { MetadataStoreApi } from './metadata-store-api'
import { importLegacyMetadata } from './import-legacy-metadata'
import { openStateDb, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The metadata-store construction seam (ADR-0019): decides which engine this
 * session runs on and performs the one-time legacy import. `index.ts` calls
 * this once at ready and types everything downstream as `MetadataStoreApi`.
 *
 * Engine selection, in order:
 * 1. `VIBE_MISTRO_FORCE_JSON=1` → the legacy JSON store (field escape hatch,
 *    removed with the legacy store after the soak release — #298).
 * 2. `state.sqlite` opens → SQLite store. A LOCKED open (db written by a newer
 *    build) still selects SQLite: the store presents empty + read-only and
 *    `isLocked()` drives the same honest upgrade notice the JSON store did.
 * 3. The open THROWS (unreadable path/disk) → legacy JSON store, logged. The
 *    legacy import also falling over ('failed') runs this session on JSON and
 *    retries next launch — the transaction rollback left the db empty.
 */

export interface CreateMetadataStoreResult {
  store: MetadataStoreApi
  /** Non-null only when the SQLite engine was selected. */
  stateDb: StateDb | null
  engine: 'sqlite' | 'json'
}

export interface CreateMetadataStoreDeps {
  userDataDir: string
  /** Env override (tests pin it; production reads VIBE_MISTRO_FORCE_JSON). */
  forceJson?: boolean
}

export async function createMetadataStore(
  deps: CreateMetadataStoreDeps,
): Promise<CreateMetadataStoreResult> {
  const legacyPath = join(deps.userDataDir, 'metadata.json')
  const forceJson = deps.forceJson ?? process.env.VIBE_MISTRO_FORCE_JSON === '1'

  if (forceJson) {
    console.log('[create-metadata-store] VIBE_MISTRO_FORCE_JSON=1 — using the legacy JSON store')
    return jsonStore(legacyPath, null)
  }

  let stateDb: StateDb
  try {
    stateDb = openStateDb({ path: join(deps.userDataDir, 'state.sqlite'), migrations: STATE_MIGRATIONS })
  } catch (err) {
    console.error('[create-metadata-store] state.sqlite failed to open — falling back to JSON:', err)
    return jsonStore(legacyPath, null)
  }

  const store = new SqliteMetadataStore({ stateDb })
  if (!stateDb.locked) {
    const imported = await importLegacyMetadata({ filePath: legacyPath, store })
    if (imported === 'failed') {
      // Rolled back to an empty db; run this session on the legacy JSON store
      // (the file is still in place) and retry the import next launch.
      stateDb.close()
      return jsonStore(legacyPath, null)
    }
  }
  return { store, stateDb, engine: 'sqlite' }
}

function jsonStore(legacyPath: string, stateDb: StateDb | null): CreateMetadataStoreResult {
  return { store: new MetadataStore({ filePath: legacyPath }), stateDb, engine: 'json' }
}
