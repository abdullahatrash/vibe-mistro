import { describe, expect, it } from 'vitest'
import {
  addContext,
  contextKey,
  removeContext,
  serializeForSend,
  type PendingContext,
} from './pending-contexts'

const teach: PendingContext = { kind: 'skill', name: 'teach', description: 'Teach mode' }
const review: PendingContext = { kind: 'skill', name: 'review' }

describe('serializeForSend', () => {
  it('prepends the skill invocation to the prose', () => {
    expect(serializeForSend('explain closures', [teach])).toBe('/teach explain closures')
  })

  it('sends a bare invocation when there is no prose', () => {
    expect(serializeForSend('', [teach])).toBe('/teach')
    expect(serializeForSend('   ', [teach])).toBe('/teach')
  })

  it('passes the prose through untouched when nothing is staged', () => {
    expect(serializeForSend('fix the login bug', [])).toBe('fix the login bug')
  })
})

describe('addContext', () => {
  it('replaces an already-staged skill — the agent only honors one leading invocation', () => {
    const staged = addContext([], teach)
    expect(addContext(staged, review)).toEqual([review])
  })
})

describe('removeContext', () => {
  it('removes the chip whose key matches, leaving the rest', () => {
    const staged = addContext([], teach)
    expect(removeContext(staged, contextKey(teach))).toEqual([])
    expect(removeContext(staged, contextKey(review))).toEqual(staged)
  })
})
