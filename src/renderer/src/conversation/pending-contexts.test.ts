import { describe, expect, it } from 'vitest'
import {
  addContext,
  contextKey,
  extractAttachedFiles,
  removeContext,
  serializeForSend,
  type PendingContext,
} from './pending-contexts'

const teach: PendingContext = { kind: 'skill', name: 'teach', description: 'Teach mode' }
const review: PendingContext = { kind: 'skill', name: 'review' }
const reducerFile: PendingContext = { kind: 'file', path: 'src/renderer/src/conversation/reducer.ts' }
const composerFile: PendingContext = { kind: 'file', path: 'src/renderer/src/conversation/Composer.tsx' }

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

  it('appends staged files as an @-mention marker block after the prose', () => {
    expect(serializeForSend('refactor these', [reducerFile, composerFile])).toBe(
      'refactor these\n\n<attached_files>\n@src/renderer/src/conversation/reducer.ts\n@src/renderer/src/conversation/Composer.tsx\n</attached_files>',
    )
  })

  it('sends a bare marker block when there is no prose', () => {
    expect(serializeForSend('', [reducerFile])).toBe(
      '<attached_files>\n@src/renderer/src/conversation/reducer.ts\n</attached_files>',
    )
  })

  it('orders a full payload: leading invocation, prose, trailing files', () => {
    expect(serializeForSend('explain this', [reducerFile, teach])).toBe(
      '/teach explain this\n\n<attached_files>\n@src/renderer/src/conversation/reducer.ts\n</attached_files>',
    )
  })
})

describe('extractAttachedFiles — display mirror of serializeForSend', () => {
  it('round-trips: strips the trailing block back into file chips', () => {
    const wire = serializeForSend('refactor these', [reducerFile, composerFile])
    expect(extractAttachedFiles(wire)).toEqual({
      cleanText: 'refactor these',
      files: [reducerFile, composerFile],
    })
  })

  it('leaves a prompt without a block untouched', () => {
    expect(extractAttachedFiles('plain prompt with @src/typed.ts inline')).toEqual({
      cleanText: 'plain prompt with @src/typed.ts inline',
      files: [],
    })
  })

  it('only strips a TRAILING block — text after the marker keeps everything intact', () => {
    const notTrailing = '<attached_files>\n@a.ts\n</attached_files>\nand then more prose'
    expect(extractAttachedFiles(notTrailing)).toEqual({ cleanText: notTrailing, files: [] })
  })

  it('keeps a leading invocation in the clean text (the #213 chip matches it there)', () => {
    const wire = serializeForSend('explain', [teach, reducerFile])
    expect(extractAttachedFiles(wire).cleanText).toBe('/teach explain')
  })
})

describe('addContext', () => {
  it('replaces an already-staged skill — the agent only honors one leading invocation', () => {
    const staged = addContext([], teach)
    expect(addContext(staged, review)).toEqual([review])
  })

  it('accumulates distinct files and keeps a staged skill', () => {
    const staged = addContext(addContext(addContext([], teach), reducerFile), composerFile)
    expect(staged).toEqual([teach, reducerFile, composerFile])
  })

  it('dedupes a re-selected file path', () => {
    const staged = addContext(addContext([], reducerFile), reducerFile)
    expect(staged).toEqual([reducerFile])
  })
})

describe('removeContext', () => {
  it('removes the chip whose key matches, leaving the rest', () => {
    const staged = addContext([], teach)
    expect(removeContext(staged, contextKey(teach))).toEqual([])
    expect(removeContext(staged, contextKey(review))).toEqual(staged)
  })
})
