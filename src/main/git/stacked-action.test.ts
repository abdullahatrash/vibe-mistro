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

describe('runStackedAction: composed chains (#236)', () => {
  /** A createPr seam fake recording its input. */
  function fakeCreatePr(
    result: { ok: true; url: string } | { ok: false; error: string },
    seen?: { cwd: string; title: string; body: string }[],
  ) {
    return (cwd: string, fields: { title: string; body: string }) => {
      seen?.push({ cwd, ...fields })
      return Promise.resolve(result)
    }
  }

  it('commit_push: commits the selection (via the #86 staging sequence) then pushes, phases in order', async () => {
    const seen: string[][] = []
    const { events, emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a3', action: 'commit_push', commitMessage: 'msg', paths: ['a.txt'] },
      emit,
      fakeRun(seen, [
        { code: 0 }, // status (rename scan)
        { code: 0 }, // reset -q
        { code: 0 }, // add -- a.txt
        { code: 0 }, // commit -m msg
        { stdout: 'origin/main\n', code: 0 }, // upstream exists
        { code: 0 }, // push
      ]),
    )
    expect(result).toEqual({ ok: true })
    expect(seen.map((a) => a[0] === '-c' ? a[2] : a[0])).toEqual([
      'status',
      'reset',
      'add',
      'commit',
      'rev-parse',
      'push',
    ])
    expect(events.map((e) => e.kind)).toEqual([
      'actionStarted',
      'phaseStarted', // commit
      'phaseFinished',
      'phaseStarted', // push
      'phaseFinished',
      'actionFinished',
    ])
  })

  it('commit_push_pr: adds the create_pr phase — PR title from the message, prUrl in the result', async () => {
    const prSeen: { cwd: string; title: string; body: string }[] = []
    const { events, emit } = collect()
    const result = await runStackedAction(
      {
        workspaceDir: '/repo',
        actionId: 'a3',
        action: 'commit_push_pr',
        commitMessage: 'Add feature\n\nlong body here',
        paths: [],
      },
      emit,
      fakeRun([], [
        { code: 0 }, // add -A
        { code: 0 }, // commit
        { stdout: 'origin/feat\n', code: 0 }, // upstream
        { code: 0 }, // push
      ]),
      fakeCreatePr({ ok: true, url: 'https://github.com/o/r/pull/9' }, prSeen),
    )
    expect(result).toEqual({ ok: true, prUrl: 'https://github.com/o/r/pull/9' })
    // Title = FIRST LINE of the commit message; body empty (gh accepts it).
    expect(prSeen).toEqual([{ cwd: '/repo', title: 'Add feature', body: '' }])
    expect(events.filter((e) => e.kind === 'phaseStarted').map((e) => e.kind === 'phaseStarted' && e.phase)).toEqual([
      'commit',
      'push',
      'create_pr',
    ])
  })

  it('a REJECTED push stops the chain: commit already done, create_pr NEVER runs, failed phase named', async () => {
    const prSeen: { cwd: string; title: string; body: string }[] = []
    const { events, emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a3', action: 'commit_push_pr', commitMessage: 'msg', paths: [] },
      emit,
      fakeRun([], [
        { code: 0 }, // add -A
        { code: 0 }, // commit
        { stdout: 'origin/main\n', code: 0 }, // upstream
        { stderr: '! [rejected] non-fast-forward', code: 1 }, // push fails
      ]),
      fakeCreatePr({ ok: true, url: 'unused' }, prSeen),
    )
    expect(result).toEqual({ ok: false, phase: 'push', error: '! [rejected] non-fast-forward' })
    expect(prSeen).toEqual([]) // chain stopped — no PR attempted
    // The commit phase COMPLETED before the failure (its finish is on the stream).
    expect(events.some((e) => e.kind === 'phaseFinished' && e.phase === 'commit')).toBe(true)
    expect(events.at(-1)).toMatchObject({ kind: 'actionFailed', phase: 'push' })
  })

  it('a FAILED commit stops the chain before any push', async () => {
    const seen: string[][] = []
    const { emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a3', action: 'commit_push', commitMessage: 'msg', paths: [] },
      emit,
      fakeRun(seen, [
        { code: 0 }, // add -A
        { stdout: 'nothing to commit, working tree clean', code: 1 }, // commit fails
      ]),
    )
    expect(result).toEqual({ ok: false, phase: 'commit', error: 'nothing to commit, working tree clean' })
    expect(seen.some((a) => a[0] === 'push')).toBe(false)
  })

  it('a FAILED create_pr names its phase — commit+push already landed', async () => {
    const { emit } = collect()
    const result = await runStackedAction(
      { workspaceDir: '/repo', actionId: 'a3', action: 'commit_push_pr', commitMessage: 'msg', paths: [] },
      emit,
      fakeRun([], [
        { code: 0 },
        { code: 0 },
        { stdout: 'origin/main\n', code: 0 },
        { code: 0 },
      ]),
      fakeCreatePr({ ok: false, error: 'gh: Not authenticated' }),
    )
    expect(result).toEqual({ ok: false, phase: 'create_pr', error: 'gh: Not authenticated' })
  })
})
