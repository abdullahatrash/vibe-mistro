import { join } from 'node:path'
import type { MetadataStoreApi } from './metadata-store-api'
import { importLegacyMetadata } from './import-legacy-metadata'
import { openStateDb, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The metadata-store construction seam (ADR-0019): open `state.sqlite`, run the
 * one-time legacy import, hand back the store. `index.ts` calls this once at
 * ready and types everything downstream as `MetadataStoreApi`.
 *
 * The legacy JSON engine and its `VIBE_MISTRO_FORCE_JSON` escape hatch were
 * removed in #298 after the migration soak. The remaining failure fallback is
 * an IN-MEMORY database (`engine: 'memory'`): if `state.sqlite` cannot open —
 * a disk so broken the JSON engine would not have fared better — the session
 * runs non-durable rather than wedging launch, loudly logged. A LOCKED open
 * (db written by a newer build) still selects the file db: the store presents
 * empty + read-only and `isLocked()` drives the honest upgrade notice.
 */

export interface CreateMetadataStoreResult {
  store: MetadataStoreApi
  stateDb: StateDb
  engine: 'sqlite' | 'memory'
}

export interface CreateMetadataStoreDeps {
  userDataDir: string
}

export async function createMetadataStore(
  deps: CreateMetadataStoreDeps,
): Promise<CreateMetadataStoreResult> {
  let stateDb: StateDb
  let engine: CreateMetadataStoreResult['engine'] = 'sqlite'
  try {
    stateDb = openStateDb({
      path: join(deps.userDataDir, 'state.sqlite'),
      migrations: STATE_MIGRATIONS,
    })
  } catch (err) {
    console.error(
      '[create-metadata-store] state.sqlite failed to open — running NON-DURABLE in memory:',
      err,
    )
    stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
    engine = 'memory'
  }

  const store = new SqliteMetadataStore({ stateDb })
  if (engine === 'sqlite' && !stateDb.locked) {
    // Best-effort: a failed import logs, rolls back, and leaves the legacy file
    // for the next launch's retry — the session proceeds on the (empty) db.
    // (Never into the memory fallback: importing would rename the legacy file
    // to .bak while the imported rows evaporate with the session.)
    await importLegacyMetadata({ filePath: join(deps.userDataDir, 'metadata.json'), store })
  }
  return { store, stateDb, engine }
}
