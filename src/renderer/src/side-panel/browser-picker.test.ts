import { describe, expect, it } from 'vitest'
import {
  buildPickerScript,
  coercePickedElement,
  cropRectForElement,
  formatPickAnnotation,
  formatScreenshotAnnotation,
} from './browser-picker'

describe('cropRectForElement', () => {
  const viewport = { width: 1000, height: 800 }

  it('pads the element rect and rounds to integers', () => {
    const rect = cropRectForElement({ x: 100, y: 200, width: 50, height: 30 }, viewport, { padding: 8 })
    expect(rect).toEqual({ x: 92, y: 192, width: 66, height: 46 })
  })

  it('clamps a padded rect to the viewport (no negative origin, no overflow)', () => {
    const rect = cropRectForElement({ x: 2, y: 1, width: 40, height: 20 }, viewport, { padding: 8 })!
    expect(rect.x).toBe(0)
    expect(rect.y).toBe(0)
    // right/bottom edges stay within the viewport
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height)
  })

  it('clamps the far edges when the element sits against the bottom-right', () => {
    const rect = cropRectForElement({ x: 960, y: 780, width: 60, height: 40 }, viewport, { padding: 8 })!
    expect(rect.x + rect.width).toBeLessThanOrEqual(viewport.width)
    expect(rect.y + rect.height).toBeLessThanOrEqual(viewport.height)
    expect(rect.width).toBeGreaterThan(0)
    expect(rect.height).toBeGreaterThan(0)
  })

  it('returns null for a zero-area element (nothing to crop)', () => {
    expect(cropRectForElement({ x: 10, y: 10, width: 0, height: 0 }, viewport, { padding: 8 })).toBeNull()
  })
})

describe('coercePickedElement (untrusted guest JSON)', () => {
  const valid = {
    pageUrl: 'http://localhost:5173/pricing',
    tagName: 'BUTTON',
    selector: 'button.cta',
    text: 'Get started',
    rect: { x: 10, y: 20, width: 100, height: 40 },
  }

  it('accepts a well-formed payload and lowercases the tag', () => {
    expect(coercePickedElement(valid)).toEqual({
      pageUrl: 'http://localhost:5173/pricing',
      tagName: 'button',
      selector: 'button.cta',
      text: 'Get started',
      rect: { x: 10, y: 20, width: 100, height: 40 },
    })
  })

  it('tolerates a null selector and empty text', () => {
    const p = coercePickedElement({ ...valid, selector: null, text: '' })
    expect(p?.selector).toBeNull()
    expect(p?.text).toBe('')
  })

  it('drops a payload missing a valid rect or tag', () => {
    expect(coercePickedElement({ ...valid, rect: null })).toBeNull()
    expect(coercePickedElement({ ...valid, rect: { x: 1, y: 2, width: 'x', height: 3 } })).toBeNull()
    expect(coercePickedElement({ ...valid, tagName: 42 })).toBeNull()
  })

  it('drops non-objects', () => {
    expect(coercePickedElement(null)).toBeNull()
    expect(coercePickedElement('nope')).toBeNull()
    expect(coercePickedElement(undefined)).toBeNull()
  })

  it('truncates an over-long text snippet', () => {
    const long = 'x'.repeat(500)
    const p = coercePickedElement({ ...valid, text: long })
    expect(p!.text.length).toBeLessThanOrEqual(200)
  })
})

describe('formatPickAnnotation', () => {
  it('renders a compact, human+agent readable block with tag, selector, text, url', () => {
    const text = formatPickAnnotation({
      pageUrl: 'http://localhost:5173/pricing',
      tagName: 'button',
      selector: 'button.cta',
      text: 'Get started',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    })
    expect(text).toContain('<button>')
    expect(text).toContain('button.cta')
    expect(text).toContain('Get started')
    expect(text).toContain('http://localhost:5173/pricing')
  })

  it('omits the selector and text lines when they are absent', () => {
    const text = formatPickAnnotation({
      pageUrl: 'http://localhost:5173/',
      tagName: 'div',
      selector: null,
      text: '',
      rect: { x: 0, y: 0, width: 1, height: 1 },
    })
    expect(text).toContain('<div>')
    expect(text).not.toContain('selector')
  })
})

describe('formatScreenshotAnnotation', () => {
  it('names the page with title and url', () => {
    expect(formatScreenshotAnnotation({ url: 'http://localhost:5173/pricing', title: 'Pricing' })).toBe(
      'Screenshot of "Pricing" — http://localhost:5173/pricing',
    )
  })

  it('falls back to url only when the title is empty', () => {
    expect(formatScreenshotAnnotation({ url: 'http://localhost:5173/', title: '' })).toBe(
      'Screenshot of http://localhost:5173/',
    )
  })
})

describe('buildPickerScript', () => {
  it('produces a single IIFE expression that resolves a Promise', () => {
    const script = buildPickerScript({ accent: '#ff8800' })
    expect(script.trimStart().startsWith('(')).toBe(true)
    expect(script).toContain('new Promise')
  })

  it('embeds the accent color as a safely-quoted string', () => {
    const script = buildPickerScript({ accent: '#ff8800' })
    expect(script).toContain(JSON.stringify('#ff8800'))
  })

  it('wires the load-bearing picker mechanics (hover, capture-phase click, Esc)', () => {
    const script = buildPickerScript({ accent: '#ff8800' })
    expect(script).toContain('elementsFromPoint')
    expect(script).toContain('getBoundingClientRect')
    expect(script).toContain('preventDefault')
    expect(script).toContain("'Escape'")
    // capture-phase listeners so the guest app never sees the pick
    expect(script).toContain('true')
  })

  it('is resistant to a hostile accent value (JSON-encoded, quote escaped)', () => {
    const script = buildPickerScript({ accent: '";alert(1)//' })
    // JSON-encoding embeds the value as an escaped string literal — the `"` becomes `\"`,
    // so it can't break out of the string context into executable code.
    expect(script).toContain(JSON.stringify('";alert(1)//'))
    expect(script).toContain('\\"') // the double-quote is backslash-escaped, not raw
  })
})
