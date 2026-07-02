import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listFiles } from './list-files'

/**
 * The lister runs against REAL tmpdir fixtures (prior art: the persistence + fs-write
 * suites) so the CONFINEMENT behavior — real symlinks, real cycles — is exercised, not
 * mocked. Every fixture dir is tracked and removed after each test.
 */
const created: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function write(root: string, rel: string, content = ''): void {
  const abs = join(root, rel)
  mkdirSync(join(abs, '..'), { recursive: true })
  writeFileSync(abs, content)
}

function paths(entries: { path: string }[]): string[] {
  return entries.map((e) => e.path)
}

describe('listFiles — content + ordering', () => {
  it('honors .gitignore (root + nested), skips .git, includes dotfiles, deterministic order', async () => {
    const root = tmp('vibe-list-')
    write(root, '.git/HEAD', 'ref: refs/heads/main')
    write(root, '.gitignore', 'node_modules\n*.log\nbuild/\n')
    write(root, '.env.example', 'X=1')
    write(root, 'README.md', '# hi')
    write(root, 'src/app.ts', '')
    write(root, 'src/app.log', '') // ignored by *.log
    write(root, 'node_modules/pkg/index.js', '') // ignored dir (not descended)
    write(root, 'build/out.js', '') // ignored dir
    write(root, 'nested/.gitignore', '!allow.log\nsecret.txt\n')
    write(root, 'nested/allow.log', '') // re-included by the nested negation
    write(root, 'nested/secret.txt', '') // ignored by the nested rule
    write(root, 'nested/keep.ts', '')

    const { entries, truncated } = await listFiles(root)

    // Directories first, then files, each name-sorted (code-unit); parent before children.
    expect(paths(entries)).toEqual([
      'nested',
      'nested/.gitignore',
      'nested/allow.log',
      'nested/keep.ts',
      'src',
      'src/app.ts',
      '.env.example',
      '.gitignore',
      'README.md',
    ])
    expect(truncated).toBe(false)

    const all = paths(entries)
    expect(all).not.toContain('.git') // hard-skipped
    expect(all.some((p) => p.startsWith('node_modules'))).toBe(false)
    expect(all).not.toContain('build')
    expect(all).not.toContain('src/app.log')
    expect(all).not.toContain('nested/secret.txt')
  })

  it('reports directory vs file kind', async () => {
    const root = tmp('vibe-list-')
    write(root, 'dir/file.ts', '')
    const { entries } = await listFiles(root)
    expect(entries).toContainEqual({ path: 'dir', kind: 'directory' })
    expect(entries).toContainEqual({ path: 'dir/file.ts', kind: 'file' })
  })

  it('caps at the limit and flags truncated', async () => {
    const root = tmp('vibe-list-')
    for (let i = 0; i < 50; i++) write(root, `f${String(i).padStart(3, '0')}.txt`, '')
    const { entries, truncated } = await listFiles(root, { cap: 10 })
    expect(entries).toHaveLength(10)
    expect(truncated).toBe(true)
  })

  it('degrades to an empty result for a missing root', async () => {
    const result = await listFiles(join(tmpdir(), 'vibe-does-not-exist-xyz'))
    expect(result).toEqual({ entries: [], truncated: false })
  })
})

describe('listFiles — confinement (symlinks never followed)', () => {
  it('lists a symlink to an OUTSIDE directory but never descends it', async () => {
    const root = tmp('vibe-ws-')
    const outside = tmp('vibe-outside-')
    write(outside, 'secret.txt', 'do not read')
    symlinkSync(outside, join(root, 'escape')) // in-Workspace link pointing OUT

    const { entries } = await listFiles(root)
    const all = paths(entries)
    // The link is listed as a leaf FILE...
    expect(entries).toContainEqual({ path: 'escape', kind: 'file' })
    // ...but the outside target is NEVER descended into.
    expect(all.some((p) => p.startsWith('escape/'))).toBe(false)
    expect(all).not.toContain('escape/secret.txt')
  })

  it('terminates on a symlink cycle (link back to an ancestor)', async () => {
    const root = tmp('vibe-ws-')
    write(root, 'real.ts', '')
    symlinkSync(root, join(root, 'loop')) // loop -> root — a cycle if followed

    const { entries } = await listFiles(root) // must return, not hang
    const all = paths(entries)
    expect(entries).toContainEqual({ path: 'loop', kind: 'file' })
    expect(all.some((p) => p.startsWith('loop/'))).toBe(false)
    expect(all).toContain('real.ts')
  })

  it('never emits a `..`, an absolute path, or a backslash separator', async () => {
    const root = tmp('vibe-ws-')
    const outside = tmp('vibe-outside-')
    write(root, 'a/b/c.ts', '')
    symlinkSync(outside, join(root, 'a', 'out'))

    const { entries } = await listFiles(root)
    for (const { path } of entries) {
      expect(path.startsWith('/')).toBe(false)
      expect(path.includes('..')).toBe(false)
      expect(path.includes('\\')).toBe(false)
    }
  })

  // #188 security review F2: a `.gitignore` that is itself a symlink pointing OUTSIDE the
  // Workspace must NOT be followed — reading it would pull an outside file's content into
  // the ignore rules, breaking the no-follow confinement invariant.
  it('does not follow a symlinked .gitignore (no outside content read)', async () => {
    const root = tmp('vibe-ws-')
    const outside = tmp('vibe-outside-')
    write(outside, 'evil-rules', 'app.ts\n') // outside "rules" that would hide app.ts
    write(root, 'app.ts', '')
    write(root, 'keep.ts', '')
    symlinkSync(join(outside, 'evil-rules'), join(root, '.gitignore'))

    const { entries } = await listFiles(root)
    const all = paths(entries)
    // The symlinked .gitignore is ignored, so its outside rules never apply: app.ts stays.
    expect(all).toContain('app.ts')
    expect(all).toContain('keep.ts')
    // The .gitignore symlink itself is listed as an ordinary leaf (never descended/read as rules).
    expect(entries).toContainEqual({ path: '.gitignore', kind: 'file' })
  })
})
