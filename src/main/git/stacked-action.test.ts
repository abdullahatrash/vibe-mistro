import { describe, it, expect } from 'vitest'
import { runStackedAction } from './stacked-action'
import type { GitRun } from './run'
import type { GitActionProgressEvent } from '../../shared/ipc'

/**
 * `runStackedAction` is the stacked git-action engine (#234, PRD #233): an ordered
 * chain of phases over the injected `GitRun` seam, streaming tagged progress events
 * through `emit` and resolving with a typed result. Like `gitCommit`'s tests, the
 * testable seam is the COMMAND SEQUENCE + the EVENT ORDER — no test shells real git.
 */

/** A fake runner: records every `args` and returns a per-call canned `{stdout,stderr,code}`. */
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

/** Collect emitted progress events for order assertions. */
function collect(): { events: GitActionProgressEvent[]; emit: (e: GitActionProgressEvent) => void } {
  const events: GitActionProgressEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

describe('runStackedAction: push', () => {
  it('with an existing upstream: checks @{upstream} then plain `git push`, {ok:true}, ordered events', async () => {
    const seen: string[][] = []
    const { events, emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a1', action: 'push' },
      emit,
      fakeRun(seen, [
        { stdout: 'origin/main\n', code: 0 }, // upstream exists
        { code: 0 }, // push
      ]),
    )
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      ['push'],
    ])
    expect(events.map((e) => e.kind)).toEqual([
      'actionStarted',
      'phaseStarted',
      'phaseFinished',
      'actionFinished',
    ])
    // Every event is tagged for renderer-side filtering.
    for (const e of events) {
      expect(e.workspaceDir).toBe('/repo')
      expect(e.actionId).toBe('a1')
    }
  })

  it('with NO upstream: sets it on the primary remote — `push -u origin <branch>`', async () => {
    const seen: string[][] = []
    const { emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a1', action: 'push' },
      emit,
      fakeRun(seen, [
        { stderr: 'fatal: no upstream configured for branch', code: 128 }, // no upstream
        { stdout: 'feat/x\n', code: 0 }, // current branch
        { stdout: 'origin\n', code: 0 }, // remotes
        { code: 0 }, // push -u
      ]),
    )
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      ['symbolic-ref', '--short', 'HEAD'],
      ['remote'],
      ['push', '-u', 'origin', 'feat/x'],
    ])
  })

  it('detached HEAD (no upstream, symbolic-ref fails): fails the push phase with git’s reason, never pushes', async () => {
    const seen: string[][] = []
    const { events, emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a1', action: 'push' },
      emit,
      fakeRun(seen, [
        { stderr: 'fatal: no upstream', code: 128 },
        { stderr: 'fatal: ref HEAD is not a symbolic ref', code: 128 }, // detached
      ]),
    )
    expect(result).toEqual({ ok: false, phase: 'push', error: 'fatal: ref HEAD is not a symbolic ref' })
    expect(seen.some((args) => args[0] === 'push')).toBe(false)
    expect(events.at(-1)).toMatchObject({ kind: 'actionFailed', phase: 'push' })
  })

  it('no configured remote (no upstream): fails the push phase with an actionable reason, never pushes', async () => {
    const seen: string[][] = []
    const { emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a1', action: 'push' },
      emit,
      fakeRun(seen, [
        { stderr: 'fatal: no upstream', code: 128 },
        { stdout: 'feat/x\n', code: 0 },
        { stdout: '', code: 0 }, // `git remote` lists nothing
      ]),
    )
    expect(result).toEqual({ ok: false, phase: 'push', error: 'No remote configured — add one with `git remote add`.' })
    expect(seen.some((args) => args[0] === 'push')).toBe(false)
  })

  it('a REJECTED push surfaces git’s stderr reason and closes with actionFailed (no actionFinished)', async () => {
    const { events, emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a1', action: 'push' },
      emit,
      fakeRun([], [
        { stdout: 'origin/main\n', code: 0 },
        { stderr: '! [rejected] main -> main (non-fast-forward)', code: 1 },
      ]),
    )
    expect(result).toEqual({ ok: false, phase: 'push', error: '! [rejected] main -> main (non-fast-forward)' })
    expect(events.map((e) => e.kind)).toEqual(['actionStarted', 'phaseStarted', 'actionFailed'])
  })
})

describe('runStackedAction: pull', () => {
  it('runs `git pull --ff-only` and resolves {ok:true} with ordered events', async () => {
    const seen: string[][] = []
    const { events, emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a2', action: 'pull' },
      emit,
      fakeRun(seen, [{ stdout: 'Updating 1234abc..5678def\nFast-forward\n', code: 0 }]),
    )
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([['pull', '--ff-only']])
    expect(events.map((e) => e.kind)).toEqual([
      'actionStarted',
      'phaseStarted',
      'output',
      'phaseFinished',
      'actionFinished',
    ])
  })

  it('a DIVERGED branch (non-fast-forward) fails the pull phase with git’s reason — no merge attempted', async () => {
    const seen: string[][] = []
    const { emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a2', action: 'pull' },
      emit,
      fakeRun(seen, [{ stderr: 'fatal: Not possible to fast-forward, aborting.', code: 128 }]),
    )
    expect(result).toEqual({ ok: false, phase: 'pull', error: 'fatal: Not possible to fast-forward, aborting.' })
    expect(seen).toEqual([['pull', '--ff-only']])
  })

  it('a runner that REJECTS still degrades to {ok:false} + actionFailed (never throws)', async () => {
    const { events, emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a2', action: 'pull' },
      emit,
      () => Promise.reject(new Error('spawn EACCES')),
    )
    expect(result).toEqual({ ok: false, phase: 'pull', error: 'spawn EACCES' })
    expect(events.at(-1)).toMatchObject({ kind: 'actionFailed', error: 'spawn EACCES' })
  })
})
