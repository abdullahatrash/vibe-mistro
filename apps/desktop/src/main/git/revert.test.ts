import { describe, it, expect } from 'vitest'
import { gitRevert } from './revert'
import type { GitRun } from './run'

/**
 * `gitRevert` is the DESTRUCTIVE git write (#250) — the testable seam is the exact
 * COMMAND SEQUENCE per file bucket over a fake `GitRun` (no test shells real git):
 * tracked-in-HEAD files restore, index-only adds unstage-then-clean, untracked files
 * clean, renames restore their origin and clean the new name. The UI's warning dialog
 * is the safety; this module just has to destroy EXACTLY the selection, nothing more.
 */

function fakeRun(
  seen: string[][],
  responses: { stdout?: string; stderr?: string; code: number }[] = [],
): GitRun {
  let i = 0
  return (args) => {
    seen.push(args)
    const r = responses[i++] ?? { code: 0 }
    return Promise.resolve({ stdout: r.stdout ?? '', stderr: r.stderr ?? '', code: r.code })
  }
}

function file(path: string, status = '.M', untracked = false): { path: string; status: string; untracked: boolean } {
  return { path, status, untracked }
}

describe('gitRevert: all', () => {
  it('reverts EVERYTHING: hard reset then clean untracked (incl. directories)', async () => {
    const seen: string[][] = []
    const result = await gitRevert('/repo', [], true, fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['reset', '--hard', '-q'],
      ['clean', '-fd', '-q'],
    ])
  })

  it('a failing reset surfaces git’s reason and skips the clean', async () => {
    const seen: string[][] = []
    const result = await gitRevert('/repo', [], true, fakeRun(seen, [{ stderr: 'fatal: index lock', code: 128 }]))
    expect(result).toEqual({ ok: false, error: 'fatal: index lock' })
    expect(seen).toEqual([['reset', '--hard', '-q']])
  })
})

describe('gitRevert: selection', () => {
  it('a MODIFIED tracked file restores staged+worktree from HEAD in one command', async () => {
    const seen: string[][] = []
    const result = await gitRevert('/repo', [file('a.txt', 'MM')], false, fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['-c', 'core.quotePath=false', 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'a.txt'],
    ])
  })

  it('an UNTRACKED file is DELETED via clean (no restore possible)', async () => {
    const seen: string[][] = []
    const result = await gitRevert('/repo', [file('new.txt', '?', true)], false, fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([['-c', 'core.quotePath=false', 'clean', '-f', '-q', '--', 'new.txt']])
  })

  it('an index-only ADD (not in HEAD) unstages then cleans — restore would fail on it', async () => {
    const seen: string[][] = []
    const result = await gitRevert('/repo', [file('added.txt', 'A.')], false, fakeRun(seen))
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['reset', '-q', '--', 'added.txt'],
      ['-c', 'core.quotePath=false', 'clean', '-f', '-q', '--', 'added.txt'],
    ])
  })

  it('a staged RENAME restores its ORIGIN and cleans the new name', async () => {
    const seen: string[][] = []
    const porcelain = '2 R. N... 100644 100644 100644 111 222 R100 moved.txt\torig.txt\n'
    const result = await gitRevert(
      '/repo',
      [file('moved.txt', 'R.')],
      false,
      fakeRun(seen, [{ stdout: porcelain, code: 0 }]),
    )
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['-c', 'core.quotePath=false', 'status', '--porcelain=2'], // origin scan (only when an R row is selected)
      ['reset', '-q', '--', 'moved.txt'],
      ['-c', 'core.quotePath=false', 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'orig.txt'],
      ['-c', 'core.quotePath=false', 'clean', '-f', '-q', '--', 'moved.txt'],
    ])
  })

  it('a MIXED selection buckets correctly and only runs the commands it needs', async () => {
    const seen: string[][] = []
    const result = await gitRevert(
      '/repo',
      [file('mod.txt', '.M'), file('gone.txt', '.D'), file('new.txt', '?', true)],
      false,
      fakeRun(seen),
    )
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['-c', 'core.quotePath=false', 'restore', '--source=HEAD', '--staged', '--worktree', '--', 'mod.txt', 'gone.txt'],
      ['-c', 'core.quotePath=false', 'clean', '-f', '-q', '--', 'new.txt'],
    ])
  })

  it('a failing restore surfaces git’s reason and stops before the clean', async () => {
    const result = await gitRevert(
      '/repo',
      [file('mod.txt', '.M'), file('new.txt', '?', true)],
      false,
      fakeRun([], [{ stderr: 'error: pathspec did not match', code: 1 }]),
    )
    expect(result).toEqual({ ok: false, error: 'error: pathspec did not match' })
  })

  it('an empty selection with all=false is a no-op {ok:true} — nothing runs', async () => {
    const seen: string[][] = []
    expect(await gitRevert('/repo', [], false, fakeRun(seen))).toEqual({ ok: true })
    expect(seen).toEqual([])
  })

  it('never throws — a rejecting runner degrades to {ok:false}', async () => {
    const result = await gitRevert('/repo', [file('a.txt')], false, () => Promise.reject(new Error('boom')))
    expect(result).toEqual({ ok: false, error: 'boom' })
  })
})
