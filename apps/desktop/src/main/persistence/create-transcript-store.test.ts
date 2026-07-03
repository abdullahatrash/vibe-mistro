import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranscriptStore } from './create-transcript-store'
import { openStateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import { STATE_MIGRATIONS } from './state-migrations'
import { userPromptEntry } from './transcript'

/**
 * The transcript-store construction seam (ADR-0019, sqlite-only since #298):
 * same stateDb as the metadata store, one-time JSONL import on the way, and
 * the skip-import guard for the in-memory fallback.
 */

const root = mkdtempSync(join(tmpdir(), 'vibe-create-transcript-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let seq = 0
function freshDir(): string {
  const dir = join(root, `case-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

describe('createTranscriptStore', () => {
  it('returns the SQLite store and imports legacy JSONL on the way', async () => {
    const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
    const meta = new SqliteMetadataStore({ stateDb })
    const ws = await meta.upsertWorkspace({ dir: '/proj/a' })
    await meta.upsertThread({ id: 't1', workspaceId: ws.id })

    const transcriptsDir = join(freshDir(), 'transcripts')
    mkdirSync(transcriptsDir)
    writeFileSync(join(transcriptsDir, 't1.jsonl'), JSON.stringify(userPromptEntry('u1', 'legacy')) + '\n')

    const transcript = await createTranscriptStore({ stateDb, transcriptsDir })

    expect(transcript).toBeInstanceOf(SqliteTranscriptStore)
    expect(await transcript.read('t1')).toEqual([userPromptEntry('u1', 'legacy')])
    expect(existsSync(transcriptsDir)).toBe(false)
    expect(existsSync(`${transcriptsDir}.bak`)).toBe(true)
    stateDb.close()
  })

  it('skipImport leaves the legacy dir strictly alone (the in-memory fallback path)', async () => {
    const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
    const transcriptsDir = join(freshDir(), 'transcripts')
    mkdirSync(transcriptsDir)
    writeFileSync(join(transcriptsDir, 't1.jsonl'), JSON.stringify(userPromptEntry('u1', 'x')) + '\n')

    const transcript = await createTranscriptStore({ stateDb, transcriptsDir, skipImport: true })

    expect(await transcript.read('t1')).toEqual([])
    expect(existsSync(transcriptsDir)).toBe(true)
    expect(existsSync(`${transcriptsDir}.bak`)).toBe(false)
    stateDb.close()
  })

  it('skips the import on a LOCKED stateDb (fail-closed) but still serves the store', async () => {
    const dir = freshDir()
    const path = join(dir, 'locked.sqlite')
    const raw = openStateDb({ path, migrations: STATE_MIGRATIONS })
    raw.db.exec('PRAGMA user_version = 99')
    raw.close()
    const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
    expect(stateDb.locked).toBe(true)

    const transcriptsDir = join(dir, 'transcripts')
    mkdirSync(transcriptsDir)
    writeFileSync(join(transcriptsDir, 't1.jsonl'), JSON.stringify(userPromptEntry('u1', 'x')) + '\n')

    const transcript = await createTranscriptStore({ stateDb, transcriptsDir })

    expect(await transcript.read('t1')).toEqual([]) // locked reads empty
    expect(existsSync(transcriptsDir)).toBe(true) // nothing imported or renamed
    stateDb.close()
  })
})
