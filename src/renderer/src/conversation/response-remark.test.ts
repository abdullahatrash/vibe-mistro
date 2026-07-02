import { describe, expect, it } from 'vitest'
import { defaultRemarkPlugins } from 'streamdown'
import { responseRemarkPlugins } from './response-remark'
import { remarkProseFileLinks } from './prose-file-links'

/**
 * Structural pins for the #185 remark chain, mirroring `response-rehype.test.ts`. The
 * behaviour (bare paths chip, GFM survives, code stays plain) is exercised through the real
 * SSR pipeline in `Response.test.ts`; these guard the property review hinges on: streamdown's
 * `remarkPlugins` prop REPLACES its defaults, so the list must re-supply `gfm` and `codeMeta`
 * BY REFERENCE and only append our plugin.
 */
describe('responseRemarkPlugins', () => {
  it('is the [gfm, codeMeta, remarkProseFileLinks] chain in order', () => {
    expect(responseRemarkPlugins).toHaveLength(3)
  })

  it("re-uses streamdown's gfm and codeMeta entries by reference (unchanged)", () => {
    const defaults = defaultRemarkPlugins as Record<'gfm' | 'codeMeta', unknown>
    expect(responseRemarkPlugins[0]).toBe(defaults.gfm)
    expect(responseRemarkPlugins[1]).toBe(defaults.codeMeta)
  })

  it('appends our NAMED plugin (streamdown caches processors by plugin function name)', () => {
    expect(responseRemarkPlugins[2]).toBe(remarkProseFileLinks)
    expect((responseRemarkPlugins[2] as { name: string }).name).toBe('remarkProseFileLinks')
  })
})
