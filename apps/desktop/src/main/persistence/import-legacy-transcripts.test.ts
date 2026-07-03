import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importLegacyTranscripts } from './import-legacy-transcripts'
import { openStateDb, type StateDb } from './sqlite-db'
import { SqliteMetadataStore } from './sqlite-metadata-store'
import { SqliteTranscriptStore } from './sqlite-transcript-store'
import { STATE_MIGRATIONS } from './state-migrations'
import { turnCompleteEntry, userPromptEntry } from './transcript'

/**
 * The one-time JSONL -> SQLite transcript import (ADR-0019). Real temp-dir
 * transcript files (with the v1 version header and torn trailing lines) into
 * `:memory:` target stores, covering the per-file self-gating: already-imported
 * skip, orphan skip, partial failure keeping the dir, and the `.bak` rename.
 */

const root = mkdtempSync(join(tmpdir(), 'vibe-import-transcripts-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let seq = 0
function freshDir(): string {
  const dir = join(root, `transcripts-${++seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const HEADER = '{"t":"__transcript_header","v":1}'

function writeJsonl(dir: string, threadId: string, lines: string[]): void {
  writeFileSync(join(dir, `${threadId}.jsonl`), lines.join('\n') + '\n')
}

interface Fixture {
  stateDb: StateDb
  meta: SqliteMetadataStore
  store: SqliteTranscriptStore
}

async function fixture(): Promise<Fixture> {
  const stateDb = openStateDb({ path: ':memory:', migrations: STATE_MIGRATIONS })
  const meta = new SqliteMetadataStore({ stateDb })
  const store = new SqliteTranscriptStore({ stateDb })
  return { stateDb, meta, store }
}

async function boundThread(meta: SqliteMetadataStore, id: string): Promise<void> {
  const ws = await meta.upsertWorkspace({ dir: `/proj/${id}` })
  await meta.upsertThread({ id, workspaceId: ws.id })
}

describe('importLegacyTranscripts', () => {
  it('imports every file (header + torn line tolerated) and renames the dir to .bak', async () => {
    const dir = freshDir()
    const { meta, store } = await fixture()
    await boundThread(meta, 't1')
    await boundThread(meta, 't2')
    writeJsonl(dir, 't1', [
      HEADER,
      JSON.stringify(userPromptEntry('u1', 'hello')),
      JSON.stringify(turnCompleteEntry()),
      '{ torn trailing wri', // crash mid-append — must be skipped, not fatal
    ])
    writeJsonl(dir, 't2', [JSON.stringify(userPromptEntry('u2', 'legacy header-less'))])

    const result = await importLegacyTranscripts({ dir, store })

    expect(result).toMatchObject({ outcome: 'imported', imported: 2, failures: 0 })
    expect(await store.read('t1')).toEqual([userPromptEntry('u1', 'hello'), turnCompleteEntry()])
    expect(await store.read('t2')).toEqual([userPromptEntry('u2', 'legacy header-less')])
    // The dir moved wholesale to .bak — bytes preserved, originals gone.
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(`${dir}.bak`, 't1.jsonl'), 'utf8')).toContain('torn trailing wri')
  })

  it('skips when the transcripts dir is absent (the steady state after migration)', async () => {
    const { store } = await fixture()
    const result = await importLegacyTranscripts({ dir: join(root, 'never-existed'), store })
    expect(result.outcome).toBe('skipped-absent')
  })

  it('skips orphan files (no metadata row) but still completes and renames', async () => {
    const dir = freshDir()
    const { meta, store } = await fixture()
    await boundThread(meta, 'kept')
    writeJsonl(dir, 'kept', [JSON.stringify(userPromptEntry('u1', 'kept'))])
    writeJsonl(dir, 'orphan', [JSON.stringify(userPromptEntry('u2', 'lost thread'))])

    const result = await importLegacyTranscripts({ dir, store })

    expect(result).toMatchObject({ outcome: 'imported', imported: 1, orphans: 1, failures: 0 })
    expect(await store.read('orphan')).toEqual([])
    expect(existsSync(join(`${dir}.bak`, 'orphan.jsonl'))).toBe(true) // preserved bytes
  })

  it('a per-file failure keeps the dir, and the retry imports ONLY what is missing', async () => {
    const dir = freshDir()
    const { meta, store } = await fixture()
    await boundThread(meta, 'ok')
    await boundThread(meta, 'flaky')
    writeJsonl(dir, 'ok', [JSON.stringify(userPromptEntry('u1', 'fine'))])
    writeJsonl(dir, 'flaky', [JSON.stringify(userPromptEntry('u2', 'fails first'))])

    // First run: reading flaky.jsonl blows up.
    const failing = await importLegacyTranscripts({
      dir,
      store,
      readFileAt: async (path) => {
        if (path.endsWith('flaky.jsonl')) throw new Error('EIO')
        return readFileSync(path, 'utf8')
      },
    })
    expect(failing).toMatchObject({ outcome: 'partial', imported: 1, failures: 1 })
    expect(existsSync(dir)).toBe(true) // kept for retry
    expect(await store.read('ok')).toEqual([userPromptEntry('u1', 'fine')])

    // Retry (healthy fs): 'ok' is skipped via hasEntries — never duplicated —
    // and 'flaky' lands; the dir then renames.
    const retry = await importLegacyTranscripts({ dir, store })
    expect(retry).toMatchObject({ outcome: 'imported', imported: 1, skipped: 1, failures: 0 })
    expect(await store.read('ok')).toEqual([userPromptEntry('u1', 'fine')]) // still exactly one
    expect(await store.read('flaky')).toEqual([userPromptEntry('u2', 'fails first')])
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(`${dir}.bak`)).toBe(true)
  })

  it("a failed dir rename still reports 'imported'; the next run only retries the rename", async () => {
    const dir = freshDir()
    const { meta, store } = await fixture()
    await boundThread(meta, 't1')
    writeJsonl(dir, 't1', [JSON.stringify(userPromptEntry('u1', 'text'))])

    const result = await importLegacyTranscripts({
      dir,
      store,
      renameDir: async () => {
        throw new Error('EACCES')
      },
    })
    expect(result.outcome).toBe('imported')
    expect(existsSync(dir)).toBe(true)

    const again = await importLegacyTranscripts({ dir, store })
    expect(again).toMatchObject({ outcome: 'imported', imported: 0, skipped: 1 })
    expect(await store.read('t1')).toHaveLength(1) // no duplication
    expect(existsSync(`${dir}.bak`)).toBe(true)
  })

  it('ignores non-JSONL files (they ride along into the .bak)', async () => {
    const dir = freshDir()
    const { store } = await fixture()
    writeFileSync(join(dir, '.DS_Store'), 'junk')

    const result = await importLegacyTranscripts({ dir, store })
    expect(result).toMatchObject({ outcome: 'imported', imported: 0 })
    expect(existsSync(join(`${dir}.bak`, '.DS_Store'))).toBe(true)
  })
})
