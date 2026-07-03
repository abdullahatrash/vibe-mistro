import { mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { StateDb } from './sqlite-db'

/**
 * Best-effort rotating backup of `state.sqlite` (ADR-0019, #298). One database
 * file concentrates what per-Thread JSONL spread out; WAL + transactions make
 * torn writes rare, and this covers the residual: a daily `VACUUM INTO` copy
 * under `userData/backups/`, newest {@link BACKUP_RETAIN} kept.
 *
 * Runs OFF the hot path (index.ts schedules it a few seconds after ready) and
 * every failure is logged-and-swallowed — a backup can never affect launch or
 * a live turn. Freshness is derived from the newest backup's FILENAME
 * timestamp (no extra bookkeeping state).
 *
 * MANUAL RESTORE: quit the app, replace `userData/state.sqlite` with a backup
 * file (delete any `state.sqlite-wal`/`-shm` next to it), relaunch. History
 * regresses to the backup's moment; fold snapshots and the FTS index ride
 * inside the copy, so nothing needs rebuilding.
 */

export const BACKUP_RETAIN = 3
export const BACKUP_MIN_AGE_MS = 24 * 60 * 60 * 1000 // daily

const BACKUP_PREFIX = 'state-'
const BACKUP_SUFFIX = '.sqlite'

export type BackupResult = 'created' | 'skipped-fresh' | 'skipped-locked' | 'failed'

export interface BackupStateDbDeps {
  stateDb: StateDb
  /** `userData/backups` in production; a temp dir in tests. */
  backupsDir: string
  now?: () => number
  retain?: number
  minAgeMs?: number
}

/** `state-<epoch-ms>.sqlite` — lexical order == chronological order. */
function backupName(now: number): string {
  return `${BACKUP_PREFIX}${String(now).padStart(15, '0')}${BACKUP_SUFFIX}`
}

/** The epoch-ms a backup file encodes, or null for foreign files (left alone). */
function backupTimestamp(name: string): number | null {
  if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX)) return null
  const stamp = Number(name.slice(BACKUP_PREFIX.length, -BACKUP_SUFFIX.length))
  return Number.isFinite(stamp) ? stamp : null
}

export async function maybeBackupStateDb(deps: BackupStateDbDeps): Promise<BackupResult> {
  const now = deps.now ?? Date.now
  const retain = deps.retain ?? BACKUP_RETAIN
  const minAgeMs = deps.minAgeMs ?? BACKUP_MIN_AGE_MS
  // A locked db is a NEWER build's data — copying it around is not ours to do.
  if (deps.stateDb.locked) return 'skipped-locked'

  try {
    await mkdir(deps.backupsDir, { recursive: true })
    const existing = (await readdir(deps.backupsDir))
      .map((name) => ({ name, stamp: backupTimestamp(name) }))
      .filter((f): f is { name: string; stamp: number } => f.stamp !== null)
      .sort((a, b) => b.stamp - a.stamp)

    const ts = now()
    if (existing[0] && ts - existing[0].stamp < minAgeMs) return 'skipped-fresh'

    // VACUUM INTO writes a compacted, self-contained copy without blocking the
    // connection for long; single-quote escaping is the only SQL-literal need.
    const target = join(deps.backupsDir, backupName(ts))
    deps.stateDb.db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`)

    for (const stale of existing.slice(Math.max(0, retain - 1))) {
      await rm(join(deps.backupsDir, stale.name), { force: true })
    }
    console.log(`[state-backup] wrote ${target}`)
    return 'created'
  } catch (err) {
    console.error('[state-backup] failed (non-fatal):', err)
    return 'failed'
  }
}
