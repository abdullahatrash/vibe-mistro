import { describe, expect, it, vi } from 'vitest'
import {
  appendMention,
  appendText,
  emitComposerInsert,
  emitComposerInsertText,
  subscribeComposerInsert,
  subscribeComposerInsertText,
} from './composer-insert'

describe('appendMention', () => {
  it('inserts into an empty draft with a trailing space', () => {
    expect(appendMention('', 'src/app.ts')).toBe('@src/app.ts ')
  })

  it('adds a separating space when the draft does not end in whitespace', () => {
    expect(appendMention('see', 'src/app.ts')).toBe('see @src/app.ts ')
  })

  it('does not double the space when the draft already ends in whitespace', () => {
    expect(appendMention('see ', 'src/app.ts')).toBe('see @src/app.ts ')
    expect(appendMention('see\n', 'src/app.ts')).toBe('see\n@src/app.ts ')
  })
})

describe('composer-insert channel', () => {
  it('delivers an emit to the subscriber for that Thread only', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeComposerInsert('thread-a', a)
    const offB = subscribeComposerInsert('thread-b', b)
    emitComposerInsert('thread-a', 'src/app.ts')
    expect(a).toHaveBeenCalledWith('src/app.ts')
    expect(b).not.toHaveBeenCalled()
    offA()
    offB()
  })

  it('is a no-op when no composer is subscribed for the Thread', () => {
    expect(() => emitComposerInsert('nobody', 'x.ts')).not.toThrow()
  })

  it('stops delivering after unsubscribe', () => {
    const listener = vi.fn()
    const off = subscribeComposerInsert('thread-a', listener)
    off()
    emitComposerInsert('thread-a', 'x.ts')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('appendText (Terminal "Add to chat")', () => {
  it('inserts verbatim into an empty draft — no `@`, no forced trailing space', () => {
    expect(appendText('', 'error: boom')).toBe('error: boom')
  })

  it('separates from prior draft with a newline (terminal selections are often multi-line)', () => {
    expect(appendText('look at this', 'Traceback\n  line 1')).toBe('look at this\nTraceback\n  line 1')
  })

  it('does not add a separator when the draft already ends in whitespace', () => {
    expect(appendText('look\n', 'x')).toBe('look\nx')
    expect(appendText('look ', 'x')).toBe('look x')
  })
})

describe('composer-insert TEXT channel (raw)', () => {
  it('delivers raw text to the Thread\'s subscriber and is isolated from the @-mention channel', () => {
    const text = vi.fn()
    const mention = vi.fn()
    const offText = subscribeComposerInsertText('thread-a', text)
    const offMention = subscribeComposerInsert('thread-a', mention)

    emitComposerInsertText('thread-a', 'raw output')
    expect(text).toHaveBeenCalledWith('raw output')
    expect(mention).not.toHaveBeenCalled() // separate channel

    offText()
    offMention()
  })

  it('is a no-op with no subscriber, and stops after unsubscribe', () => {
    expect(() => emitComposerInsertText('nobody', 'x')).not.toThrow()
    const listener = vi.fn()
    const off = subscribeComposerInsertText('thread-a', listener)
    off()
    emitComposerInsertText('thread-a', 'x')
    expect(listener).not.toHaveBeenCalled()
  })
})
