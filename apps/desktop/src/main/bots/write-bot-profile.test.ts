import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BOT_PROFILE_HEADER, type BotProfileSource } from './bot-profile'
import type { VibeProfileDirs } from './profile-dirs'
import { removeBotProfile, writeBotProfile, type BotProfileFs } from './write-bot-profile'

/**
 * Every test here drives the writer through an INJECTED fs seam — nothing in
 * this file imports `node:fs`, so no run can touch the real `~/.vibe/`.
 */

const PROFILE_ID = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const DIRS: VibeProfileDirs = { agentsDir: '/home/u/.vibe/agents', promptsDir: '/home/u/.vibe/prompts' }

function source(overrides: Partial<BotProfileSource> = {}): BotProfileSource {
  return {
    profileId: PROFILE_ID,
    name: 'Rex',
    description: 'Reviews my diffs',
    instructions: 'Read the diff first.',
    ...overrides,
  }
}

interface FakeFs extends BotProfileFs {
  dirs: string[]
  files: Map<string, string>
  removed: string[]
  failMkdir?: boolean
  failWrite?: string
  failRm?: string
}

function fakeFs(overrides: Partial<Pick<FakeFs, 'failMkdir' | 'failWrite' | 'failRm'>> = {}): FakeFs {
  const fs: FakeFs = {
    dirs: [],
    files: new Map(),
    removed: [],
    ...overrides,
    mkdir: async (dir) => {
      if (fs.failMkdir) throw new Error('EACCES')
      fs.dirs.push(dir)
    },
    writeFile: async (path, contents) => {
      if (fs.failWrite && path.endsWith(fs.failWrite)) throw new Error('ENOSPC')
      fs.files.set(path, contents)
    },
    rm: async (path) => {
      if (fs.failRm && path.endsWith(fs.failRm)) throw new Error('EPERM')
      fs.removed.push(path)
      fs.files.delete(path)
    },
  }
  return fs
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('writeBotProfile', () => {
  it('creates BOTH dirs — Vibe creates neither (verified, acp-capture §14.3)', async () => {
    const fs = fakeFs()
    await writeBotProfile({ source: source(), dirs: DIRS, fs })
    expect(fs.dirs).toContain(DIRS.agentsDir)
    expect(fs.dirs).toContain(DIRS.promptsDir)
  })

  it('writes the TOML and the prompt .md under the profile id, both header-marked', async () => {
    const fs = fakeFs()
    const result = await writeBotProfile({ source: source(), dirs: DIRS, fs })

    expect(result).toEqual({ ok: true, profileId: PROFILE_ID })
    const toml = fs.files.get(`${DIRS.agentsDir}/${PROFILE_ID}.toml`)
    const prompt = fs.files.get(`${DIRS.promptsDir}/${PROFILE_ID}.md`)
    expect(toml).toContain(`# ${BOT_PROFILE_HEADER}`)
    expect(toml).toContain('display_name = "Rex"')
    expect(toml).toContain(`system_prompt_id = "${PROFILE_ID}"`)
    expect(prompt).toContain(BOT_PROFILE_HEADER)
    expect(prompt).toContain('Read the diff first.')
  })

  it('writes the prompt BEFORE the TOML, so a half-failure never leaves a profile that cannot load', async () => {
    const order: string[] = []
    const fs = fakeFs()
    const spy: BotProfileFs = { ...fs, writeFile: async (path, contents) => {
      order.push(path)
      await fs.writeFile(path, contents)
    } }
    await writeBotProfile({ source: source(), dirs: DIRS, fs: spy })
    expect(order).toEqual([
      `${DIRS.promptsDir}/${PROFILE_ID}.md`,
      `${DIRS.agentsDir}/${PROFILE_ID}.toml`,
    ])
  })

  it('rewrites in place on a rename, keeping the same immutable id', async () => {
    const fs = fakeFs()
    await writeBotProfile({ source: source(), dirs: DIRS, fs })
    await writeBotProfile({ source: source({ name: 'Rexina' }), dirs: DIRS, fs })

    expect([...fs.files.keys()]).toHaveLength(2)
    expect(fs.files.get(`${DIRS.agentsDir}/${PROFILE_ID}.toml`)).toContain('display_name = "Rexina"')
  })

  it('REFUSES a foreign profile id without touching the disk at all', async () => {
    for (const foreign of ['ask', 'my-reviewer', 'plan']) {
      const fs = fakeFs()
      const result = await writeBotProfile({ source: source({ profileId: foreign }), dirs: DIRS, fs })
      expect(result).toMatchObject({ ok: false, reason: 'refused' })
      expect(fs.files.size).toBe(0)
      expect(fs.dirs).toHaveLength(0)
    }
  })

  it('refuses an invalid record before writing, and says why', async () => {
    const fs = fakeFs()
    const result = await writeBotProfile({ source: source({ name: '  ' }), dirs: DIRS, fs })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(result.ok === false && result.problems.join(' ')).toContain('name')
    expect(fs.files.size).toBe(0)
  })

  it('reports an fs failure as `io` rather than throwing into the create flow', async () => {
    const mkdirFailure = await writeBotProfile({ source: source(), dirs: DIRS, fs: fakeFs({ failMkdir: true }) })
    expect(mkdirFailure).toMatchObject({ ok: false, reason: 'io' })

    const writeFailure = await writeBotProfile({
      source: source(),
      dirs: DIRS,
      fs: fakeFs({ failWrite: '.toml' }),
    })
    expect(writeFailure).toMatchObject({ ok: false, reason: 'io' })
  })
})

describe('removeBotProfile', () => {
  it('deletes both files, TOML first', async () => {
    const fs = fakeFs()
    await writeBotProfile({ source: source(), dirs: DIRS, fs })
    const ok = await removeBotProfile({ profileId: PROFILE_ID, dirs: DIRS, fs })

    expect(ok).toBe(true)
    expect(fs.removed).toEqual([
      `${DIRS.agentsDir}/${PROFILE_ID}.toml`,
      `${DIRS.promptsDir}/${PROFILE_ID}.md`,
    ])
    expect(fs.files.size).toBe(0)
  })

  it('REFUSES to delete a profile we do not own — no fs call is made', async () => {
    for (const foreign of ['ask', 'accept-edits', 'my-reviewer', '', 'mistro-bot-not-a-uuid']) {
      const fs = fakeFs()
      fs.files.set(`${DIRS.agentsDir}/${foreign}.toml`, 'hand-written')
      const ok = await removeBotProfile({ profileId: foreign, dirs: DIRS, fs })
      expect(ok).toBe(false)
      expect(fs.removed).toHaveLength(0)
      expect(fs.files.get(`${DIRS.agentsDir}/${foreign}.toml`)).toBe('hand-written')
    }
  })

  it('keeps going when one removal fails, and reports the failure', async () => {
    const fs = fakeFs({ failRm: '.toml' })
    const ok = await removeBotProfile({ profileId: PROFILE_ID, dirs: DIRS, fs })
    expect(ok).toBe(false)
    expect(fs.removed).toEqual([`${DIRS.promptsDir}/${PROFILE_ID}.md`])
  })
})
