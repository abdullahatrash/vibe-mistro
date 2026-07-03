import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { finalizeDiff, readGitDiff, readGitFullDiff, readGitRangeDiff } from './diff'
import type { GitRun } from './run'

/**
 * The pure `finalizeDiff` (hash + cap) is the testable seam; `readGitDiff` is the thin
 * impure shell driven by a fake `GitRun` so no test shells real git. The fixtures below
 * are shaped like real `git diff` stdout (a tracked unified diff, an untracked
 * new-file `--no-index` diff). The `--no-index` exit-code-1-is-success behaviour and
 * the swallow-to-empty failure path are the two non-obvious bits worth pinning.
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

describe('finalizeDiff', () => {
  it('hashes the patch with sha256 and reports not-truncated for a small diff', () => {
    const res = finalizeDiff(trackedPatch)
    expect(res.patch).toBe(trackedPatch)
    expect(res.truncated).toBe(false)
    expect(res.diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
  })

  it('is a stable hash: same input → same diffHash', () => {
    expect(finalizeDiff(trackedPatch).diffHash).toBe(finalizeDiff(trackedPatch).diffHash)
  })

  it('different patches hash differently', () => {
    expect(finalizeDiff(trackedPatch).diffHash).not.toBe(finalizeDiff(untrackedPatch).diffHash)
  })

  it('returns the empty result for an empty patch (no diff)', () => {
    expect(finalizeDiff('')).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('caps the patch at the ~120 KB byte limit and flags truncated, hashing the CAPPED text', () => {
    const CAP = 120 * 1024
    const huge = 'x'.repeat(CAP + 5000)
    const res = finalizeDiff(huge)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.patch, 'utf8')).toBe(CAP)
    // The hash is of the CAPPED patch (what the renderer receives), not the full input.
    expect(res.diffHash).toBe(createHash('sha256').update(res.patch).digest('hex'))
    expect(res.diffHash).not.toBe(createHash('sha256').update(huge).digest('hex'))
  })

  it('caps BY BYTES, not chars (a multibyte file cannot smuggle past the cap)', () => {
    const CAP = 120 * 1024
    // '€' is 3 bytes in UTF-8 — a char-length cap would let ~3x the bytes through.
    const huge = '€'.repeat(CAP) // 3 * CAP bytes
    const res = finalizeDiff(huge)
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.patch, 'utf8')).toBeLessThanOrEqual(CAP)
  })
})

describe('readGitDiff', () => {
  /** A fake runner that returns one canned response for any invocation, recording args. */
  function fakeRun(response: { stdout: string; code: number }, seen?: string[][]): GitRun {
    return (args) => {
      seen?.push(args)
      return Promise.resolve(response)
    }
  }

  it('reads a tracked file diff (exit 0) and returns the finalized patch', async () => {
    const seen: string[][] = []
    const res = await readGitDiff('/repo', 'tracked.txt', false, false, fakeRun({ stdout: trackedPatch, code: 0 }, seen))
    expect(res.patch).toBe(trackedPatch)
    expect(res.diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
    // tracked form: `diff --no-color HEAD -- <path>`, no `--no-index`, no `-w`.
    // `HEAD` so a fully-staged file still diffs (vs the bare worktree-vs-index form).
    const args = seen[0]
    expect(args).toContain('--no-color')
    expect(args).toContain('HEAD')
    expect(args).not.toContain('--no-index')
    expect(args).not.toContain('-w')
    expect(args.slice(0, 2)).toEqual(['-c', 'core.quotePath=false'])
    expect(args.slice(-2)).toEqual(['--', 'tracked.txt'])
  })

  it('treats an untracked --no-index diff (exit 1) as SUCCESS, capturing stdout', async () => {
    const seen: string[][] = []
    const res = await readGitDiff('/repo', 'untracked.txt', true, false, fakeRun({ stdout: untrackedPatch, code: 1 }, seen))
    expect(res.patch).toBe(untrackedPatch)
    expect(res.truncated).toBe(false)
    // untracked form: `diff --no-color --no-index -- /dev/null <path>`.
    const args = seen[0]
    expect(args).toContain('--no-index')
    expect(args.slice(-3)).toEqual(['--', '/dev/null', 'untracked.txt'])
  })

  it('treats an untracked --no-index with NO diff (exit 0) as the empty result', async () => {
    const res = await readGitDiff('/repo', 'untracked.txt', true, false, fakeRun({ stdout: '', code: 0 }))
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('swallows a real --no-index failure (exit > 1) into the empty result', async () => {
    const res = await readGitDiff('/repo', 'gone.txt', true, false, fakeRun({ stdout: 'fatal: bad', code: 128 }))
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('swallows a tracked-diff failure (exit != 0) into the empty result', async () => {
    const res = await readGitDiff('/repo', 'tracked.txt', false, false, fakeRun({ stdout: 'fatal: bad', code: 128 }))
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })

  it('adds -w when ignoreWhitespace is set (both tracked and untracked forms)', async () => {
    const seenTracked: string[][] = []
    await readGitDiff('/repo', 'tracked.txt', false, true, fakeRun({ stdout: trackedPatch, code: 0 }, seenTracked))
    expect(seenTracked[0]).toContain('-w')

    const seenUntracked: string[][] = []
    await readGitDiff('/repo', 'untracked.txt', true, true, fakeRun({ stdout: untrackedPatch, code: 1 }, seenUntracked))
    expect(seenUntracked[0]).toContain('-w')
    expect(seenUntracked[0]).toContain('--no-index')
  })

  it('never throws — a runner that rejects degrades to the empty result', async () => {
    const throwingRun: GitRun = () => Promise.reject(new Error('spawn failed'))
    const res = await readGitDiff('/repo', 'tracked.txt', false, false, throwingRun)
    expect(res).toEqual({ patch: '', diffHash: '', truncated: false })
  })
})

describe('readGitFullDiff', () => {
  /** A fake runner keyed by the diffed path (last arg): per-path canned responses. */
  function fakeRunByPath(
    byPath: Record<string, { stdout: string; code: number }>,
    seen?: string[][],
  ): GitRun {
    return (args) => {
      seen?.push(args)
      const path = args[args.length - 1]
      return Promise.resolve(byPath[path] ?? { stdout: '', code: 0 })
    }
  }

  it('reads every file in ORDER — tracked via HEAD, untracked via --no-index — one entry each', async () => {
    const seen: string[][] = []
    const res = await readGitFullDiff(
      '/repo',
      [
        { path: 'tracked.txt', untracked: false },
        { path: 'untracked.txt', untracked: true },
      ],
      false,
      fakeRunByPath(
        { 'tracked.txt': { stdout: trackedPatch, code: 0 }, 'untracked.txt': { stdout: untrackedPatch, code: 1 } },
        seen,
      ),
    )
    expect(res.files.map((f) => f.path)).toEqual(['tracked.txt', 'untracked.txt'])
    expect(res.files[0].patch).toBe(trackedPatch)
    expect(res.files[1].patch).toBe(untrackedPatch)
    // Each entry is individually finalized: its own hash + its own truncation flag.
    expect(res.files[0].diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
    expect(res.files.every((f) => !f.truncated)).toBe(true)
    // One git invocation per file, in the caller's order, in the two established forms.
    expect(seen.find((a) => a.at(-1) === 'tracked.txt')).toContain('HEAD')
    expect(seen.find((a) => a.at(-1) === 'untracked.txt')).toContain('--no-index')
  })

  it('caps and flags truncation PER FILE — one oversized file cannot hide its siblings', async () => {
    const CAP = 120 * 1024
    const huge = 'x'.repeat(CAP + 5000)
    const res = await readGitFullDiff(
      '/repo',
      [
        { path: 'huge.txt', untracked: false },
        { path: 'tracked.txt', untracked: false },
      ],
      false,
      fakeRunByPath({ 'huge.txt': { stdout: huge, code: 0 }, 'tracked.txt': { stdout: trackedPatch, code: 0 } }),
    )
    expect(res.files[0].truncated).toBe(true)
    expect(Buffer.byteLength(res.files[0].patch, 'utf8')).toBe(CAP)
    expect(res.files[1].truncated).toBe(false)
    expect(res.files[1].patch).toBe(trackedPatch)
  })

  it('passes ignoreWhitespace through to every per-file read', async () => {
    const seen: string[][] = []
    await readGitFullDiff(
      '/repo',
      [
        { path: 'a.txt', untracked: false },
        { path: 'b.txt', untracked: true },
      ],
      true,
      fakeRunByPath({}, seen),
    )
    for (const args of seen) expect(args).toContain('-w')
  })

  it('a failed per-file read degrades to that file’s empty entry — siblings unaffected, never throws', async () => {
    const res = await readGitFullDiff(
      '/repo',
      [
        { path: 'bad.txt', untracked: false },
        { path: 'tracked.txt', untracked: false },
      ],
      false,
      fakeRunByPath({ 'bad.txt': { stdout: 'fatal: bad', code: 128 }, 'tracked.txt': { stdout: trackedPatch, code: 0 } }),
    )
    expect(res.files[0]).toEqual({ path: 'bad.txt', patch: '', diffHash: '', truncated: false })
    expect(res.files[1].patch).toBe(trackedPatch)
  })
})

describe('readGitRangeDiff', () => {
  /** A scripted runner: responses consumed in call order, args recorded. */
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

  it('explicit base: enumerates `base...HEAD` names (NUL-separated) then reads each file, per-file cap/hash', async () => {
    const seen: string[][] = []
    const res = await readGitRangeDiff(
      '/repo',
      'main',
      false,
      fakeRun(seen, [
        { stdout: 'a.txt\0dir/b.txt\0', code: 0 }, // name enumeration
        { stdout: trackedPatch, code: 0 }, // a.txt
        { stdout: untrackedPatch, code: 0 }, // dir/b.txt
      ]),
    )
    expect(res).toMatchObject({ ok: true, baseRef: 'main' })
    if (!res.ok) throw new Error('unreachable')
    expect(res.files.map((f) => f.path)).toEqual(['a.txt', 'dir/b.txt'])
    expect(res.files[0].patch).toBe(trackedPatch)
    expect(res.files[0].diffHash).toBe(createHash('sha256').update(trackedPatch).digest('hex'))
    // Enumeration + each per-file read use the three-dot range form.
    expect(seen[0]).toContain('main...HEAD')
    expect(seen[0]).toContain('--name-only')
    expect(seen[1].slice(-3)).toEqual(['main...HEAD', '--', 'a.txt'])
  })

  it('AUTOMATIC base (undefined): resolves origin/HEAD first and diffs against it', async () => {
    const seen: string[][] = []
    const res = await readGitRangeDiff(
      '/repo',
      undefined,
      false,
      fakeRun(seen, [
        { stdout: 'origin/main\n', code: 0 }, // symbolic-ref origin/HEAD
        { stdout: 'a.txt\0', code: 0 },
        { stdout: trackedPatch, code: 0 },
      ]),
    )
    expect(res).toMatchObject({ ok: true, baseRef: 'origin/main' })
    expect(seen[0]).toEqual(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])
    expect(seen[1]).toContain('origin/main...HEAD')
  })

  it('AUTOMATIC base with NO resolvable default → {ok:false} with an actionable reason', async () => {
    const res = await readGitRangeDiff('/repo', undefined, false, fakeRun([], [{ stdout: '', code: 1 }]))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.error).toContain('default branch')
  })

  it('an UNKNOWN base surfaces git’s reason as {ok:false} (the renderer wraps it in friendly copy)', async () => {
    const res = await readGitRangeDiff(
      '/repo',
      'nope',
      false,
      fakeRun([], [{ stderr: "fatal: bad revision 'nope...HEAD'", code: 128 }]),
    )
    expect(res).toEqual({ ok: false, error: "fatal: bad revision 'nope...HEAD'" })
  })

  it('empty range (no names) → ok with zero files; -w passes through everywhere', async () => {
    const seen: string[][] = []
    const res = await readGitRangeDiff('/repo', 'main', true, fakeRun(seen, [{ stdout: '', code: 0 }]))
    expect(res).toEqual({ ok: true, baseRef: 'main', files: [] })
    expect(seen[0]).toContain('-w')
  })

  it('never throws — a rejecting runner degrades to {ok:false}', async () => {
    const res = await readGitRangeDiff('/repo', 'main', false, () => Promise.reject(new Error('boom')))
    expect(res).toEqual({ ok: false, error: 'boom' })
  })
})
