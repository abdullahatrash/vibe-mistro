import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTranscriptStore } from './create-transcript-store'
import { openStateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import { STATE_MIGRATIONS } from './state-migrations'
import { TranscriptStore, userPromptEntry } from './transcript'

/**
 * The transcript-store construction seam (ADR-0019): the engine follows the
 * metadata store's stateDb (never split-brain), with the one-time JSONL import
 * wired into the SQLite path.
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
  it('selects SQLite when a stateDb is provided and imports legacy JSONL on the way', async () => {
    const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
    const meta = new SqliteMetadataStore({ stateDb })
    const ws = await meta.upsertWorkspace({ dir: '/proj/a' })
    await meta.upsertThread({ id: 't1', workspaceId: ws.id })

    const transcriptsDir = join(freshDir(), 'transcripts')
    mkdirSync(transcriptsDir)
    writeFileSync(join(transcriptsDir, 't1.jsonl'), JSON.stringify(userPromptEntry('u1', 'legacy')) + '\n')

    const { transcript, engine } = await createTranscriptStore({ stateDb, transcriptsDir })

    expect(engine).toBe('sqlite')
    expect(transcript).toBeInstanceOf(SqliteTranscriptStore)
    expect(await transcript?.read('t1')).toEqual([userPromptEntry('u1', 'legacy')])
    expect(existsSync(transcriptsDir)).toBe(false)
    expect(existsSync(`${transcriptsDir}.bak`)).toBe(true)
    stateDb.close()
  })

  it('selects the legacy JSONL store when stateDb is null (engines move together)', async () => {
    const transcriptsDir = join(freshDir(), 'transcripts')
    const { transcript, engine } = await createTranscriptStore({ stateDb: null, transcriptsDir })

    expect(engine).toBe('json')
    expect(transcript).toBeInstanceOf(TranscriptStore)
    expect(existsSync(transcriptsDir)).toBe(true) // legacy path mkdirs its home
  })

  it('skips the import on a LOCKED stateDb (fail-closed) but still serves the store', async () => {
    const path = join(freshDir(), 'locked.sqlite')
    const raw = openStateDb({ path, migrations: STATE_MIGRATIONS })
    raw.db.exec('PRAGMA user_version = 99')
    raw.close()
    const stateDb = openStateDb({ path, migrations: STATE_MIGRATIONS })
    expect(stateDb.locked).toBe(true)

    const transcriptsDir = join(freshDir(), 'transcripts')
    mkdirSync(transcriptsDir)
    writeFileSync(join(transcriptsDir, 't1.jsonl'), JSON.stringify(userPromptEntry('u1', 'x')) + '\n')

    const { transcript, engine } = await createTranscriptStore({ stateDb, transcriptsDir })

    expect(engine).toBe('sqlite')
    expect(await transcript?.read('t1')).toEqual([]) // locked reads empty
    expect(existsSync(transcriptsDir)).toBe(true) // nothing imported or renamed
    stateDb.close()
  })
})
