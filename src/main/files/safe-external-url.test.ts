import { describe, it, expect } from 'vitest'
import { safeExternalUrl } from './safe-external-url'

/**
 * The `openExternal` scheme guard (ADR-0014): a URL clicked in UNTRUSTED terminal
 * output opens in the browser ONLY when http/https — never a local-handler scheme.
 */
describe('safeExternalUrl', () => {
  it('admits http and https URLs, returning the normalized href', () => {
    expect(safeExternalUrl('http://localhost:3000/')).toBe('http://localhost:3000/')
    expect(safeExternalUrl('https://example.com/docs?q=1#h')).toBe('https://example.com/docs?q=1#h')
  })

  it('refuses local-handler / disclosure schemes', () => {
    expect(safeExternalUrl('file:///etc/passwd')).toBeNull()
    expect(safeExternalUrl('vscode://file/Users/me/secret')).toBeNull()
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('mailto:a@b.com')).toBeNull()
    expect(safeExternalUrl('ftp://host/x')).toBeNull()
  })

  it('refuses unparseable / relative / empty input', () => {
    expect(safeExternalUrl('not a url')).toBeNull()
    expect(safeExternalUrl('/just/a/path')).toBeNull()
    expect(safeExternalUrl('')).toBeNull()
  })
})
