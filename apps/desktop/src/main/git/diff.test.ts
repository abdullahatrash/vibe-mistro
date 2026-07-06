import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  capByBytes,
  hashDiff,
  runDiffJobs,
  readGitFullDiff,
  readGitRangeDiff,
  MAX_PATCH_BYTES,
  type DiffJob,
  type DiffReadLimits,
} from './diff'
import type { GitStreamResult, GitStreamRun } from './run'

/**
 * #390 seams (batched/streamed/budget-capped diff reads, PRD #387). The pure `capByBytes`
 * (byte cap) and `hashDiff` (sha256 + flag) are trivially testable; `runDiffJobs` (the
 * bounded, budget-aware pool) and the two public readers are driven by a fake
 * `GitStreamRun` so no test shells real git. The fake HONORS `capBytes` — cutting its
 * canned output at the cap and flagging `truncated` — exactly as the real streaming reader
 * does when it stops consuming past the cap, so a "huge stream" is simulated by handing the
 * fake more bytes than the cap.
 */

const trackedPatch = `diff --git a/tracked.txt b/tracked.txt
index c0d0fb4..ed51eca 100644
--- a/tracked.txt
+++ b/tracked.txt
@@ -1,2 +1,3 @@
 line1
-line2
+CHANGED
+line3
`

const untrackedPatch = `diff --git a/untracked.txt b/untracked.txt
new file mode 100644
index 0000000..d82766f
--- /dev/null
+++ b/untracked.txt
@@ -0,0 +1,2 @@
+new file
+content
`

/** Cut a canned response at `cap` bytes + flag `truncated`, modelling the streaming reader. */
function capStream(r: { stdout?: string; stderr?: string; code: number }, cap: number): GitStreamResult {
  const stdout = r.stdout ?? ''
  const bytes = Buffer.from(stdout, 'utf8')
  if (Number.isFinite(cap) && bytes.byteLength > cap) {
    return { stdout: bytes.subarray(0, cap).toString('utf8'), stderr: r.stderr ?? '', code: r.code, truncated: true }
  }
  return { stdout, stderr: r.stderr ?? '', code: r.code, truncated: false }
}

/** A streaming fake keyed by the diffed path (last arg), honoring `capBytes`; records args. */
function streamByPath(byPath: Record<string, { stdout: string; code: number }>, seen?: string[][]): GitStreamRun {
  return (args, _cwd, cap) => {
    seen?.push(args)
    const path = args[args.length - 1]
    return Promise.resolve(capStream(byPath[path] ?? { stdout: '', code: 0 }, cap))
  }
}

describe('capByBytes', () => {
  it('leaves a small patch untouched, not truncated', () => {
    expect(capByBytes(trackedPatch, MAX_PATCH_BYTES)).toEqual({ text: trackedPatch, truncated: false })
  })

  it('empty input → empty, not truncated', () => {
    expect(capByBytes('', 10)).toEqual({ text: '', truncated: false })
  })

  it('caps at the byte limit and flags truncated', () => {
    const huge = 'x'.repeat(MAX_PATCH_BYTES + 5000)
    const res = capByBytes(huge, MAX_PATCH_BYTES)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.text, 'utf8')).toBe(MAX_PATCH_BYTES)
  })

  it('caps BY BYTES, not chars (a multibyte file cannot smuggle past the cap)', () => {
    // '€' is 3 bytes in UTF-8; 120 KB is divisible by 3 so the boundary is clean.
    const huge = '€'.repeat(MAX_PATCH_BYTES)
    const res = capByBytes(huge, MAX_PATCH_BYTES)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(MAX_PATCH_BYTES)
  })
})

describe('hashDiff', () => {
  it('sha256-hashes the FINAL patch (what the renderer receives)', () => {
    const res = hashDiff(trackedPatch, false)
    expect(res.patch).toBe(trackedPatch)
    expect(res.truncated).toBe(false)
    expect(res.diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
  })

  it('is stable and distinguishes different patches', () => {
    expect(hashDiff(trackedPatch, false).diffHash).toBe(hashDiff(trackedPatch, false).diffHash)
    expect(hashDiff(trackedPatch, false).diffHash).not.toBe(hashDiff(untrackedPatch, false).diffHash)
  })

  it('empty patch → empty result shape, carrying the caller’s truncated flag', () => {
    expect(hashDiff('', false)).toEqual({ patch: '', diffHash: '', truncated: false })
    // A budget-skipped file is empty-with-truncated (there WAS a diff; we omitted it).
    expect(hashDiff('', true)).toEqual({ patch: '', diffHash: '', truncated: true })
  })
})

describe('runDiffJobs', () => {
  const big = { perFileCap: 1_000, budget: 1_000_000, poolSize: 6 }
  function jobsFor(paths: string[], successCodes = [0]): DiffJob[] {
    return paths.map((p) => ({ path: p, args: ['diff', '--', p], successCodes }))
  }

  it('preserves the caller’s order and hashes each entry individually', async () => {
    const res = await runDiffJobs(
      '/repo',
      jobsFor(['a.txt', 'b.txt']),
      streamByPath({ 'a.txt': { stdout: trackedPatch, code: 0 }, 'b.txt': { stdout: untrackedPatch, code: 0 } }),
      big,
    )
    expect(res.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt'])
    expect(res.files[0].patch).toBe(trackedPatch)
    expect(res.files[0].diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
    expect(res.truncated).toBe(false)
  })

  it('never exceeds the pool size concurrently', async () => {
    let active = 0
    let max = 0
    const run: GitStreamRun = async () => {
      active++
      max = Math.max(max, active)
      await new Promise((r) => setTimeout(r, 0))
      active--
      return { stdout: 'x', stderr: '', code: 0, truncated: false }
    }
    const res = await runDiffJobs('/repo', jobsFor(Array.from({ length: 20 }, (_, i) => `f${i}`)), run, {
      ...big,
      poolSize: 3,
    })
    expect(max).toBeLessThanOrEqual(3)
    expect(res.files).toHaveLength(20)
  })

  it('accepts the given success codes — a --no-index exit 1 is a diff, not a failure', async () => {
    const res = await runDiffJobs(
      '/repo',
      jobsFor(['n.txt'], [0, 1]),
      streamByPath({ 'n.txt': { stdout: untrackedPatch, code: 1 } }),
      big,
    )
    expect(res.files[0].patch).toBe(untrackedPatch)
  })

  it('a non-success exit code degrades to that file’s empty entry, siblings unaffected', async () => {
    const res = await runDiffJobs(
      '/repo',
      jobsFor(['bad.txt', 'ok.txt']),
      streamByPath({ 'bad.txt': { stdout: 'fatal: bad', code: 128 }, 'ok.txt': { stdout: trackedPatch, code: 0 } }),
      big,
    )
    expect(res.files[0]).toEqual({ path: 'bad.txt', patch: '', diffHash: '', truncated: false })
    expect(res.files[1].patch).toBe(trackedPatch)
  })

  it('PER-FILE cap: an oversized single file truncates ITSELF (streamed stop), not the aggregate', async () => {
    // perFileCap 10 << budget, so the huge file hits its OWN cap while the small sibling
    // (3 bytes) sails under it — the per-file cap is independent of the aggregate budget.
    const huge = 'x'.repeat(50)
    const res = await runDiffJobs('/repo', jobsFor(['huge.txt', 'small.txt']), streamByPath({
      'huge.txt': { stdout: huge, code: 0 },
      'small.txt': { stdout: 'abc', code: 0 },
    }), { perFileCap: 10, budget: 1_000_000, poolSize: 6 })
    expect(res.files[0].truncated).toBe(true)
    expect(Buffer.byteLength(res.files[0].patch, 'utf8')).toBe(10)
    expect(res.files[1].patch).toBe('abc')
    expect(res.files[1].truncated).toBe(false)
    // A per-file cap hit is NOT aggregate truncation.
    expect(res.truncated).toBe(false)
  })

  it('AGGREGATE budget: once spent, LATER files come back empty-with-truncated + the result flags it', async () => {
    // perFileCap 5, budget 10: two 5-byte files fit exactly, the third is omitted whole.
    const res = await runDiffJobs(
      '/repo',
      jobsFor(['a', 'b', 'c']),
      streamByPath({ a: { stdout: 'xxxxx', code: 0 }, b: { stdout: 'yyyyy', code: 0 }, c: { stdout: 'zzzzz', code: 0 } }),
      { perFileCap: 5, budget: 10, poolSize: 6 },
    )
    expect(res.files[0].patch).toBe('xxxxx')
    expect(res.files[1].patch).toBe('yyyyy')
    // Third file omitted: empty patch, flagged truncated — payload not bloated.
    expect(res.files[2]).toEqual({ path: 'c', patch: '', diffHash: '', truncated: true })
    expect(res.truncated).toBe(true)
  })

  it('AGGREGATE budget forcing a cap BELOW the per-file cap flags both the entry AND the aggregate', async () => {
    // perFileCap 5, budget 8: file a takes 5, leaving 3 — b's stream is cut mid-file at 3.
    const res = await runDiffJobs(
      '/repo',
      jobsFor(['a', 'b']),
      streamByPath({ a: { stdout: 'xxxxx', code: 0 }, b: { stdout: 'yyyyy', code: 0 } }),
      { perFileCap: 5, budget: 8, poolSize: 6 },
    )
    expect(res.files[0].patch).toBe('xxxxx')
    expect(res.files[1].patch).toBe('yyy')
    expect(res.files[1].truncated).toBe(true)
    expect(res.truncated).toBe(true)
  })

  it('the budget stays deterministic under concurrency (reserved before await, in index order)', async () => {
    // Even with a wide pool and randomised completion, workers grab the cursor + reserve
    // budget synchronously, so the SAME prefix of files always fits.
    const run: GitStreamRun = async (_args, _cwd, cap) => {
      await new Promise((r) => setTimeout(r, Math.random() * 3))
      return capStream({ stdout: 'xxxxx', code: 0 }, cap)
    }
    const jobs: DiffJob[] = jobsFor(['a', 'b', 'c', 'd'])
    const res = await runDiffJobs('/repo', jobs, run, { perFileCap: 5, budget: 10, poolSize: 6 })
    expect(res.files[0].patch).toBe('xxxxx')
    expect(res.files[1].patch).toBe('xxxxx')
    expect(res.files[2].patch).toBe('')
    expect(res.files[3].patch).toBe('')
    expect(res.truncated).toBe(true)
  })
})

describe('readGitFullDiff', () => {
  it('reads each file in ORDER — tracked via HEAD, untracked via --no-index — with -w off', async () => {
    const seen: string[][] = []
    const res = await readGitFullDiff(
      '/repo',
      [
        { path: 'tracked.txt', untracked: false },
        { path: 'untracked.txt', untracked: true },
      ],
      false,
      streamByPath(
        { 'tracked.txt': { stdout: trackedPatch, code: 0 }, 'untracked.txt': { stdout: untrackedPatch, code: 1 } },
        seen,
      ),
    )
    expect(res.files.map((f) => f.path)).toEqual(['tracked.txt', 'untracked.txt'])
    expect(res.files[0].patch).toBe(trackedPatch)
    expect(res.files[1].patch).toBe(untrackedPatch)
    expect(res.truncated).toBe(false)
    const tracked = seen.find((a) => a.at(-1) === 'tracked.txt')!
    expect(tracked).toContain('HEAD')
    expect(tracked).not.toContain('--no-index')
    expect(tracked).not.toContain('-w')
    expect(tracked.slice(0, 2)).toEqual(['-c', 'core.quotePath=false'])
    const untracked = seen.find((a) => a.at(-1) === 'untracked.txt')!
    expect(untracked).toContain('--no-index')
    expect(untracked.slice(-3)).toEqual(['--', '/dev/null', 'untracked.txt'])
  })

  it('passes ignoreWhitespace (-w) through to every per-file read', async () => {
    const seen: string[][] = []
    await readGitFullDiff(
      '/repo',
      [
        { path: 'a.txt', untracked: false },
        { path: 'b.txt', untracked: true },
      ],
      true,
      streamByPath({}, seen),
    )
    for (const args of seen) expect(args).toContain('-w')
  })

  it('surfaces AGGREGATE truncation on the result when the budget is hit', async () => {
    const tiny: DiffReadLimits = { perFileCap: 5, budget: 5, poolSize: 6 }
    const res = await readGitFullDiff(
      '/repo',
      [
        { path: 'a.txt', untracked: false },
        { path: 'b.txt', untracked: false },
      ],
      false,
      streamByPath({ 'a.txt': { stdout: 'xxxxx', code: 0 }, 'b.txt': { stdout: 'yyyyy', code: 0 } }),
      tiny,
    )
    expect(res.truncated).toBe(true)
    expect(res.files[0].patch).toBe('xxxxx')
    expect(res.files[1].patch).toBe('')
    expect(res.files[1].truncated).toBe(true)
  })

  it('never throws — a rejecting runner degrades each file to its empty entry', async () => {
    const res = await readGitFullDiff('/repo', [{ path: 'a.txt', untracked: false }], false, () =>
      Promise.reject(new Error('spawn failed')),
    )
    expect(res.files[0]).toEqual({ path: 'a.txt', patch: '', diffHash: '', truncated: false })
    expect(res.truncated).toBe(false)
  })
})

describe('readGitRangeDiff', () => {
  /** A range fake: symbolic-ref + --name-only answered by shape, per-file keyed by path. */
  function rangeStream(
    opts: { originHead?: { stdout: string; code: number }; names?: { stdout: string; code: number }; byPath?: Record<string, { stdout: string; code: number }> },
    seen?: string[][],
  ): GitStreamRun {
    return (args, _cwd, cap) => {
      seen?.push(args)
      if (args.includes('symbolic-ref')) return Promise.resolve(capStream(opts.originHead ?? { stdout: '', code: 0 }, cap))
      if (args.includes('--name-only')) return Promise.resolve(capStream(opts.names ?? { stdout: '', code: 0 }, cap))
      const path = args[args.length - 1]
      return Promise.resolve(capStream(opts.byPath?.[path] ?? { stdout: '', code: 0 }, cap))
    }
  }

  it('explicit base: enumerates `base...HEAD` names then reads each file (three-dot range form)', async () => {
    const seen: string[][] = []
    const res = await readGitRangeDiff(
      '/repo',
      'main',
      false,
      rangeStream(
        {
          names: { stdout: 'a.txt\0dir/b.txt\0', code: 0 },
          byPath: { 'a.txt': { stdout: trackedPatch, code: 0 }, 'dir/b.txt': { stdout: untrackedPatch, code: 0 } },
        },
        seen,
      ),
    )
    expect(res).toMatchObject({ ok: true, baseRef: 'main', truncated: false })
    if (!res.ok) throw new Error('unreachable')
    expect(res.files.map((f) => f.path)).toEqual(['a.txt', 'dir/b.txt'])
    expect(res.files[0].patch).toBe(trackedPatch)
    expect(res.files[0].diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
    expect(seen[0]).toContain('main...HEAD')
    expect(seen[0]).toContain('--name-only')
    const fileRead = seen.find((a) => a.at(-1) === 'a.txt')!
    expect(fileRead.slice(-3)).toEqual(['main...HEAD', '--', 'a.txt'])
  })

  it('AUTOMATIC base (undefined): resolves origin/HEAD first and diffs against it', async () => {
    const seen: string[][] = []
    const res = await readGitRangeDiff(
      '/repo',
      undefined,
      false,
      rangeStream(
        {
          originHead: { stdout: 'origin/main\n', code: 0 },
          names: { stdout: 'a.txt\0', code: 0 },
          byPath: { 'a.txt': { stdout: trackedPatch, code: 0 } },
        },
        seen,
      ),
    )
    expect(res).toMatchObject({ ok: true, baseRef: 'origin/main' })
    expect(seen[0]).toEqual(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    expect(seen[1]).toContain('origin/main...HEAD')
  })

  it('AUTOMATIC base with NO resolvable default → {ok:false} with an actionable reason', async () => {
    const res = await readGitRangeDiff('/repo', undefined, false, rangeStream({ originHead: { stdout: '', code: 1 } }))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toContain('default branch')
  })

  it('an UNKNOWN base surfaces git’s reason as {ok:false}', async () => {
    const run: GitStreamRun = (_args, _cwd, cap) =>
      Promise.resolve(capStream({ stderr: "fatal: bad revision 'nope...HEAD'", code: 128 }, cap))
    const res = await readGitRangeDiff('/repo', 'nope', false, run)
    expect(res).toEqual({ ok: false, error: "fatal: bad revision 'nope...HEAD'" })
  })

  it('empty range (no names) → ok with zero files, not truncated; -w passes through', async () => {
    const seen: string[][] = []
    const res = await readGitRangeDiff('/repo', 'main', true, rangeStream({ names: { stdout: '', code: 0 } }, seen))
    expect(res).toEqual({ ok: true, baseRef: 'main', files: [], truncated: false })
    expect(seen[0]).toContain('-w')
  })

  it('surfaces AGGREGATE truncation on {ok:true} when the budget is hit', async () => {
    const res = await readGitRangeDiff(
      '/repo',
      'main',
      false,
      rangeStream({
        names: { stdout: 'a\0b\0', code: 0 },
        byPath: { a: { stdout: 'xxxxx', code: 0 }, b: { stdout: 'yyyyy', code: 0 } },
      }),
      { perFileCap: 5, budget: 5, poolSize: 6 },
    )
    expect(res).toMatchObject({ ok: true, truncated: true })
    if (!res.ok) throw new Error('unreachable')
    expect(res.files[0].patch).toBe('xxxxx')
    expect(res.files[1].patch).toBe('')
  })

  it('never throws — a rejecting runner degrades to {ok:false}', async () => {
    const res = await readGitRangeDiff('/repo', 'main', false, () => Promise.reject(new Error('boom')))
    expect(res).toEqual({ ok: false, error: 'boom' })
  })
})
