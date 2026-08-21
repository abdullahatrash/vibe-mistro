import { describe, expect, it } from 'vitest'
import { ensureRoutineGate, type RoutineProfileFs } from './write-routine-profile'
import { confirmRoutineGate } from './confirm-routine-gate'

/**
 * Putting the gate on disk and PROVING it is there (#469).
 *
 * Every test injects a fake filesystem — the real `~/.vibe/` is never touched,
 * which is the same rule the Bot profile writer's suite holds and matters more
 * here, since this writes into the directory a user's own profiles live in.
 */

const BOT = 'mistro-bot-11111111-2222-3333-4444-555555555555'
const GATE = 'mistro-routine-11111111-2222-3333-4444-555555555555'
const DIRS = { agentsDir: '/home/u/.vibe/agents', promptsDir: '/home/u/.vibe/prompts' }
const SOURCE = { botProfileId: BOT, botName: 'Triager' }

/** An in-memory `RoutineProfileFs`, with hooks for the failures that matter. */
function fakeFs(
  over: {
    onWrite?: (path: string, contents: string) => string | void
    onRead?: (path: string) => string
    failMkdir?: boolean
  } = {},
): RoutineProfileFs & { files: Map<string, string>; dirs: string[] } {
  const files = new Map<string, string>()
  const dirs: string[] = []
  return {
    files,
    dirs,
    mkdir: async (dir) => {
      if (over.failMkdir) throw new Error('EACCES')
      dirs.push(dir)
    },
    writeFile: async (path, contents) => {
      files.set(path, over.onWrite?.(path, contents) ?? contents)
    },
    readFile: async (path) => {
      if (over.onRead) return over.onRead(path)
      const found = files.get(path)
      if (found === undefined) throw new Error(`ENOENT: ${path}`)
      return found
    },
  }
}

describe('ensureRoutineGate', () => {
  it('writes the gate into the agents dir and confirms it', async () => {
    const fs = fakeFs()
    const result = await ensureRoutineGate({ source: SOURCE, dirs: DIRS, fs })
    expect(result).toEqual({ ok: true, profileId: GATE })
    // ONE file, and no prompt `.md`: `system_prompt_id` names the Bot's own
    // prompt, so a scheduled turn is the same teammate with a gate on it rather
    // than a second persona that could drift from the first.
    expect(fs.dirs).toEqual([DIRS.agentsDir])
    expect([...fs.files.keys()]).toEqual([`${DIRS.agentsDir}/${GATE}.toml`])
    const written = fs.files.get(`${DIRS.agentsDir}/${GATE}.toml`)
    expect(written).toBeDefined()
    expect(confirmRoutineGate(written ?? '', { profileId: GATE, botProfileId: BOT })).toEqual({
      ok: true,
    })
  })

  it('refuses a Bot profile id that is not ours, and writes nothing', async () => {
    const fs = fakeFs()
    for (const botProfileId of ['ask', GATE, 'mistro-bot-nope', '../../etc/passwd']) {
      const result = await ensureRoutineGate({
        source: { botProfileId, botName: 'x' },
        dirs: DIRS,
        fs,
      })
      expect(result).toMatchObject({ ok: false, reason: 'refused' })
    }
    expect(fs.files.size).toBe(0)
  })

  it('REFUSES when the file on disk is not the gate we wrote', async () => {
    // The case the read-back exists for. Nothing on the wire would ever tell us:
    // Vibe loads this file, offers it as a mode, and gates nothing.
    const fs = fakeFs({ onWrite: (_path, contents) => contents.replace('allowlist = []', 'allowlist = ["echo"]') })
    const result = await ensureRoutineGate({ source: SOURCE, dirs: DIRS, fs })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect((result as { problems: string[] }).problems.join(' ')).toContain('tools.bash.allowlist')
  })

  it('REFUSES when the read-back comes back empty or absent', async () => {
    const empty = await ensureRoutineGate({ source: SOURCE, dirs: DIRS, fs: fakeFs({ onRead: () => '' }) })
    expect(empty).toMatchObject({ ok: false, reason: 'invalid' })

    const missing = await ensureRoutineGate({
      source: SOURCE,
      dirs: DIRS,
      fs: fakeFs({
        onRead: () => {
          throw new Error('ENOENT')
        },
      }),
    })
    expect(missing).toMatchObject({ ok: false, reason: 'io' })
  })

  it('reports an unwritable agents dir as io rather than pretending it is gated', async () => {
    const result = await ensureRoutineGate({ source: SOURCE, dirs: DIRS, fs: fakeFs({ failMkdir: true }) })
    expect(result).toMatchObject({ ok: false, reason: 'io' })
  })

  it('is idempotent — every run rewrites and re-confirms the same bytes', async () => {
    const fs = fakeFs()
    await ensureRoutineGate({ source: SOURCE, dirs: DIRS, fs })
    const first = fs.files.get(`${DIRS.agentsDir}/${GATE}.toml`)
    // Somebody hand-edits the gate open between runs...
    fs.files.set(`${DIRS.agentsDir}/${GATE}.toml`, 'display_name = "mine now"\n')
    const again = await ensureRoutineGate({ source: SOURCE, dirs: DIRS, fs })
    // ...and the next run heals it rather than refusing forever.
    expect(again).toEqual({ ok: true, profileId: GATE })
    expect(fs.files.get(`${DIRS.agentsDir}/${GATE}.toml`)).toBe(first)
  })
})
