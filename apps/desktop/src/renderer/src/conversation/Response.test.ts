import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Response } from './Response'

/**
 * End-to-end tests for the #168 fix, driven through the REAL streamdown render pipeline.
 * `renderToStaticMarkup(<Response/>)` runs the full markdown → remark → rehype (raw → sanitize →
 * guarded-harden) → React chain in the vitest node env, so these assert on the actual emitted HTML —
 * not on isolated parse logic. This is the true adversarial surface: what a user's DOM would receive.
 *
 * (No `openFile` context is provided here, so `FileChip` renders its non-navigating `<span>` variant;
 * the `data-file-chip` marker is present either way.)
 */
function render(text: string): string {
  return renderToStaticMarkup(createElement(Response, { text }))
}

describe('Response — Typeset owns prose rhythm', () => {
  it('applies the chat preset and removes Streamdown root spacing', () => {
    const html = render('A paragraph')
    expect(html).toContain('typeset')
    expect(html).toContain('typeset-chat')
    expect(html).toContain('space-y-0')
    expect(html).not.toContain('space-y-4')
  })

  it('renders headings, lists, and quotes as semantic elements without Streamdown typography classes', () => {
    const html = render('## Heading\n\n- one\n- two\n\n> quoted')
    expect(html).toContain('<h2>Heading</h2>')
    expect(html).toMatch(/<ul>\s*<li>one<\/li>\s*<li>two<\/li>\s*<\/ul>/)
    expect(html).toMatch(/<blockquote>\s*<p>quoted<\/p>\s*<\/blockquote>/)
    expect(html).not.toContain('data-streamdown="heading-2"')
    expect(html).not.toContain('data-streamdown="unordered-list"')
    expect(html).not.toContain('data-streamdown="blockquote"')
  })

  it('retains Streamdown interactive wrappers for fenced code and tables', () => {
    const html = render('```ts\nconst ok = true\n```\n\n| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('data-streamdown="code-block"')
    expect(html).toContain('data-streamdown="table-wrapper"')
  })
})

describe('Response — file-path links render as chips (#168)', () => {
  const fileLinkCases: ReadonlyArray<[string, string]> = [
    ['bare filename', '[label](test.txt)'],
    ['dot-relative path', '[label](./src/x.ts)'],
    ['absolute path', '[label](/Users/me/project/x.ts)'],
    ['relative path with line ref', '[label](src/x.ts:42)'],
  ]

  for (const [name, input] of fileLinkCases) {
    it(`renders a FileChip for a ${name}, not [blocked]`, () => {
      const html = render(input)
      expect(html).toContain('data-file-chip')
      expect(html).not.toContain('[blocked]')
      expect(html).not.toContain('Blocked URL')
    })
  }

  it('renders the chip with the parsed line ref (L42) for a positioned path', () => {
    const html = render('[label](src/x.ts:42)')
    expect(html).toContain('data-file-chip')
    expect(html).toContain('L42')
  })
})

describe('Response — external links stay real, safe anchors', () => {
  it('keeps an https link as an anchor with href, target=_blank and rel', () => {
    const html = render('[ext](https://example.com/page)')
    expect(html).toContain('href="https://example.com/page"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
    expect(html).not.toContain('data-file-chip')
    expect(html).not.toContain('[blocked]')
  })
})

describe('Response — dangerous link schemes are neutralized end-to-end', () => {
  const dangerous: ReadonlyArray<[string, string, string]> = [
    ['javascript:', '[x](javascript:alert(1))', 'javascript:'],
    ['data:text/html', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)', 'data:text/html'],
    ['vbscript:', '[x](vbscript:msgbox(1))', 'vbscript:'],
  ]

  for (const [name, input, needle] of dangerous) {
    it(`strips a ${name} link entirely (no scheme, no clickable anchor)`, () => {
      const html = render(input)
      // The dangerous scheme string must not survive anywhere in the output (not in an href,
      // not in a title attribute) — sanitize removes the href before it can render.
      expect(html).not.toContain(needle)
      expect(html).not.toContain('href="javascript:')
      expect(html).not.toContain('href="data:')
      expect(html).not.toContain('href="vbscript:')
      // Never rendered as a file chip either.
      expect(html).not.toContain('data-file-chip')
    })
  }
})

describe('Response — the wrapped harden still runs (#168 guard liveness)', () => {
  // A bare extension-less relative href survives sanitize (relative hrefs are allowed) and is
  // NOT a file path (`parseFileLink('foo')` → null, so the guard doesn't hide it) — the ONLY
  // thing that blocks it is rehype-harden (unresolvable URL with `defaultOrigin: undefined`).
  // If `guardFilePathAnchors` ever silently disabled harden, every other test in this file
  // would still pass (their dangerous hrefs die in sanitize) but this one would fail with a
  // live `<a href="foo">`. Do not delete it on a streamdown upgrade without a replacement.
  it('still hard-blocks a relative non-file href (a harden-only block)', () => {
    const html = render('[click](foo)')
    expect(html).toContain('[blocked]')
    expect(html).toContain('Blocked URL')
    expect(html).not.toContain('href="foo"')
    expect(html).not.toContain('data-file-chip')
  })
})

describe('Response — bare file paths in prose render as chips (#185)', () => {
  const barePathCases: ReadonlyArray<[string, string]> = [
    ['relative path with line ref', 'fix src/main/agent-pool.ts:42 now'],
    ['dot-relative path', 'open ./rel/path.md please'],
    ['home-relative path', 'open ~/x/y.ts please'],
    // The next two are scheme-shaped for rehype-sanitize (colon before any slash) and only
    // chip because `schemeSafeUrl` percent-encodes the colon — see prose-file-links.ts.
    ['bare filename with line ref', 'check package.json:12 please'],
    ['windows drive path', 'open C:\\repo\\a.ts now'],
    ['parenthesised path with trailing punctuation', 'worth a look (see src/x.ts:42).'],
  ]

  for (const [name, input] of barePathCases) {
    it(`chips a ${name} without an explicit markdown link`, () => {
      const html = render(input)
      expect(html).toContain('data-file-chip')
      expect(html).not.toContain('[blocked]')
      expect(html).not.toContain('Blocked URL')
    })
  }

  it('renders the auto-linkified chip with the parsed line ref (L42)', () => {
    const html = render('fix src/main/agent-pool.ts:42 now')
    expect(html).toContain('data-file-chip')
    expect(html).toContain('L42')
  })

  it('disambiguates colliding basenames across prose-detected paths (shared label pool)', () => {
    const html = render('compare src/a/reducer.ts:1 with src/b/reducer.ts:2')
    expect(html).toContain('reducer.ts · a')
    expect(html).toContain('reducer.ts · b')
  })
})

describe('Response — auto-linkify never fires inside code (#185)', () => {
  it('leaves a path inside inline code as plain code', () => {
    const html = render('run `src/foo.ts:42` here')
    expect(html).not.toContain('data-file-chip')
    expect(html).toContain('src/foo.ts:42')
  })

  it('leaves a path inside a fenced code block as plain code', () => {
    const html = render('```\nsrc/foo.ts:42\n```')
    expect(html).not.toContain('data-file-chip')
  })
})

describe('Response — auto-linkify false positives stay plain prose (#185)', () => {
  it('does not chip or link slashed/dotted prose', () => {
    const html = render('use and/or, e.g. v1.2.3 on Node.js')
    expect(html).not.toContain('data-file-chip')
    expect(html).not.toContain('<a')
  })

  it('does not chip or link a scheme-less domain path', () => {
    const html = render('see github.com/foo/bar.ts there')
    expect(html).not.toContain('data-file-chip')
    expect(html).not.toContain('<a')
  })
})

describe('Response — GFM survives the remarkPlugins replacement (#185 regression)', () => {
  // The `remarkPlugins` prop REPLACES streamdown's defaults; `response-remark.ts` re-supplies
  // them. If it ever stops, these break loudly rather than tables/autolinks dying silently.
  it('still renders a GFM table', () => {
    const html = render('| a | b |\n| - | - |\n| 1 | 2 |')
    expect(html).toContain('<table')
  })

  it('still renders GFM strikethrough', () => {
    const html = render('this is ~~gone~~ now')
    expect(html).toContain('<del')
  })

  it('still autolinks a bare URL — as a real anchor, never a chip', () => {
    const html = render('see https://github.com/a/b.ts now')
    expect(html).toContain('href="https://github.com/a/b.ts"')
    expect(html).not.toContain('data-file-chip')
  })
})

describe('Response — raw HTML is sanitized, not skipped', () => {
  it('drops a raw <script> tag', () => {
    const html = render('Hello <script>alert(1)</script> world')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('alert(1)')
  })

  it('drops an onerror handler and the blocked <img>', () => {
    const html = render('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
    expect(html).not.toContain('alert(1)')
  })
})
