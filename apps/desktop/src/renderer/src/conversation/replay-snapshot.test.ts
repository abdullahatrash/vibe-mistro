import { describe, it, expect } from 'vitest'
import type { TranscriptEntry } from '../../../shared/ipc'
import {
  foldTranscriptTail,
  parseSnapshotState,
  replayTranscript,
  shouldPutSnapshot,
} from './replay'

/**
 * The renderer half of the durable fold snapshots (ADR-0019, #297), as pure
 * modules (node env, no DOM): the snapshot+tail fold must equal the full fold
 * (the correctness core of the tiered reopen), blob parsing must fail safe,
 * and the put policy is pinned as a matrix.
 */

function chunk(text: string, messageId: string): TranscriptEntry {
  return {
    t: 'acp-event',
    payload: {
      method: 'session/update',
      params: {
        sessionId: 'sess-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId },
      },
    },
  }
}

function permissionRequest(requestId: number): TranscriptEntry {
  return {
    t: 'acp-event',
    payload: {
      method: 'session/request_permission',
      id: requestId,
      params: {
        sessionId: 'sess-1',
        toolCall: { toolCallId: 'tc-1', title: 'Run tests' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    },
  }
}

const FULL_LOG: TranscriptEntry[] = [
  { t: 'user-prompt', id: 'u1', text: 'run the tests' },
  chunk('Running ', 'm1'),
  permissionRequest(7),
  { t: 'resolve-permission', requestId: 7, optionId: 'allow', name: null },
  chunk('them now.', 'm1'),
  { t: 'turn-complete' },
  { t: 'user-prompt', id: 'u2', text: 'and lint too' },
  chunk('Linting.', 'm2'),
  { t: 'turn-error', message: 'agent exited' },
]

describe('foldTranscriptTail ≡ full fold (the tiering correctness core)', () => {
  it('snapshot(prefix) + fold(tail) equals replay(whole log) at EVERY split point', () => {
    const full = replayTranscript(FULL_LOG)
    for (let split = 0; split <= FULL_LOG.length; split++) {
      // The durable round-trip: the prefix state goes through JSON like a real blob.
      const prefix = replayTranscript(FULL_LOG.slice(0, split))
      const base = parseSnapshotState(JSON.stringify(prefix))
      expect(base).not.toBeNull()
      const tiered = foldTranscriptTail(base!, FULL_LOG.slice(split))
      expect(tiered).toEqual(full)
    }
  })

  it('recovers a permission option name from the BASE state when the resolve is in the tail', () => {
    // The request folded into the snapshot; the answer arrives in the tail —
    // the reopen-only name recovery must see across the boundary.
    const base = replayTranscript(FULL_LOG.slice(0, 3)) // ends after permissionRequest(7)
    const tiered = foldTranscriptTail(
      parseSnapshotState(JSON.stringify(base))!,
      FULL_LOG.slice(3, 6), // resolve-permission + closing chunk + turn-complete
    )
    const permission = tiered.items.find((i) => i.kind === 'permission')
    expect(permission?.kind).toBe('permission')
    // The resolved option shows its display NAME, recovered from the base's item.
    expect(JSON.stringify(permission)).toContain('Allow')
  })

  it('forces isProcessing false after folding a tail cut off mid-turn', () => {
    const base = replayTranscript(FULL_LOG.slice(0, 6))
    // Tail ends on a user-prompt with no terminal entry (app closed mid-turn).
    const tiered = foldTranscriptTail(base, [{ t: 'user-prompt', id: 'u3', text: 'cut off' }])
    expect(tiered.isProcessing).toBe(false)
  })

  it('an empty tail returns the base state as-is (the O(1) reopen)', () => {
    const base = replayTranscript(FULL_LOG)
    expect(foldTranscriptTail(base, [])).toEqual(base)
  })
})

describe('parseSnapshotState (fail-safe blob parsing)', () => {
  it('round-trips a real folded state', () => {
    const state = replayTranscript(FULL_LOG)
    expect(parseSnapshotState(JSON.stringify(state))).toEqual(state)
  })

  it.each([
    ['torn JSON', '{"items":[1,'],
    ['not an object', '"just a string"'],
    ['null', 'null'],
    ['missing items', '{"isProcessing":false,"availableCommands":[]}'],
    ['items not an array', '{"items":{},"isProcessing":false,"availableCommands":[]}'],
    ['missing isProcessing', '{"items":[],"availableCommands":[]}'],
    ['missing availableCommands', '{"items":[],"isProcessing":false}'],
  ])('rejects %s with null (caller falls back to forceFull)', (_label, blob) => {
    expect(parseSnapshotState(blob)).toBeNull()
  })
})

describe('shouldPutSnapshot (the put policy matrix)', () => {
  const base = { usedSnapshot: false, tailLength: 3, hasImages: false, itemCount: 5, lastSeq: 42 }

  it('puts after a fresh full fold', () => {
    expect(shouldPutSnapshot(base)).toBe(true)
  })
  it('puts after a snapshot hydrate that folded a non-empty tail (horizon advanced)', () => {
    expect(shouldPutSnapshot({ ...base, usedSnapshot: true })).toBe(true)
  })
  it('skips when the snapshot was used and the tail was empty (nothing improved)', () => {
    expect(shouldPutSnapshot({ ...base, usedSnapshot: true, tailLength: 0 })).toBe(false)
  })
  it('skips on the legacy engine (lastSeq 0) — it never snapshots', () => {
    expect(shouldPutSnapshot({ ...base, lastSeq: 0 })).toBe(false)
  })
  it('skips an empty view', () => {
    expect(shouldPutSnapshot({ ...base, itemCount: 0 })).toBe(false)
  })
  it('skips image-bearing states (data URLs must not copy image bytes into the db)', () => {
    expect(shouldPutSnapshot({ ...base, hasImages: true })).toBe(false)
  })
})
