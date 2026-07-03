import { describe, it, expect } from 'vitest'
import {
  acpEventEntry,
  agentReboundEntry,
  parseTranscript,
  resolvePermissionEntry,
  sessionIdFromPayload,
  titleFromSessionInfoUpdate,
  TRANSCRIPT_SCHEMA_VERSION,
  transcriptVersionOf,
  turnCompleteEntry,
  turnErrorEntry,
  userPromptEntry,
} from './transcript'

/**
 * The engine-independent transcript pieces (#298 — the JSONL engine itself is
 * gone; the live store's behaviors are pinned in sqlite-transcript-store.test):
 * the entry builders, the tolerant legacy-JSONL parser the one-time importer
 * still uses, and the pure payload extractors.
 */

const HEADER_LINE = `{"t":"__transcript_header","v":${TRANSCRIPT_SCHEMA_VERSION}}`

describe('parseTranscript (the legacy importer reader)', () => {
  it('round-trips clean newline-delimited JSON, dropping the version header', () => {
    const entries = [
      userPromptEntry('u1', 'hello'),
      acpEventEntry({ method: 'session/update', params: { sessionId: 's' } }),
      turnCompleteEntry(),
    ]
    const raw = [HEADER_LINE, ...entries.map((e) => JSON.stringify(e))].join('\n') + '\n'
    expect(parseTranscript(raw)).toEqual(entries)
  })

  it('tolerates a malformed/partial trailing line: parses the valid prefix, no throw', () => {
    const raw =
      JSON.stringify(userPromptEntry('u1', 'ok')) + '\n' + '{"t":"acp-event","payload":{ torn'
    expect(parseTranscript(raw)).toEqual([userPromptEntry('u1', 'ok')])
  })

  it('drops foreign/garbled-but-parseable JSON lines (unknown tags)', () => {
    const raw = [
      '{"t":"not-a-real-tag"}',
      '"just a string"',
      JSON.stringify(turnCompleteEntry()),
    ].join('\n')
    expect(parseTranscript(raw)).toEqual([turnCompleteEntry()])
  })

  it('parses a user-prompt WITH image refs and a legacy one WITHOUT, side by side', () => {
    const withImages = userPromptEntry('u1', 'see this', [{ file: 'a.png', mimeType: 'image/png' }])
    const legacy = { t: 'user-prompt', id: 'u2', text: 'plain' }
    const parsed = parseTranscript([JSON.stringify(withImages), JSON.stringify(legacy)].join('\n'))
    expect(parsed[0]).toEqual(withImages)
    expect(parsed[1]).toEqual(legacy)
  })

  it('transcriptVersionOf reads the header version, or 1 for a legacy header-less log', () => {
    expect(transcriptVersionOf(HEADER_LINE + '\n')).toBe(TRANSCRIPT_SCHEMA_VERSION)
    expect(transcriptVersionOf('{"t":"__transcript_header","v":7}\n')).toBe(7)
    expect(transcriptVersionOf(JSON.stringify(userPromptEntry('u1', 'x')) + '\n')).toBe(1)
    expect(transcriptVersionOf('')).toBe(1)
  })
})

describe('entry constructors mirror the reducer inputs', () => {
  it('builds tagged entries matching the ConversationAction shapes', () => {
    expect(userPromptEntry('id-1', 'text')).toEqual({ t: 'user-prompt', id: 'id-1', text: 'text' })
    expect(acpEventEntry({ x: 1 })).toEqual({ t: 'acp-event', payload: { x: 1 } })
    expect(turnCompleteEntry()).toEqual({ t: 'turn-complete' })
    expect(turnErrorEntry('boom')).toEqual({ t: 'turn-error', message: 'boom' })
    expect(agentReboundEntry()).toEqual({ t: 'agent-rebound' })
    expect(resolvePermissionEntry(7, 'allow')).toEqual({
      t: 'resolve-permission',
      requestId: 7,
      optionId: 'allow',
      name: null,
    })
  })

  it('userPromptEntry carries image refs when given, omitting the field when absent or empty', () => {
    const refs = [{ file: 'a.png', mimeType: 'image/png' }]
    expect(userPromptEntry('u', 't', refs)).toEqual({
      t: 'user-prompt',
      id: 'u',
      text: 't',
      images: refs,
    })
    expect(userPromptEntry('u', 't')).toEqual({ t: 'user-prompt', id: 'u', text: 't' })
    expect(userPromptEntry('u', 't', [])).toEqual({ t: 'user-prompt', id: 'u', text: 't' })
  })
})

describe('sessionIdFromPayload (routing)', () => {
  it('extracts the sessionId from session/update and session/request_permission payloads', () => {
    expect(sessionIdFromPayload({ method: 'session/update', params: { sessionId: 'sess-1' } })).toBe(
      'sess-1',
    )
    expect(
      sessionIdFromPayload({
        method: 'session/request_permission',
        id: 3,
        params: { sessionId: 'sess-2' },
      }),
    ).toBe('sess-2')
  })

  it('returns null when no string sessionId is present (lifecycle / garbage)', () => {
    expect(sessionIdFromPayload({ type: 'exit', code: 0 })).toBeNull()
    expect(sessionIdFromPayload({ method: 'session/update', params: { sessionId: 7 } })).toBeNull()
    expect(sessionIdFromPayload(null)).toBeNull()
    expect(sessionIdFromPayload('nope')).toBeNull()
  })
})

describe('titleFromSessionInfoUpdate (auto-title capture)', () => {
  it('extracts the title from a session_info_update session/update', () => {
    expect(
      titleFromSessionInfoUpdate({
        method: 'session/update',
        params: {
          sessionId: 's',
          update: { sessionUpdate: 'session_info_update', title: 'Fix the bug' },
        },
      }),
    ).toBe('Fix the bug')
  })

  it('returns null for other session/update kinds, blank titles, and non-update payloads', () => {
    expect(
      titleFromSessionInfoUpdate({
        method: 'session/update',
        params: {
          sessionId: 's',
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } },
        },
      }),
    ).toBeNull()
    expect(
      titleFromSessionInfoUpdate({
        method: 'session/update',
        params: { sessionId: 's', update: { sessionUpdate: 'session_info_update', title: '' } },
      }),
    ).toBeNull()
    expect(titleFromSessionInfoUpdate({ type: 'exit' })).toBeNull()
    expect(titleFromSessionInfoUpdate(null)).toBeNull()
  })
})
