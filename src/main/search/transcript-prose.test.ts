import { describe, expect, it } from 'vitest'
import type { TranscriptEntry } from '../../shared/ipc'
import { buildSnippet, extractProse, proseEntries } from './transcript-prose'

/** An `acp-event` transcript entry wrapping one `session/update`. */
function acpEvent(update: unknown): TranscriptEntry {
  return { t: 'acp-event', payload: { method: 'session/update', params: { update } } }
}

function agentChunk(text: string): TranscriptEntry {
  return acpEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text }, messageId: 'm1' })
}

describe('extractProse', () => {
  it('extracts user prompts and agent message chunks (the conversation proper)', () => {
    expect(extractProse({ t: 'user-prompt', id: 'p1', text: 'fix the pool' })).toBe('fix the pool')
    expect(extractProse(agentChunk('use execFileAsync here'))).toBe('use execFileAsync here')
  })

  it('ignores reasoning, tool payloads, and non-conversation entries (CONTEXT.md Search)', () => {
    expect(
      extractProse(acpEvent({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } })),
    ).toBeNull()
    expect(
      extractProse(acpEvent({ sessionUpdate: 'tool_call', toolCallId: 'tc1', rawInput: { cmd: 'grep secret' } })),
    ).toBeNull()
    expect(extractProse({ t: 'turn-complete' })).toBeNull()
    expect(extractProse({ t: 'agent-rebound' })).toBeNull()
  })

  it('tolerates malformed payloads and empty text', () => {
    expect(extractProse({ t: 'acp-event', payload: null })).toBeNull()
    expect(extractProse({ t: 'acp-event', payload: { method: 'other' } })).toBeNull()
    expect(extractProse(acpEvent({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 42 } }))).toBeNull()
    expect(extractProse(agentChunk(''))).toBeNull()
    expect(extractProse({ t: 'user-prompt', id: 'p', text: '' })).toBeNull()
  })
})

describe('proseEntries', () => {
  it('keeps transcript line indexes (the jump pointer) and drops non-prose lines', () => {
    const entries: TranscriptEntry[] = [
      { t: 'user-prompt', id: 'p1', text: 'hello' },
      acpEvent({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } }),
      agentChunk('answer'),
      { t: 'turn-complete' },
    ]
    expect(proseEntries(entries)).toEqual([
      { index: 0, text: 'hello' },
      { index: 2, text: 'answer' },
    ])
  })
})

describe('buildSnippet', () => {
  it('windows around the first matched token with ellipses and collapsed whitespace', () => {
    const text = `${'x'.repeat(100)} the warm\n\npool  answer ${'y'.repeat(100)}`
    const snippet = buildSnippet(text, ['pool'])
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('warm pool answer')
    expect(snippet.length).toBeLessThanOrEqual(92) // 90 + both ellipses
  })

  it('keeps short texts whole (no ellipses) and falls back to the start on no positional match', () => {
    expect(buildSnippet('short answer', ['answer'])).toBe('short answer')
    // Accent mismatch: folded token not found by toLowerCase search → entry start.
    expect(buildSnippet('Réviser le café', ['cafe'])).toBe('Réviser le café')
  })
})
