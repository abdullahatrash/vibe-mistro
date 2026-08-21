import { describe, expect, it } from 'vitest'
import type { TranscriptEntry, TranscriptEntryEvent } from '../../shared/ipc'
import { createTranscriptEcho, isEchoedEntry } from './routine-echo'

function harness(tombstoned: string[] = []): {
  echo: ReturnType<typeof createTranscriptEcho>
  teed: Array<{ threadId: string | null; entry: TranscriptEntry }>
  sent: TranscriptEntryEvent[]
} {
  const teed: Array<{ threadId: string | null; entry: TranscriptEntry }> = []
  const sent: TranscriptEntryEvent[] = []
  const echo = createTranscriptEcho({
    bridge: {
      tee: (threadId, entry) => {
        teed.push({ threadId, entry })
      },
      isTombstoned: (threadId) => tombstoned.includes(threadId),
    },
    send: (event) => sent.push(event),
  })
  return { echo, teed, sent }
}

describe('isEchoedEntry', () => {
  it('echoes the entries a live view cannot derive for itself', () => {
    expect(isEchoedEntry({ t: 'user-prompt', id: 'a', text: 'hi' })).toBe(true)
    expect(isEchoedEntry({ t: 'routine-late', dueAt: 1, lastRunAt: null })).toBe(true)
    expect(isEchoedEntry({ t: 'turn-complete' })).toBe(true)
    expect(isEchoedEntry({ t: 'turn-error', message: 'boom' })).toBe(true)
    expect(isEchoedEntry({ t: 'agent-rebound' })).toBe(true)
  })

  it('refuses a streamed acp event — the forward already delivered it', () => {
    expect(isEchoedEntry({ t: 'acp-event', payload: { method: 'session/update' } })).toBe(false)
  })

  it('refuses a permission answer — it is teed where a renderer already exists', () => {
    expect(
      isEchoedEntry({ t: 'resolve-permission', requestId: 1, optionId: 'allow_once', name: null }),
    ).toBe(false)
  })
})

describe('createTranscriptEcho', () => {
  it('tees and pushes an entry a live view is missing', () => {
    const { echo, teed, sent } = harness()
    const entry: TranscriptEntry = { t: 'user-prompt', id: 'a', text: 'triage', routine: { name: 'Morning triage' } }
    echo('t1', entry)
    expect(teed).toEqual([{ threadId: 't1', entry }])
    expect(sent).toEqual([{ threadId: 't1', entry }])
  })

  it('tees but does NOT push what the live view already has', () => {
    const { echo, teed, sent } = harness()
    echo('t1', { t: 'acp-event', payload: {} })
    expect(teed).toHaveLength(1)
    expect(sent).toHaveLength(0)
  })

  it('pushes nothing for a tombstoned Thread — the tee drops it too', () => {
    const { echo, sent } = harness(['gone'])
    echo('gone', { t: 'turn-error', message: 'too late' })
    expect(sent).toHaveLength(0)
  })

  it('pushes nothing when the Thread could not be resolved', () => {
    const { echo, teed, sent } = harness()
    echo(null, { t: 'turn-complete' })
    expect(teed).toEqual([{ threadId: null, entry: { t: 'turn-complete' } }])
    expect(sent).toHaveLength(0)
  })
})
