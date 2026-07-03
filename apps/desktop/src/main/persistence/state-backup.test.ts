import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { maybeBackupStateDb } from './state-backup'
import { openStateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { STATE_MIGRATIONS } from './state-migrations'

/**
 * The rotating VACUUM INTO backup (ADR-0019, #298): freshness gating from the
 * newest backup's filename, rotation, locked-db refusal, restorability of the
 * copy, and failure swallowing. Real temp dirs, fake clock.
 */

const root = mkdtempSync(join(tmpdir(), 'vibe-state-backup-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let seq = 0
function freshCase(): { backupsDir: string; dbPath: string } {
  const dir = join(root, `case-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return { backupsDir: join(dir, 'backups'), dbPath: join(dir, 'state.sqlite') }
}

const DAY = 24 * 60 * 60 * 1000

describe('maybeBackupStateDb', () => {
  it('creates a restorable copy, then skips while it is fresh, then rotates', async () => {
    const { backupsDir, dbPath } = freshCase()
    const stateDb = openStateDb({ path: dbPath, migrations: STATE_MIGRATIONS })
    const meta = new SqliteMetadataStore({ stateDb })
    const ws = await meta.upsertWorkspace({ dir: '/proj/backed-up' })

    let clock = 1_000_000_000_000
    const run = () => maybeBackupStateDb({ stateDb, backupsDir, now: () => clock })

    expect(await run()).toBe('created')
    expect(await run()).toBe('skipped-fresh') // same instant — fresh

    clock += DAY + 1
    expect(await run()).toBe('created')
    clock += DAY + 1
    expect(await run()).toBe('created')
    clock += DAY + 1
    expect(await run()).toBe('created')

    // Rotation: only the newest BACKUP_RETAIN (3) remain, newest last lexically.
    const names = readdirSync(backupsDir).sort()
    expect(names).toHaveLength(3)

    // Restorability: the newest copy opens as a normal state db with the data.
    const restored = openStateDb({
      path: join(backupsDir, names[names.length - 1] as string),
      migrations: STATE_MIGRATIONS,
    })
    const restoredMeta = new SqliteMetadataStore({ stateDb: restored })
    expect(restoredMeta.snapshot().workspaces.map((w) => w.id)).toEqual([ws.id])
    restored.close()
    stateDb.close()
  })

  it('leaves foreign files in the backups dir alone (no rotation casualties)', async () => {
    const { backupsDir, dbPath } = freshCase()
    mkdirSync(backupsDir, { recursive: true })
    writeFileSync(join(backupsDir, 'README.txt'), 'mine')
    const stateDb = openStateDb({ path: dbPath, migrations: STATE_MIGRATIONS })

    let clock = 1_000_000_000_000
    for (let i = 0; i < 5; i++) {
      await maybeBackupStateDb({ stateDb, backupsDir, now: () => clock })
      clock += DAY + 1
    }

    const names = readdirSync(backupsDir)
    expect(names).toContain('README.txt')
    expect(names.filter((n) => n.startsWith('state-'))).toHaveLength(3)
    stateDb.close()
  })

  it('refuses to copy a LOCKED (newer-build) database', async () => {
    const { backupsDir, dbPath } = freshCase()
    const raw = openStateDb({ path: dbPath, migrations: STATE_MIGRATIONS })
    raw.db.exec('PRAGMA user_version = 99')
    raw.close()
    const stateDb = openStateDb({ path: dbPath, migrations: STATE_MIGRATIONS })
    expect(stateDb.locked).toBe(true)

    expect(await maybeBackupStateDb({ stateDb, backupsDir })).toBe('skipped-locked')
    stateDb.close()
  })

  it("returns 'failed' (never throws) when the backups dir cannot be created", async () => {
    const { backupsDir, dbPath } = freshCase()
    // Occupy the backups path with a FILE so mkdir fails.
    writeFileSync(backupsDir, 'not a dir')
    const stateDb = openStateDb({ path: dbPath, migrations: STATE_MIGRATIONS })

    expect(await maybeBackupStateDb({ stateDb, backupsDir })).toBe('failed')
    stateDb.close()
  })
})
