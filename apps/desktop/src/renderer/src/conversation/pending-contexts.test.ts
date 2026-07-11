import { describe, expect, it } from 'vitest'
import {
  addContext,
  buildPromptCopyText,
  contextKey,
  extractAttachedFiles,
  extractPromptContexts,
  isLongPaste,
  LONG_PASTE_CHARS,
  LONG_PASTE_LINES,
  pastedLabel,
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

describe('buildPromptCopyText', () => {
  it('copies chip-only long-paste contents without transport marker tags', () => {
    const wire = serializeForSend('', [{ kind: 'pasted', id: 'paste:1', text: 'full pasted text' }])

    expect(buildPromptCopyText(extractPromptContexts(wire))).toBe('full pasted text')
  })

  it('combines visible prose and reusable file/element context without marker tags', () => {
    const wire = serializeForSend('check this', [reducerFile, button])
    const copied = buildPromptCopyText(extractPromptContexts(wire))

    expect(copied).toContain('check this')
    expect(copied).toContain('@src/renderer/src/conversation/reducer.ts')
    expect(copied).toContain('Picked element <button>')
    expect(copied).not.toContain('<attached_files>')
    expect(copied).not.toContain('<element_context>')
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
      reviews: [],
      pasted: [],
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
      reviews: [],
      pasted: [],
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

describe('review-comment chips (#239)', () => {
  const comment1 = {
    kind: 'review',
    id: 'rc:1',
    filePath: 'src/git/diff.ts',
    startLine: 10,
    endLine: 12,
    note: 'this cap looks wrong',
    excerpt: ' const CAP = 120\n-const OLD = 1\n+const NEW = 2',
  } as const

  const comment2 = {
    kind: 'review',
    id: 'rc:2',
    filePath: 'src/other.ts',
    startLine: 3,
    endLine: 3,
    note: 'rename this',
    excerpt: '+const x = 1',
  } as const

  it('accumulates comments (each id its own chip) and removes by key', () => {
    const staged = addContext(addContext([], comment1), comment2)
    expect(staged).toEqual([comment1, comment2])
    expect(removeContext(staged, contextKey(comment1))).toEqual([comment2])
  })

  it('serializes as a trailing <review_comments> block: path + line range + note + fenced diff excerpt', () => {
    const wire = serializeForSend('please address these', [comment1])
    expect(wire).toBe(
      'please address these\n\n' +
        '<review_comments>\n' +
        'Review comment on src/git/diff.ts (lines 10-12)\n' +
        'note: this cap looks wrong\n' +
        '```diff\n' +
        ' const CAP = 120\n-const OLD = 1\n+const NEW = 2\n' +
        '```\n' +
        '</review_comments>',
    )
  })

  it('several comments across files ride ONE block in staged order', () => {
    const wire = serializeForSend('', [comment1, comment2])
    expect(wire).toContain('Review comment on src/git/diff.ts (lines 10-12)')
    expect(wire).toContain('Review comment on src/other.ts (line 3)')
    expect(wire.indexOf('src/git/diff.ts')).toBeLessThan(wire.indexOf('src/other.ts'))
  })

  it('round-trips through the display mirror: prose recovered, comments recovered', () => {
    const wire = serializeForSend('please address these', [comment1, comment2])
    const extracted = extractPromptContexts(wire)
    expect(extracted.cleanText).toBe('please address these')
    expect(extracted.reviews.map((r) => ({ path: r.filePath, note: r.note, excerpt: r.excerpt }))).toEqual([
      { path: 'src/git/diff.ts', note: 'this cap looks wrong', excerpt: ' const CAP = 120\n-const OLD = 1\n+const NEW = 2' },
      { path: 'src/other.ts', note: 'rename this', excerpt: '+const x = 1' },
    ])
    expect(extracted.reviews[0]).toMatchObject({ startLine: 10, endLine: 12 })
  })

  it('coexists with the other chip kinds — reviews serialize LAST and extract first', () => {
    const wire = serializeForSend('style this', [reducerFile, button, comment1])
    const extracted = extractPromptContexts(wire)
    expect(extracted.cleanText).toBe('style this')
    expect(extracted.files).toEqual([reducerFile])
    expect(extracted.elements.length).toBe(1)
    expect(extracted.reviews.length).toBe(1)
  })

  it('hand-typed text mentioning <review_comments> mid-prose passes through untouched', () => {
    const text = 'what does <review_comments> mean here?\nnothing.'
    expect(extractPromptContexts(text).cleanText).toBe(text)
    expect(extractPromptContexts(text).reviews).toEqual([])
  })
})

describe('pasted-text chips (long-paste compression)', () => {
  const blob = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  const paste1: PendingContext = { kind: 'pasted', id: 'paste:0', text: blob }
  const paste2: PendingContext = { kind: 'pasted', id: 'paste:1', text: 'const x = 1\nconst y = 2\n' }

  describe('isLongPaste', () => {
    it('compresses past EITHER bound — chars or lines', () => {
      expect(isLongPaste('x'.repeat(LONG_PASTE_CHARS + 1))).toBe(true)
      expect(isLongPaste('short\n'.repeat(LONG_PASTE_LINES + 1))).toBe(true)
    })

    it('leaves an ordinary paste alone', () => {
      expect(isLongPaste('a normal sentence')).toBe(false)
      expect(isLongPaste('x'.repeat(LONG_PASTE_CHARS))).toBe(false)
      expect(isLongPaste(Array(LONG_PASTE_LINES).fill('l').join('\n'))).toBe(false)
    })
  })

  it('labels the chip in brackets with a line count (chars for a single line)', () => {
    expect(pastedLabel({ kind: 'pasted', id: 'p', text: blob })).toBe('[pasted text · 30 lines]')
    expect(pastedLabel({ kind: 'pasted', id: 'p', text: 'x'.repeat(1200) })).toBe(
      '[pasted text · 1200 chars]',
    )
  })

  it('accumulates pastes (each id its own chip) and removes by key', () => {
    const staged = addContext(addContext([], paste1), paste2)
    expect(staged).toEqual([paste1, paste2])
    expect(removeContext(staged, contextKey(paste1))).toEqual([paste2])
  })

  it('serializes as a trailing <pasted_text> block carrying the text VERBATIM', () => {
    expect(serializeForSend('explain this', [paste1])).toBe(
      `explain this\n\n<pasted_text>\n${blob}\n</pasted_text>`,
    )
  })

  it('round-trips through the display mirror, preserving a trailing newline in the paste', () => {
    const wire = serializeForSend('compare these', [paste1, paste2])
    const extracted = extractPromptContexts(wire)
    expect(extracted.cleanText).toBe('compare these')
    expect(extracted.pasted.map((p) => p.text)).toEqual([blob, 'const x = 1\nconst y = 2\n'])
  })

  it('coexists with the other chip kinds — pastes serialize LAST and extract first', () => {
    const wire = serializeForSend('style this', [teach, reducerFile, button, paste1])
    const extracted = extractPromptContexts(wire)
    expect(extracted.cleanText).toBe('/teach style this')
    expect(extracted.files).toEqual([reducerFile])
    expect(extracted.elements.length).toBe(1)
    expect(extracted.pasted.map((p) => p.text)).toEqual([blob])
  })

  it('sends a paste with no prose as a bare block the mirror fully recovers', () => {
    const wire = serializeForSend('', [paste1])
    expect(wire).toBe(`<pasted_text>\n${blob}\n</pasted_text>`)
    const extracted = extractPromptContexts(wire)
    expect(extracted.cleanText).toBe('')
    expect(extracted.pasted.map((p) => p.text)).toEqual([blob])
  })

  it('hand-typed text mentioning <pasted_text> mid-prose passes through untouched', () => {
    const text = 'what does <pasted_text> mean here?\nnothing.'
    expect(extractPromptContexts(text).cleanText).toBe(text)
    expect(extractPromptContexts(text).pasted).toEqual([])
  })
})
