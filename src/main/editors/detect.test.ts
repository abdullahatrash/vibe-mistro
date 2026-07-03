import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  candidateCommandPaths,
  detectAvailableEditors,
  resolveAvailableCommand,
  resolveCommandPath,
} from './detect'

describe('candidateCommandPaths', () => {
  it('joins the command onto every PATH dir (posix)', () => {
    expect(candidateCommandPaths('code', '/usr/bin:/opt/bin', 'darwin')).toEqual([
      '/usr/bin/code',
      '/opt/bin/code',
    ])
  })

  it('skips empty PATH segments', () => {
    expect(candidateCommandPaths('code', '/usr/bin::', 'linux')).toEqual(['/usr/bin/code'])
  })

  it('fans out per PATHEXT extension on win32', () => {
    const candidates = candidateCommandPaths('code', 'C:\\bin', 'win32', '.EXE;.CMD')
    expect(candidates).toEqual([join('C:\\bin', 'code.EXE'), join('C:\\bin', 'code.CMD')])
  })

  it('returns nothing for an empty PATH', () => {
    expect(candidateCommandPaths('code', '', 'darwin')).toEqual([])
  })
})

describe('PATH probing against a real fixture dir', () => {
  let binDir: string

  async function installExecutable(name: string): Promise<void> {
    const path = join(binDir, name)
    await writeFile(path, '#!/bin/sh\nexit 0\n')
    await chmod(path, 0o755)
  }

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'vibe-mistro-editors-'))
  })

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true })
  })

  it('resolveCommandPath resolves an executable to its absolute path, misses an absent one', async () => {
    await installExecutable('zed')
    const env = { PATH: binDir }
    expect(await resolveCommandPath('zed', env, process.platform)).toBe(join(binDir, 'zed'))
    expect(await resolveCommandPath('cursor', env, process.platform)).toBeNull()
  })

  it('a non-executable file does not count (posix)', async () => {
    if (process.platform === 'win32') return // X_OK is a no-op on Windows
    await writeFile(join(binDir, 'code'), 'not executable')
    expect(await resolveCommandPath('code', { PATH: binDir }, process.platform)).toBeNull()
  })

  it('resolveAvailableCommand picks the FIRST available alias', async () => {
    await installExecutable('zeditor')
    const env = { PATH: binDir }
    expect(await resolveAvailableCommand(['zed', 'zeditor'], env, process.platform)).toBe(
      join(binDir, 'zeditor'),
    )
    expect(await resolveAvailableCommand(['nope', 'nada'], env, process.platform)).toBeNull()
  })

  it('detectAvailableEditors reports installed editors in table order', async () => {
    // Install out of preference order — detection must still report table order.
    await installExecutable('zed')
    await installExecutable('cursor')
    const detected = await detectAvailableEditors({ PATH: binDir }, 'darwin')
    expect(detected).toEqual(['cursor', 'zed'])
  })

  it('detectAvailableEditors includes file-manager when the platform opener resolves', async () => {
    await installExecutable('open')
    const detected = await detectAvailableEditors({ PATH: binDir }, 'darwin')
    expect(detected).toEqual(['file-manager'])
  })

  it('detectAvailableEditors is empty on an empty PATH', async () => {
    expect(await detectAvailableEditors({ PATH: '' }, 'darwin')).toEqual([])
  })
})
