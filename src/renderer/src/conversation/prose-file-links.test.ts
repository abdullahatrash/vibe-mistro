import { describe, expect, it } from 'vitest'
import { findProsePathMatches } from './prose-file-links'

/**
 * Pure detection contract for #185 — the false-positive budget lives here. The remark
 * transform and the label-pool scan share `classifyCandidate`, so these tests pin the
 * behaviour of both; the end-to-end render (chips in real markdown, code exclusion via
 * mdast structure) is covered in `Response.test.ts`.
 */
describe('findProsePathMatches — true positives', () => {
  it('detects a relative path with a line ref, with exact offsets', () => {
    const text = 'The bug is in src/main/agent-pool.ts:42 today'
    const matches = findProsePathMatches(text)
    expect(matches).toHaveLength(1)
    const match = matches[0]!
    expect(match.href).toBe('src/main/agent-pool.ts:42')
    expect(match.link.path).toBe('src/main/agent-pool.ts')
    expect(match.link.line).toBe(42)
    expect(match.start).toBe(text.indexOf('src/'))
    expect(match.end).toBe(text.indexOf('src/') + 'src/main/agent-pool.ts:42'.length)
  })

  const positives: ReadonlyArray<[string, string, string]> = [
    ['dot-relative path', 'open ./rel/path.md please', './rel/path.md'],
    ['parent-relative path', 'open ../up/x.ts please', '../up/x.ts'],
    ['home-relative path', 'open ~/x/y.ts please', '~/x/y.ts'],
    ['dot-relative dir without extension', 'output lands in ./build now', './build'],
    ['absolute path with line', 'see /Users/me/project/x.ts:3 there', '/Users/me/project/x.ts:3'],
    ['windows drive path', 'open C:\\repo\\a.ts now', 'C:\\repo\\a.ts'],
    ['bare filename with line ref', 'check package.json:12 please', 'package.json:12'],
    ['bare filename with line ref at string start', 'package.json:12 has it', 'package.json:12'],
    ['bare filename with line ref at string end', 'it is in package.json:12', 'package.json:12'],
    ['multi-dot filename with line ref', 'see vite.config.ts:7 there', 'vite.config.ts:7'],
  ]
  for (const [name, text, expected] of positives) {
    it(`detects a ${name}`, () => {
      const matches = findProsePathMatches(text)
      expect(matches.map((m) => m.href)).toEqual([expected])
    })
  }

  it('parses line and column', () => {
    const [match] = findProsePathMatches('at src/a.ts:10:5 exactly')
    expect(match?.link.path).toBe('src/a.ts')
    expect(match?.link.line).toBe(10)
    expect(match?.link.column).toBe(5)
  })

  const trims: ReadonlyArray<[string, string]> = [
    ['see src/foo.ts.', 'src/foo.ts'],
    ['see src/foo.ts, then', 'src/foo.ts'],
    ['(src/main/agent-pool.ts:42)', 'src/main/agent-pool.ts:42'],
    ['[src/foo.ts]', 'src/foo.ts'],
    ['in src/foo.ts: the bug', 'src/foo.ts'],
    ['see /Users/me/x.ts:42).', '/Users/me/x.ts:42'],
    ['what about src/foo.ts?', 'src/foo.ts'],
  ]
  for (const [text, expected] of trims) {
    it(`trims trailing delimiters: ${JSON.stringify(text)}`, () => {
      expect(findProsePathMatches(text).map((m) => m.href)).toEqual([expected])
    })
  }

  it('keeps balanced parens that belong to the path', () => {
    expect(findProsePathMatches('see /Users/me/(x)/y.ts now').map((m) => m.href)).toEqual([
      '/Users/me/(x)/y.ts',
    ])
  })

  it('detects multiple paths in one string, in order', () => {
    const matches = findProsePathMatches('compare src/a/reducer.ts:1 with src/b/reducer.ts:2')
    expect(matches.map((m) => m.href)).toEqual(['src/a/reducer.ts:1', 'src/b/reducer.ts:2'])
    expect(matches.map((m) => m.link.path)).toEqual(['src/a/reducer.ts', 'src/b/reducer.ts'])
  })
})

describe('findProsePathMatches — false positives stay plain', () => {
  const negatives: ReadonlyArray<[string, string]> = [
    ['slashed prose', 'use and/or here'],
    ['either/or', 'pick either/or now'],
    ['I/O', 'heavy I/O load'],
    ['24/7', 'runs 24/7 fine'],
    ['e.g without dot', 'like e.g this'],
    ['e.g. with dot', 'like e.g. this'],
    ['i.e.', 'that is i.e. this'],
    ['version number', 'bump to v1.2.3 now'],
    ['Node.js', 'runs on Node.js fine'],
    ['Next.js', 'built with Next.js today'],
    ['bare filename without line ref', 'check package.json please'],
    ['https URL with path-like tail', 'see https://github.com/a/b.ts there'],
    ['www URL with path-like tail', 'see www.example.com/a/b.ts there'],
    ['scheme-less domain path', 'see github.com/foo/bar there'],
    ['scheme-less domain path with extension', 'see github.com/foo/bar.ts there'],
    ['email-adjacent path', 'mail user@host.com/x.ts please'],
    ['slash command', 'run /code-review now'],
    ['absolute dir without extension or line', 'look in /etc/hosts today'],
    ['inline-code span in raw markdown', 'run `src/foo.ts:42` here'],
    ['glob pattern', 'matches src/**/*.ts files'],
  ]
  for (const [name, text] of negatives) {
    it(`does not match ${name}`, () => {
      expect(findProsePathMatches(text)).toEqual([])
    })
  }

  it('never rescues a rejected candidate via a suffix retry', () => {
    // findAndReplace retries a rejected match at start+1; every suffix of a rejected
    // token starts after a path character and must die on the boundary guard.
    expect(findProsePathMatches('xgithub.com/a/b.ts')).toEqual([])
    expect(findProsePathMatches('see github.com/a/b.ts here')).toEqual([])
  })
})
