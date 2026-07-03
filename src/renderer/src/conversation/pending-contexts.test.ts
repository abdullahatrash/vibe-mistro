import { describe, expect, it } from 'vitest'
import {
  addContext,
  contextKey,
  extractAttachedFiles,
  extractPromptContexts,
  removeContext,
  serializeForSend,
  type PendingContext,
} from './pending-contexts'

const teach: PendingContext = { kind: 'skill', name: 'teach', description: 'Teach mode' }
const review: PendingContext = { kind: 'skill', name: 'review' }
const reducerFile: PendingContext = { kind: 'file', path: 'src/renderer/src/conversation/reducer.ts' }
const composerFile: PendingContext = { kind: 'file', path: 'src/renderer/src/conversation/Composer.tsx' }
const button: PendingContext = {
  kind: 'element',
  id: 'el:1',
  tagName: 'button',
  selector: '#submit',
  text: 'Sign  in\nnow',
  pageUrl: 'http://localhost:3000/login',
  imageId: 'img:0',
}

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

  it('appends a picked element as a trailing element_context block, whitespace-normalized', () => {
    expect(serializeForSend('style this', [button])).toBe(
      'style this\n\n<element_context>\nPicked element <button>\nselector: #submit\ntext: Sign in now\nhttp://localhost:3000/login\n</element_context>',
    )
  })

  it('omits absent selector/text lines and places the element block AFTER the files block', () => {
    const bare: PendingContext = {
      kind: 'element',
      id: 'el:2',
      tagName: 'div',
      selector: null,
      text: '',
      pageUrl: 'http://localhost:5173/',
      imageId: null,
    }
    expect(serializeForSend('', [bare, reducerFile])).toBe(
      '<attached_files>\n@src/renderer/src/conversation/reducer.ts\n</attached_files>\n\n<element_context>\nPicked element <div>\nhttp://localhost:5173/\n</element_context>',
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

describe('extractPromptContexts — display mirror for the full payload', () => {
  it('round-trips a prompt carrying files AND elements back into chips', () => {
    const wire = serializeForSend('style this', [teach, reducerFile, button])
    expect(extractPromptContexts(wire)).toEqual({
      cleanText: '/teach style this',
      files: [reducerFile],
      elements: [
        {
          kind: 'element',
          id: 'el-extract:0',
          tagName: 'button',
          selector: '#submit',
          text: 'Sign in now',
          pageUrl: 'http://localhost:3000/login',
          imageId: null,
        },
      ],
    })
  })

  it('recovers multiple picked elements from one block', () => {
    const second: PendingContext = {
      kind: 'element',
      id: 'el:9',
      tagName: 'nav',
      selector: null,
      text: '',
      pageUrl: 'http://localhost:3000/',
      imageId: null,
    }
    const { elements } = extractPromptContexts(serializeForSend('', [button, second]))
    expect(elements.map((e) => [e.tagName, e.selector, e.pageUrl])).toEqual([
      ['button', '#submit', 'http://localhost:3000/login'],
      ['nav', null, 'http://localhost:3000/'],
    ])
  })

  it('leaves a prompt without marker blocks untouched', () => {
    expect(extractPromptContexts('just prose with @src/typed.ts')).toEqual({
      cleanText: 'just prose with @src/typed.ts',
      files: [],
      elements: [],
    })
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
