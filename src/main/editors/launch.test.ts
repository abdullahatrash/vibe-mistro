import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { launchEditor } from './launch'

const posixOnly = process.platform === 'win32' ? describe.skip : describe

posixOnly('launchEditor', () => {
  let binDir: string
  let workspaceDir: string

  /** A fake editor CLI that records its argv so the test can assert the launch. */
  async function installRecordingEditor(name: string): Promise<string> {
    const recordFile = join(binDir, `${name}.argv`)
    const path = join(binDir, name)
    await writeFile(path, `#!/bin/sh\necho "$@" > "${recordFile}"\n`)
    await chmod(path, 0o755)
    return recordFile
  }

  async function readRecordedArgv(recordFile: string): Promise<string> {
    // The child is detached — poll briefly for its write instead of racing it.
    for (let i = 0; i < 50; i++) {
      try {
        return (await readFile(recordFile, 'utf8')).trim()
      } catch {
        await sleep(20)
      }
    }
    throw new Error(`fake editor never wrote ${recordFile}`)
  }

  beforeEach(async () => {
    binDir = await mkdtemp(join(tmpdir(), 'vibe-mistro-launch-bin-'))
    workspaceDir = await mkdtemp(join(tmpdir(), 'vibe-mistro-launch-ws-'))
  })

  afterEach(async () => {
    await rm(binDir, { recursive: true, force: true })
    await rm(workspaceDir, { recursive: true, force: true })
  })

  it('spawns the editor CLI with the Workspace dir', async () => {
    const recordFile = await installRecordingEditor('zed')
    const result = await launchEditor({
      workspaceDir,
      editorId: 'zed',
      env: { PATH: binDir },
      platform: process.platform,
    })
    expect(result).toEqual({ ok: true })
    expect(await readRecordedArgv(recordFile)).toBe(workspaceDir)
  })

  it('falls through alias order to the installed CLI (zed -> zeditor)', async () => {
    const recordFile = await installRecordingEditor('zeditor')
    const result = await launchEditor({
      workspaceDir,
      editorId: 'zed',
      env: { PATH: binDir },
      platform: process.platform,
    })
    expect(result).toEqual({ ok: true })
    expect(await readRecordedArgv(recordFile)).toBe(workspaceDir)
  })

  it('opens the file-manager entry via the platform opener', async () => {
    const recordFile = await installRecordingEditor('xdg-open')
    const result = await launchEditor({
      workspaceDir,
      editorId: 'file-manager',
      env: { PATH: binDir },
      platform: 'linux',
    })
    expect(result).toEqual({ ok: true })
    expect(await readRecordedArgv(recordFile)).toBe(workspaceDir)
  })

  it('rejects an id outside the curated table', async () => {
    const result = await launchEditor({
      workspaceDir,
      editorId: 'not-an-editor',
      env: { PATH: binDir },
      platform: process.platform,
    })
    expect(result).toEqual({ ok: false, reason: 'unknown-editor' })
  })

  it('reports command-not-found when no alias resolves on PATH', async () => {
    const result = await launchEditor({
      workspaceDir,
      editorId: 'cursor',
      env: { PATH: binDir },
      platform: process.platform,
    })
    expect(result).toEqual({ ok: false, reason: 'command-not-found' })
  })
})
