import { describe, it, expect, vi } from 'vitest'
import {
  capScrollback,
  MAX_SCROLLBACK_CHARS,
  shellCandidates,
  terminalEnv,
  TerminalManager,
  type PtyLike,
  type SpawnPtyOptions,
} from './terminal-manager'
import { MAX_TERMINAL_WRITE_CHARS, type TerminalEvent } from '../../shared/ipc'

/**
 * The main-side Workspace terminal sessions (ADR-0014). Exercised entirely
 * through the injected `spawnPty` seam with a scripted fake PTY — no node-pty,
 * no real shell. The seam mirrors the node-pty surface the registrar wires.
 */

class FakePty implements PtyLike {
  pid = 4242
  written: string[] = []
  resized: Array<[number, number]> = []
  killed: string[] = []
  private dataListener: ((data: string) => void) | null = null
  private exitListener: ((e: { exitCode: number; signal?: number }) => void) | null = null

  onData(listener: (data: string) => void): void {
    this.dataListener = listener
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitListener = listener
  }
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows])
  }
  kill(signal?: string): void {
    this.killed.push(signal ?? 'SIGTERM')
  }

  emitData(data: string): void {
    this.dataListener?.(data)
  }
  emitExit(exitCode: number): void {
    this.exitListener?.({ exitCode })
  }
}

function harness(overrides?: {
  spawn?: (opts: SpawnPtyOptions) => PtyLike
  env?: NodeJS.ProcessEnv
}): {
  manager: TerminalManager
  events: TerminalEvent[]
  ptys: FakePty[]
  spawns: SpawnPtyOptions[]
  timers: Array<{ fn: () => void }>
} {
  const events: TerminalEvent[] = []
  const ptys: FakePty[] = []
  const spawns: SpawnPtyOptions[] = []
  const timers: Array<{ fn: () => void }> = []
  const manager = new TerminalManager({
    spawnPty:
      overrides?.spawn ??
      ((opts) => {
        spawns.push(opts)
        const pty = new FakePty()
        ptys.push(pty)
        return pty
      }),
    env: overrides?.env ?? { SHELL: '/bin/zsh', PATH: '/usr/bin' },
    emit: (event) => events.push(event),
    setTimeoutFn: ((fn: () => void) => {
      const timer = { fn }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout,
    clearTimeoutFn: (() => {}) as typeof clearTimeout,
  })
  return { manager, events, ptys, spawns, timers }
}

describe('shellCandidates / terminalEnv', () => {
  it('orders $SHELL first, dedupes, and always ends at /bin/sh', () => {
    expect(shellCandidates({ SHELL: '/bin/zsh' })).toEqual(['/bin/zsh', '/bin/bash', '/bin/sh'])
    expect(shellCandidates({})).toEqual(['/bin/zsh', '/bin/bash', '/bin/sh'])
    expect(shellCandidates({ SHELL: '/opt/fish' })[0]).toBe('/opt/fish')
  })

  it('strips the Electron/dev blocklist but keeps PATH and toolchain vars (denylist, not allowlist)', () => {
    const env = terminalEnv({
      PATH: '/usr/bin:/opt/homebrew/bin',
      HOME: '/Users/u',
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_RENDERER_PORT: '5173',
      PORT: '3000',
      NODE_OPTIONS: '--inspect',
      VIBE_MISTRO_INTERNAL: 'x',
      CARGO_HOME: '/Users/u/.cargo',
      GONE: undefined,
    })
    expect(env.PATH).toBe('/usr/bin:/opt/homebrew/bin')
    expect(env.CARGO_HOME).toBe('/Users/u/.cargo')
    expect(env).not.toHaveProperty('ELECTRON_RUN_AS_NODE')
    expect(env).not.toHaveProperty('ELECTRON_RENDERER_PORT')
    expect(env).not.toHaveProperty('PORT')
    expect(env).not.toHaveProperty('NODE_OPTIONS')
    expect(env).not.toHaveProperty('VIBE_MISTRO_INTERNAL')
    expect(env).not.toHaveProperty('GONE')
  })
})

describe('TerminalManager openOrAttach', () => {
  it('spawns the shell in the given cwd and streams output events tagged by workspace + terminal', () => {
    const { manager, events, ptys, spawns } = harness()
    const result = manager.openOrAttach('w1', { cwd: '/proj', cols: 120, rows: 30 })

    expect(result).toEqual({ ok: true, terminalId: 'term-1', snapshot: '', exited: false })
    expect(spawns[0]).toMatchObject({ file: '/bin/zsh', cwd: '/proj', cols: 120, rows: 30 })

    ptys[0].emitData('hello\r\n')
    expect(events).toEqual([
      { workspaceId: 'w1', terminalId: 'term-1', event: { type: 'output', data: 'hello\r\n' } },
    ])
  })

  it('REATTACHES to a running session: no respawn, snapshot carries the buffered scrollback', () => {
    const { manager, ptys, spawns } = harness()
    manager.openOrAttach('w1', { cwd: '/proj', cols: 120, rows: 30 })
    ptys[0].emitData('$ ls\r\nsrc\r\n')

    const again = manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })
    expect(again).toEqual({ ok: true, terminalId: 'term-1', snapshot: '$ ls\r\nsrc\r\n', exited: false })
    expect(spawns).toHaveLength(1) // no second spawn
  })

  it('walks the shell fallback chain when a candidate throws (missing shell)', () => {
    const spawns: SpawnPtyOptions[] = []
    const pty = new FakePty()
    const { manager } = harness({
      spawn: (opts) => {
        spawns.push(opts)
        if (opts.file !== '/bin/sh') throw new Error(`ENOENT: ${opts.file}`)
        return pty
      },
      env: { SHELL: '/opt/gone-fish' },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })
    errSpy.mockRestore()

    expect(result.ok).toBe(true)
    expect(spawns.map((s) => s.file)).toEqual(['/opt/gone-fish', '/bin/zsh', '/bin/bash', '/bin/sh'])
  })

  it('resolves {ok:false} when EVERY candidate fails — never throws', () => {
    const { manager } = harness({
      spawn: () => {
        throw new Error('ENOENT')
      },
    })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })
    errSpy.mockRestore()

    expect(result).toEqual({ ok: false, error: 'Could not start a shell: ENOENT' })
    expect(manager.has('w1')).toBe(false)
  })

  it('an EXITED session is respawned fresh on reopen (banner was seen; new shell)', () => {
    const { manager, ptys, spawns, events } = harness()
    manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })
    ptys[0].emitExit(0)
    expect(events.at(-1)).toEqual({
      workspaceId: 'w1',
      terminalId: 'term-1',
      event: { type: 'exited', exitCode: 0 },
    })

    const reopened = manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })
    expect(reopened).toEqual({ ok: true, terminalId: 'term-1', snapshot: '', exited: false })
    expect(spawns).toHaveLength(2)
  })
})

describe('TerminalManager write / resize', () => {
  it('forwards writes and clamps resize to the shared bounds', () => {
    const { manager, ptys } = harness()
    manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })

    manager.write('w1', 'ls\r')
    expect(ptys[0].written).toEqual(['ls\r'])

    manager.resize('w1', 5000, 0)
    expect(ptys[0].resized).toEqual([[1000, 1]])
  })

  it('refuses an oversized write whole and ignores unknown/exited sessions', () => {
    const { manager, ptys } = harness()
    manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    manager.write('w1', 'x'.repeat(MAX_TERMINAL_WRITE_CHARS + 1))
    errSpy.mockRestore()
    expect(ptys[0].written).toEqual([])

    manager.write('missing', 'ls\r') // unknown workspace — no throw
    ptys[0].emitExit(0)
    manager.write('w1', 'ls\r') // exited — dropped
    expect(ptys[0].written).toEqual([])
  })
})

describe('TerminalManager close / disposeAll', () => {
  it('closes with SIGTERM, then SIGKILL after the grace when the process lingers', () => {
    const { manager, ptys, timers } = harness()
    manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })

    manager.close('w1')
    expect(ptys[0].killed).toEqual(['SIGTERM'])
    expect(manager.has('w1')).toBe(false)

    timers[0].fn() // the grace elapses without an exit
    expect(ptys[0].killed).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('skips the SIGKILL when the process exits within the grace', () => {
    const { manager, ptys, timers } = harness()
    manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })

    manager.close('w1')
    ptys[0].emitExit(143)
    timers[0].fn()
    expect(ptys[0].killed).toEqual(['SIGTERM'])
  })

  it('a dying shell\'s late output/exit never bleeds into a reopened session', () => {
    const { manager, ptys, events } = harness()
    manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })
    manager.close('w1')
    manager.openOrAttach('w1', { cwd: '/proj', cols: 80, rows: 24 })
    events.length = 0

    ptys[0].emitData('late gasp') // the OLD pty
    ptys[0].emitExit(137)
    expect(events).toEqual([]) // nothing emitted for the stale session

    ptys[1].emitData('fresh')
    expect(events).toEqual([
      { workspaceId: 'w1', terminalId: 'term-1', event: { type: 'output', data: 'fresh' } },
    ])
  })

  it('disposeAll closes every session (app quit)', () => {
    const { manager, ptys } = harness()
    manager.openOrAttach('w1', { cwd: '/a', cols: 80, rows: 24 })
    manager.openOrAttach('w2', { cwd: '/b', cols: 80, rows: 24 })

    manager.disposeAll()
    expect(ptys[0].killed).toEqual(['SIGTERM'])
    expect(ptys[1].killed).toEqual(['SIGTERM'])
    expect(manager.has('w1')).toBe(false)
    expect(manager.has('w2')).toBe(false)
  })
})

describe('capScrollback', () => {
  it('keeps a under-cap buffer untouched and trims an over-cap one at a line boundary', () => {
    expect(capScrollback('short')).toBe('short')

    const lines = `${'x'.repeat(100)}\n`.repeat(Math.ceil(MAX_SCROLLBACK_CHARS / 101) + 50)
    const capped = capScrollback(lines)
    expect(capped.length).toBeLessThanOrEqual(MAX_SCROLLBACK_CHARS)
    expect(capped.startsWith('x'.repeat(100))).toBe(true) // opens on a whole line

    const oneLine = 'y'.repeat(MAX_SCROLLBACK_CHARS + 500)
    expect(capScrollback(oneLine)).toHaveLength(MAX_SCROLLBACK_CHARS) // no newline — hard cut
  })
})
