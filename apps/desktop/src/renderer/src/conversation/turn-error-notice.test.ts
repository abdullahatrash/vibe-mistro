import { describe, expect, it } from 'vitest'
import {
  COMPACTION_FAILED_CODE,
  CONTEXT_TOO_LONG_CODE,
  IMAGES_UNSUPPORTED_CODE,
  turnErrorNotice,
} from './turn-error-notice'

describe('turnErrorNotice', () => {
  it('keeps the agent\'s own message for a code we do not understand', () => {
    expect(turnErrorNotice(-31001, 'Rate limited')).toBe('Rate limited')
    expect(turnErrorNotice(null, 'Something broke')).toBe('Something broke')
    expect(turnErrorNotice(undefined, 'Something broke')).toBe('Something broke')
  })

  it('tells an images failure how to recover (#100)', () => {
    const notice = turnErrorNotice(IMAGES_UNSUPPORTED_CODE, 'raw agent message')
    expect(notice).toMatch(/vision-capable/i)
    expect(notice).not.toBe('raw agent message')
  })

  it('points an exhausted context at /compact or a new Thread (#433)', () => {
    const notice = turnErrorNotice(CONTEXT_TOO_LONG_CODE, 'context too long')
    expect(notice).toMatch(/\/compact/)
    expect(notice).toMatch(/new Thread/i)
  })

  it('tells a failed compaction that the Thread may be unrecoverable (#433)', () => {
    const notice = turnErrorNotice(COMPACTION_FAILED_CODE, 'compaction failed')
    expect(notice).toMatch(/new Thread/i)
  })

  it('gives every code we claim to handle its own distinct message', () => {
    const codes = [IMAGES_UNSUPPORTED_CODE, CONTEXT_TOO_LONG_CODE, COMPACTION_FAILED_CODE]
    const notices = codes.map((code) => turnErrorNotice(code, 'fallback'))
    expect(new Set(notices).size).toBe(codes.length)
    expect(notices).not.toContain('fallback')
  })
})
