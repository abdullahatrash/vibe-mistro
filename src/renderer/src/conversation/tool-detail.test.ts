import { describe, it, expect } from 'vitest'
import { stringifyToolDetail, toolDetail, toolPreview } from './tool-detail'
import type { ToolItem } from './reducer'

/**
 * ToolRow detail derivation (#115): the pure `<pre>` body + inline preview strings behind
 * the tool row. Branchy and formerly untested — these cover the dedup-against-heading,
 * multi-field join, and rawInput-fallback paths as plain data with no renderer.
 */

function toolItem(over: Partial<ToolItem>): ToolItem {
  return {
    kind: 'tool',
    id: 't1',
    toolCallId: 'call-1',
    toolKind: null,
    status: 'completed',
    title: null,
    locations: [],
    rawInput: undefined,
    rawOutput: undefined,
    content: [],
    ...over,
  }
}

describe('stringifyToolDetail', () => {
  it('passes strings through verbatim', () => {
    expect(stringifyToolDetail('hello')).toBe('hello')
  })

  it('pretty-prints non-strings as JSON', () => {
    expect(stringifyToolDetail({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
})

describe('toolDetail — expandable body', () => {
  it('is null when there is no rawInput, rawOutput, or content', () => {
    expect(toolDetail(toolItem({}))).toBeNull()
  })

  it('joins rawInput, rawOutput, and content in order with a blank line', () => {
    const detail = toolDetail(
      toolItem({ rawInput: 'in', rawOutput: 'out', content: ['c'] }),
    )
    // Strings verbatim; the content array is pretty-printed JSON (indent 2).
    expect(detail).toBe('in\n\nout\n\n[\n  "c"\n]')
  })

  it('includes only the fields that are present', () => {
    expect(toolDetail(toolItem({ rawOutput: 'out' }))).toBe('out')
  })

  it('ignores an empty content array', () => {
    expect(toolDetail(toolItem({ content: [] }))).toBeNull()
  })

  it('keeps a rawInput of 0 / false (present but falsy)', () => {
    expect(toolDetail(toolItem({ rawInput: 0 }))).toBe('0')
    expect(toolDetail(toolItem({ rawInput: false }))).toBe('false')
  })
})

describe('toolPreview — dimmed inline preview', () => {
  it('prefers a touched location path', () => {
    expect(toolPreview(toolItem({ locations: [{ path: 'src/a.ts' }] }), 'Read')).toBe('src/a.ts')
  })

  it('falls back to a string rawInput when no location has a path', () => {
    expect(toolPreview(toolItem({ locations: [{}], rawInput: 'grep foo' }), 'Search')).toBe(
      'grep foo',
    )
  })

  it('is null when neither a path nor a string rawInput exists', () => {
    expect(toolPreview(toolItem({ rawInput: { cmd: 'x' } }), 'Tool')).toBeNull()
  })

  it('suppresses a preview that merely duplicates the heading (case/space-insensitive)', () => {
    expect(toolPreview(toolItem({ locations: [{ path: '  README.md ' }] }), 'readme.md')).toBeNull()
  })
})
