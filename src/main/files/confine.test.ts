import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { confineExistingFile } from './confine'

/**
 * Exercises the DEFAULT fs boundary against real tmpdir fixtures (like read-file.test.ts)
 * so the confinement decisions — real symlinks, real out-of-tree targets — are proven
 * against the actual kernel behavior, not a fake.
 */

const HOME = '/nonexistent-home'

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

describe('confineExistingFile', () => {
  it('accepts an in-tree file and reports its realpath + size', async () => {
    const root = tmp('vibe-confine-')
    writeFileSync(join(root, 'a.txt'), 'hello')
    const res = await confineExistingFile(root, 'a.txt', HOME)
    expect(res).toEqual({ ok: true, realTarget: join(realpathSync(root), 'a.txt'), size: 5 })
  })

  it('accepts a nested relative path', async () => {
    const root = tmp('vibe-confine-')
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'b.ts'), 'x')
    const res = await confineExistingFile(root, 'src/b.ts', HOME)
    expect(res.ok).toBe(true)
  })

  it('refuses a directory', async () => {
    const root = tmp('vibe-confine-')
    mkdirSync(join(root, 'dir'))
    expect(await confineExistingFile(root, 'dir', HOME)).toEqual({ ok: false, reason: 'not-a-file' })
  })

  it('refuses a `..` escape to an out-of-tree file', async () => {
    const root = tmp('vibe-confine-')
    const outside = tmp('vibe-confine-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'no')
    const res = await confineExistingFile(root, join('..', outside.split('/').pop()!, 'secret.txt'), HOME)
    expect(res).toMatchObject({ ok: false, reason: 'outside-workspace' })
  })

  it('refuses an absolute out-of-tree path', async () => {
    const root = tmp('vibe-confine-')
    const outside = tmp('vibe-confine-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'no')
    const res = await confineExistingFile(root, join(outside, 'secret.txt'), HOME)
    expect(res).toMatchObject({ ok: false, reason: 'outside-workspace' })
  })

  it('refuses an in-tree symlink that points out of the tree', async () => {
    const root = tmp('vibe-confine-')
    const outside = tmp('vibe-confine-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'no')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    const res = await confineExistingFile(root, 'link.txt', HOME)
    expect(res).toMatchObject({ ok: false, reason: 'outside-workspace' })
  })

  it('accepts a file under a symlinked Workspace root (not falsely rejected)', async () => {
    const real = tmp('vibe-confine-')
    writeFileSync(join(real, 'a.txt'), 'ok')
    const linkRoot = join(tmp('vibe-confine-link-'), 'root')
    symlinkSync(real, linkRoot)
    const res = await confineExistingFile(linkRoot, 'a.txt', HOME)
    expect(res.ok).toBe(true)
  })

  it('throws on a missing target (callers catch best-effort)', async () => {
    const root = tmp('vibe-confine-')
    await expect(confineExistingFile(root, 'nope.txt', HOME)).rejects.toThrow()
  })
})
