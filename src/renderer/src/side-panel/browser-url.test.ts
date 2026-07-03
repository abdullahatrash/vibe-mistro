import { describe, expect, it } from 'vitest'
import { normalizeBrowserUrl } from './browser-url'

describe('normalizeBrowserUrl', () => {
  it('normalizes scheme-less host:port input to http', () => {
    expect(normalizeBrowserUrl('localhost:5173')).toBe('http://localhost:5173/')
  })

  it('keeps an explicit http/https scheme as typed', () => {
    expect(normalizeBrowserUrl('https://example.com/app')).toBe('https://example.com/app')
    expect(normalizeBrowserUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000/')
  })

  it('refuses non-http(s) schemes instead of coercing them', () => {
    expect(normalizeBrowserUrl('file:///etc/passwd')).toBeNull()
    expect(normalizeBrowserUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeBrowserUrl('vscode://open?file=x')).toBeNull()
    expect(normalizeBrowserUrl('mailto:a@b.com')).toBeNull()
  })

  it('refuses empty and unparseable input', () => {
    expect(normalizeBrowserUrl('')).toBeNull()
    expect(normalizeBrowserUrl('   ')).toBeNull()
    expect(normalizeBrowserUrl('not a url at all')).toBeNull()
  })

  it('trims surrounding whitespace before parsing', () => {
    expect(normalizeBrowserUrl('  localhost:3000  ')).toBe('http://localhost:3000/')
  })
})
