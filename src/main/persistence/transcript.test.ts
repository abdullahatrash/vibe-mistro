import { describe, it, expect, afterAll } from 'vitest'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  acpEventEntry,
  parseTranscript,
  resolvePermissionEntry,
  TranscriptStore,
  userPromptEntry,
  type TranscriptEntry,
} from './transcript'

/**
 * The main-side per-Thread JSONL transcript (ADR-0005: vibe owns agent context,
 * we own the visible history). Exercised over a REAL temp dir via the injectable
 * append/read seam, mirroring metadata-store.test.ts / fs-write.test.ts — no
 * `userData`, no `vibe-acp` spawned.
 */

const dir = mkdtempSync(join(tmpdir(), 'vibe-transcript-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** A store writing `<threadId>.jsonl` files into the shared temp dir. */
function storeAt(): TranscriptStore {
  return new TranscriptStore({ dir })
}

describe('TranscriptStore append', () => {
  it('appends a user-prompt entry to <threadId>.jsonl', async () => {
    const store = storeAt()
    await store.append('thread-up', { t: 'user-prompt', id: 'u1', text: 'hello' })

    const raw = readFileSync(join(dir, 'thread-up.jsonl'), 'utf8')
    expect(raw).toBe('{"t":"user-prompt","id":"u1","text":"hello"}\n')
  })

  it('appends acp-event then resolve-permission in order, append-only across turns', async () => {
    const store = storeAt()
    const id = 'thread-order'

    // First turn: prompt -> a streamed event -> a permission response.
    await store.append(id, { t: 'user-prompt', id: 'u1', text: 'go' })
    await store.append(id, { t: 'acp-event', payload: { method: 'session/update' } })
    await store.append(id, { t: 'resolve-permission', requestId: 7, optionId: 'allow', name: 'Allow' })

    const afterFirst = readFileSync(join(dir, `${id}.jsonl`), 'utf8')

    // A second turn appends WITHOUT rewriting the earlier lines.
    await store.append(id, { t: 'user-prompt', id: 'u2', text: 'again' })

    const lines = readFileSync(join(dir, `${id}.jsonl`), 'utf8').trimEnd().split('\n')
    expect(lines).toEqual([
      '{"t":"user-prompt","id":"u1","text":"go"}',
      '{"t":"acp-event","payload":{"method":"session/update"}}',
      '{"t":"resolve-permission","requestId":7,"optionId":"allow","name":"Allow"}',
      '{"t":"user-prompt","id":"u2","text":"again"}',
    ])
    // The first three lines are byte-identical to before the second turn (append-only).
    expect(readFileSync(join(dir, `${id}.jsonl`), 'utf8').startsWith(afterFirst)).toBe(true)
  })
})

describe('TranscriptStore read / parseTranscript', () => {
  const entries: TranscriptEntry[] = [
    { t: 'user-prompt', id: 'u1', text: 'hi' },
    { t: 'acp-event', payload: { method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk' } } } },
    { t: 'resolve-permission', requestId: 'r1', optionId: 'deny', name: 'Deny' },
  ]

  it('reads a clean log back into the entry array, in order', async () => {
    const store = storeAt()
    const id = 'thread-read'
    for (const entry of entries) await store.append(id, entry)

    expect(await store.read(id)).toEqual(entries)
  })

  it('returns [] for a Thread with no log yet (never throws)', async () => {
    expect(await storeAt().read('thread-absent')).toEqual([])
  })

  it('parseTranscript round-trips clean newline-delimited JSON', () => {
    const raw = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
    expect(parseTranscript(raw)).toEqual(entries)
  })

  it('tolerates a malformed/partial trailing line: parses the valid prefix, no throw', () => {
    // A crash mid-append leaves the final record torn (no closing brace, no \n).
    const torn =
      '{"t":"user-prompt","id":"u1","text":"hi"}\n' +
      '{"t":"acp-event","payload":{"a":1}}\n' +
      '{"t":"resolve-permission","requestId":2,"opti'

    expect(() => parseTranscript(torn)).not.toThrow()
    expect(parseTranscript(torn)).toEqual([
      { t: 'user-prompt', id: 'u1', text: 'hi' },
      { t: 'acp-event', payload: { a: 1 } },
    ])
  })

  it('read() tolerates a torn trailing line written to a real temp file', async () => {
    const id = 'thread-torn'
    const store = storeAt()
    await store.append(id, { t: 'user-prompt', id: 'u1', text: 'hi' })
    // Simulate a torn write by appending a partial (non-terminated) JSON line.
    appendFileSync(join(dir, `${id}.jsonl`), '{"t":"acp-event","payl')

    const read = await store.read(id)
    expect(read).toEqual([{ t: 'user-prompt', id: 'u1', text: 'hi' }])
  })
})

describe('TranscriptStore best-effort', () => {
  it('append does not propagate when the underlying writer throws', async () => {
    const store = new TranscriptStore({
      dir,
      append: async () => {
        throw new Error('ENOSPC: no space left on device')
      },
    })
    // The tee must NEVER break the live conversation — a failing append is swallowed.
    await expect(store.append('thread-fail', { t: 'user-prompt', id: 'u1', text: 'x' })).resolves.toBeUndefined()
  })
})

describe('entry constructors mirror the reducer inputs', () => {
  it('builds tagged entries matching the ConversationAction shapes', () => {
    expect(userPromptEntry('u1', 'hi')).toEqual({ t: 'user-prompt', id: 'u1', text: 'hi' })
    expect(acpEventEntry({ method: 'session/update' })).toEqual({
      t: 'acp-event',
      payload: { method: 'session/update' },
    })
    expect(resolvePermissionEntry(7, 'allow', 'Allow')).toEqual({
      t: 'resolve-permission',
      requestId: 7,
      optionId: 'allow',
      name: 'Allow',
    })
    // Main may not know the chosen option's display name at the chokepoint
    // (respondPermission carries only requestId + optionId); name is then null.
    expect(resolvePermissionEntry('r1', 'deny')).toEqual({
      t: 'resolve-permission',
      requestId: 'r1',
      optionId: 'deny',
      name: null,
    })
  })
})
