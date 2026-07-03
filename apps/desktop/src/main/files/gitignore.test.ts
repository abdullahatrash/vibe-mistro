import { describe, expect, it } from 'vitest'
import { compileGitignore, isIgnored, matchesRule, type GitignoreLayer } from './gitignore'

/** One root-level layer from a `.gitignore` body — the common single-file case. */
function rootLayer(content: string): GitignoreLayer[] {
  return [{ base: '', rules: compileGitignore(content) }]
}

describe('compileGitignore', () => {
  it('skips blank lines and comments', () => {
    expect(compileGitignore('\n# a comment\n\n   \n')).toEqual([])
  })

  it('parses negation, dir-only, and anchoring flags', () => {
    const [name, dirOnly, negated, anchored] = compileGitignore('node_modules\nbuild/\n!keep.txt\n/root-only')
    expect({ dirOnly: name.dirOnly, negated: name.negated }).toEqual({ dirOnly: false, negated: false })
    expect(dirOnly.dirOnly).toBe(true)
    expect(negated.negated).toBe(true)
    // `/root-only` is anchored: it must not match at a deeper level.
    expect(matchesRule(anchored, 'root-only', false)).toBe(true)
    expect(matchesRule(anchored, 'sub/root-only', false)).toBe(false)
  })
})

describe('matchesRule — supported glob forms', () => {
  it('name matches a basename at any depth', () => {
    const [rule] = compileGitignore('node_modules')
    expect(matchesRule(rule, 'node_modules', true)).toBe(true)
    expect(matchesRule(rule, 'a/b/node_modules', true)).toBe(true)
    expect(matchesRule(rule, 'node_modules_x', true)).toBe(false)
  })

  it('*.ext matches by extension at any depth', () => {
    const [rule] = compileGitignore('*.log')
    expect(matchesRule(rule, 'debug.log', false)).toBe(true)
    expect(matchesRule(rule, 'logs/debug.log', false)).toBe(true)
    expect(matchesRule(rule, 'debug.log.txt', false)).toBe(false)
  })

  it('? matches exactly one non-slash char', () => {
    const [rule] = compileGitignore('f?o')
    expect(matchesRule(rule, 'foo', false)).toBe(true)
    expect(matchesRule(rule, 'fo', false)).toBe(false)
    expect(matchesRule(rule, 'f/o', false)).toBe(false)
  })

  it('dir/ matches directories only', () => {
    const [rule] = compileGitignore('dist/')
    expect(matchesRule(rule, 'dist', true)).toBe(true)
    expect(matchesRule(rule, 'dist', false)).toBe(false)
  })

  it('anchored path (internal slash) is rooted at the base', () => {
    const [rule] = compileGitignore('src/generated')
    expect(matchesRule(rule, 'src/generated', true)).toBe(true)
    expect(matchesRule(rule, 'deep/src/generated', true)).toBe(false)
  })

  it('** spans path segments', () => {
    const [leading] = compileGitignore('**/tmp')
    expect(matchesRule(leading, 'tmp', true)).toBe(true)
    expect(matchesRule(leading, 'a/b/tmp', true)).toBe(true)
    const [middle] = compileGitignore('a/**/z')
    expect(matchesRule(middle, 'a/z', false)).toBe(true)
    expect(matchesRule(middle, 'a/b/c/z', false)).toBe(true)
  })
})

describe('isIgnored — layered, last-match-wins', () => {
  it('later rules override earlier ones (negation re-includes)', () => {
    const layers = rootLayer('*.log\n!keep.log')
    expect(isIgnored(layers, 'a.log', false)).toBe(true)
    expect(isIgnored(layers, 'keep.log', false)).toBe(false)
  })

  it('a deeper .gitignore overrides a shallower one', () => {
    const layers: GitignoreLayer[] = [
      { base: '', rules: compileGitignore('*.tmp') },
      { base: 'sub', rules: compileGitignore('!important.tmp') },
    ]
    // Re-based to `sub`, `important.tmp` is re-included; a sibling stays ignored.
    expect(isIgnored(layers, 'sub/important.tmp', false)).toBe(false)
    expect(isIgnored(layers, 'sub/other.tmp', false)).toBe(true)
    expect(isIgnored(layers, 'top.tmp', false)).toBe(true)
  })

  it('returns false when nothing matches', () => {
    expect(isIgnored(rootLayer('*.log'), 'src/app.ts', false)).toBe(false)
  })
})

// #188 security review F1: a hostile .gitignore must not be able to freeze the main thread
// via exponential-backtracking regex. Pathological patterns (too many `*`s / too long) are
// skipped at compile time, so matching stays fast regardless of input.
describe('ReDoS guard (MAX_GLOB_STARS / MAX_LINE_LEN)', () => {
  it('skips a pattern with too many wildcards, and matching is fast', () => {
    const hostile = `${'a**'.repeat(20)}b` // 40 `*`s — would backtrack exponentially
    const layers = rootLayer(hostile)
    // The pattern is skipped (no rule compiled), so it never matches — over-lists, safe.
    expect(layers[0].rules).toEqual([])
    const victim = `${'a'.repeat(60)}c`
    const start = performance.now()
    expect(isIgnored(layers, victim, false)).toBe(false)
    expect(performance.now() - start).toBeLessThan(50)
  })

  it('skips an over-long pattern line', () => {
    const layers = rootLayer(`${'x'.repeat(5000)}`)
    expect(layers[0].rules).toEqual([])
  })

  it('still compiles ordinary multi-wildcard patterns', () => {
    // A realistic deep pattern (≤ MAX_GLOB_STARS stars) is unaffected.
    expect(isIgnored(rootLayer('**/dist/**/*.map'), 'a/b/dist/x/y.map', false)).toBe(true)
    expect(isIgnored(rootLayer('*.min.*'), 'vendor.min.js', false)).toBe(true)
  })
})
