import { describe, expect, it, vi } from 'vitest'
import {
  appendText,
  emitComposerInsert,
  emitComposerInsertElement,
  emitComposerInsertImage,
  emitComposerInsertTerminal,
  emitComposerInsertText,
  subscribeComposerInsert,
  subscribeComposerInsertElement,
  subscribeComposerInsertImage,
  subscribeComposerInsertTerminal,
  subscribeComposerInsertText,
  type ComposerInsertElement,
  type ComposerInsertImage,
} from './composer-insert'

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

describe('composer-insert ELEMENT channel (#231 pick-to-chat)', () => {
  it('delivers the pick payload — element metadata + optional screenshot — to the Thread\'s subscriber', () => {
    const listener = vi.fn()
    const off = subscribeComposerInsertElement('thread-a', listener)
    const payload: ComposerInsertElement = {
      element: { tagName: 'button', selector: '#go', text: 'Go', pageUrl: 'http://localhost:3000/' },
      image: null,
    }
    emitComposerInsertElement('thread-a', payload)
    expect(listener).toHaveBeenCalledWith(payload)
    off()
  })

  it('is a no-op without a subscriber and stops after unsubscribe', () => {
    const listener = vi.fn()
    expect(() =>
      emitComposerInsertElement('nobody', {
        element: { tagName: 'div', selector: null, text: '', pageUrl: 'x' },
        image: null,
      }),
    ).not.toThrow()
    const off = subscribeComposerInsertElement('thread-a', listener)
    off()
    emitComposerInsertElement('thread-a', {
      element: { tagName: 'div', selector: null, text: '', pageUrl: 'x' },
      image: null,
    })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('appendText (raw composer annotations)', () => {
  it('inserts verbatim into an empty draft — no `@`, no forced trailing space', () => {
    expect(appendText('', 'error: boom')).toBe('error: boom')
  })

  it('separates from prior draft with a newline', () => {
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

describe('composer-insert TERMINAL channel', () => {
  it('delivers structured terminal selection context to the Thread subscriber', () => {
    const terminal = vi.fn()
    const text = vi.fn()
    const offTerminal = subscribeComposerInsertTerminal('thread-a', terminal)
    const offText = subscribeComposerInsertText('thread-a', text)

    emitComposerInsertTerminal('thread-a', { source: 'term-1', output: 'error: boom' })
    expect(terminal).toHaveBeenCalledWith({ source: 'term-1', output: 'error: boom' })
    expect(text).not.toHaveBeenCalled()

    offTerminal()
    offText()
  })

  it('is a no-op with no subscriber, and stops after unsubscribe', () => {
    expect(() =>
      emitComposerInsertTerminal('nobody', { source: 'term-1', output: 'x' }),
    ).not.toThrow()
    const listener = vi.fn()
    const off = subscribeComposerInsertTerminal('thread-a', listener)
    off()
    emitComposerInsertTerminal('thread-a', { source: 'term-1', output: 'x' })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('composer-insert IMAGE channel (#226 standalone page screenshot)', () => {
  const img: ComposerInsertImage = {
    data: 'AAAA',
    mimeType: 'image/png',
    name: 'page-screenshot.png',
    previewUrl: 'data:image/png;base64,AAAA',
  }

  it('delivers an image payload to the Thread\'s subscriber, isolated from the element channel', () => {
    const image = vi.fn()
    const element = vi.fn()
    const offImage = subscribeComposerInsertImage('thread-a', image)
    const offElement = subscribeComposerInsertElement('thread-a', element)

    emitComposerInsertImage('thread-a', img)
    expect(image).toHaveBeenCalledWith(img)
    expect(element).not.toHaveBeenCalled() // separate channel

    offImage()
    offElement()
  })

  it('is a no-op with no subscriber, and stops after unsubscribe', () => {
    expect(() => emitComposerInsertImage('nobody', img)).not.toThrow()
    const listener = vi.fn()
    const off = subscribeComposerInsertImage('thread-a', listener)
    off()
    emitComposerInsertImage('thread-a', img)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('composer-insert ELEMENT channel — screenshot payload riding along', () => {
  const img: ComposerInsertImage = {
    data: 'AAAA',
    mimeType: 'image/png',
    name: 'element-button.png',
    previewUrl: 'data:image/png;base64,AAAA',
  }

  it('delivers the screenshot inside the pick payload, isolated from the text channel', () => {
    const element = vi.fn()
    const text = vi.fn()
    const offElement = subscribeComposerInsertElement('thread-a', element)
    const offText = subscribeComposerInsertText('thread-a', text)

    const payload: ComposerInsertElement = {
      element: { tagName: 'button', selector: '#go', text: 'Go', pageUrl: 'http://localhost:3000/' },
      image: img,
    }
    emitComposerInsertElement('thread-a', payload)
    expect(element).toHaveBeenCalledWith(payload)
    expect(text).not.toHaveBeenCalled() // separate channel

    offElement()
    offText()
  })

  it('delivers only to the target Thread', () => {
    const a = vi.fn()
    const b = vi.fn()
    const offA = subscribeComposerInsertElement('thread-a', a)
    const offB = subscribeComposerInsertElement('thread-b', b)
    emitComposerInsertElement('thread-a', {
      element: { tagName: 'div', selector: null, text: '', pageUrl: 'x' },
      image: img,
    })
    expect(a).toHaveBeenCalled()
    expect(b).not.toHaveBeenCalled()
    offA()
    offB()
  })
})
