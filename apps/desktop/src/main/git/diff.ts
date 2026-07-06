import { createHash } from 'node:crypto'
import { defaultGitStreamRun, errorMessage, failReason, type GitStreamRun } from './run'
import type { GitDiffResult, GitFileDiff, GitFullDiffResult, GitRangeDiffResult } from '../../shared/ipc'

/**
 * Read a Workspace's changed-file diffs for the Review surface (#85 → #235/#237 →
 * batched/streamed/budget-capped in #390, PRD #387). git runs in MAIN through the
 * injectable {@link GitStreamRun} seam (ADR-0008) — the renderer parses + renders the
 * raw patch with `@pierre/diffs`; this side only produces the raw text plus a content
 * `diffHash` (so the renderer memoizes an unchanged file and skips a re-parse).
 *
 * #390 bounds the read at scale. The old shape spawned ONE `git diff` per changed path
 * with no concurrency limit (N subprocesses for N files — a fan-out that melts a laptop
 * on a big branch) and buffered each whole output into memory before slicing it. Now:
 *  - a **bounded pool** (`POOL_SIZE`) drives the per-file reads, so process count is
 *    capped regardless of file count (untracked working-tree files still need their own
 *    `--no-index` run, and a range read still fans per-path — the pool bounds both);
 *  - each read STREAMS and stops consuming past its cap (`GitStreamRun`), so an oversized
 *    file costs the cap, not its full size;
 *  - two caps compound — a per-file cap (`MAX_PATCH_BYTES`) and a new AGGREGATE budget
 *    (`AGGREGATE_BUDGET_BYTES`): once the budget is spent, later files come back
 *    empty-with-`truncated` rather than bloating the IPC payload.
 * Both per-file and aggregate truncation surface as flags (per-file on the entry, the
 * aggregate on the result) so the Review surface can render an honest banner.
 */

/**
 * Per-file cap on the raw patch handed to the renderer (~120 KB). A huge single file (a
 * vendored lockfile, a generated bundle) truncates ITSELF — flagged on its own entry —
 * without hiding its siblings.
 */
export const MAX_PATCH_BYTES = 120 * 1024

/**
 * Aggregate payload budget across ALL files of one scope (~10 MB, #390). Past this, later
 * files' patches arrive empty-with-`truncated` instead of ballooning the IPC message —
 * the Review surface shows a whole-diff "truncated" banner. Compounds with the per-file
 * cap: a scope of many ~120 KB files hits the budget after ~80-odd of them.
 */
export const AGGREGATE_BUDGET_BYTES = 10 * 1024 * 1024

/** Bound on concurrent `git diff` subprocesses (#390) — the whole point: hundreds → a handful. */
export const POOL_SIZE = 6

/** The tuning knobs of {@link runDiffJobs}, injectable so tests can exercise tiny budgets/pools. */
export interface DiffReadLimits {
  perFileCap: number
  budget: number
  poolSize: number
}

/** Production limits (#390): the shipped per-file cap, aggregate budget, and pool bound. */
export const DEFAULT_DIFF_READ_LIMITS: DiffReadLimits = {
  perFileCap: MAX_PATCH_BYTES,
  budget: AGGREGATE_BUDGET_BYTES,
  poolSize: POOL_SIZE,
}

/**
 * PURE seam: cap a raw diff string at `cap` BYTES (so a multibyte UTF-8 file can't smuggle
 * past a char-length cap) and report whether it was cut. The default streaming reader caps
 * the SAME way while reading; this mirror lets tests and the buffered path agree on the
 * exact boundary.
 */
export function capByBytes(raw: string, cap: number): { text: string; truncated: boolean } {
  if (!raw) return { text: '', truncated: false }
  const bytes = Buffer.from(raw, 'utf8')
  if (bytes.byteLength <= cap) return { text: raw, truncated: false }
  return { text: bytes.subarray(0, cap).toString('utf8'), truncated: true }
}

/**
 * PURE seam: turn a (already-capped) patch into the renderer payload — sha256-hash the
 * FINAL text (the hash keys the renderer's memo, so it must reflect EXACTLY what the
 * renderer receives) and carry the `truncated` flag. Empty text yields the empty result
 * shape (`patch:''`, `diffHash:''`) — shared by a clean path, a swallowed git failure, AND
 * a budget-skipped file (which passes `truncated:true` to say "there WAS a diff, omitted").
 */
export function hashDiff(patch: string, truncated: boolean): GitDiffResult {
  if (!patch) return { patch: '', diffHash: '', truncated }
  const diffHash = createHash('sha256').update(patch).digest('hex')
  return { patch, diffHash, truncated }
}

/**
 * One per-file read job (#390): the exact git args, the path it belongs to (entries are
 * keyed by the caller's path, not re-parsed from the diff), and which exit codes count as
 * success. Tracked/range reads succeed on `0`; an untracked `--no-index` read exits `1`
 * when there IS a diff (verified against real git), so `0` AND `1` are both success.
 */
export interface DiffJob {
  path: string
  args: string[]
  successCodes: number[]
}

/**
 * Run per-file diff jobs through a bounded, budget-aware pool (#390). Up to `poolSize`
 * jobs stream concurrently; each is capped at `perFileCap`, and a shared `reserved`
 * counter enforces the aggregate `budget`. Jobs are pulled in caller order (the cursor is
 * grabbed + the budget reserved synchronously before any await), so budget accounting is
 * DETERMINISTIC in index order regardless of completion order: earlier files get the
 * budget, later ones — once it's spent — come back empty-with-`truncated`. Entries keep
 * the caller's order. A per-file read failure degrades to that file's empty entry; this
 * never throws.
 */
export async function runDiffJobs(
  cwd: string,
  jobs: DiffJob[],
  run: GitStreamRun,
  limits: DiffReadLimits = DEFAULT_DIFF_READ_LIMITS,
): Promise<{ files: GitFileDiff[]; truncated: boolean }> {
  const results = new Array<GitFileDiff>(jobs.length)
  let reserved = 0
  let aggregateTruncated = false
  let cursor = 0

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++
      if (i >= jobs.length) return
      const job = jobs[i]
      const remaining = limits.budget - reserved
      if (remaining <= 0) {
        // Budget already spent by earlier files — omit this one, but flag it so the
        // renderer knows a real diff was dropped (empty-with-truncated, not empty-clean).
        results[i] = { path: job.path, ...hashDiff('', true) }
        aggregateTruncated = true
        continue
      }
      // Reserve pessimistically at the per-file cap BEFORE awaiting, so a concurrent
      // worker can't over-spend the budget; reconcile to the actual bytes afterwards.
      const cap = Math.min(limits.perFileCap, remaining)
      reserved += cap
      let res
      try {
        res = await run(job.args, cwd, cap)
      } catch {
        res = { stdout: '', stderr: '', code: 1, truncated: false }
      }
      const ok = job.successCodes.includes(res.code)
      const text = ok ? res.stdout : ''
      reserved -= cap - Buffer.byteLength(text, 'utf8')
      // A cap forced BELOW the per-file cap by the remaining budget, that actually cut the
      // output, is aggregate truncation (the whole-diff banner); a plain per-file cap hit
      // is just this file's own `truncated` marker.
      if (cap < limits.perFileCap && res.truncated) aggregateTruncated = true
      results[i] = { path: job.path, ...hashDiff(text, ok && res.truncated) }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limits.poolSize, jobs.length) }, worker))
  return { files: results, truncated: aggregateTruncated }
}

/**
 * Build the per-file read job for a WORKING-TREE path (#235 semantics, preserved).
 *  - TRACKED: `git -c core.quotePath=false diff --no-color [-w] HEAD -- <path>` — `HEAD`
 *    (not the bare worktree-vs-index form) so a fully-staged file still shows its diff.
 *  - UNTRACKED: `git ... diff --no-color [-w] --no-index -- /dev/null <path>`, success on 0|1.
 * `core.quotePath=false` keeps non-ASCII paths as plain UTF-8; `-w` (`--ignore-all-space`)
 * is added when whitespace is ignored (@pierre can't ignore whitespace on a parsed patch,
 * so the toggle re-reads here).
 */
function workingTreeJob(path: string, untracked: boolean, ws: string[]): DiffJob {
  if (untracked) {
    return {
      path,
      args: ['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, '--no-index', '--', '/dev/null', path],
      successCodes: [0, 1],
    }
  }
  return {
    path,
    args: ['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, 'HEAD', '--', path],
    successCodes: [0],
  }
}

/**
 * Read the FULL working-tree diff — every changed path as its own entry (#235, batched +
 * bounded + budgeted in #390). The caller (the Review surface) supplies the file list from
 * its CURRENT status snapshot — same source as the panel's rows, so entries and rows line
 * up. Order is preserved; each entry is individually capped + hashed; a failed per-file
 * read degrades to that file's empty entry. `truncated` on the result flags AGGREGATE
 * budget truncation (some later files omitted). Never throws.
 */
export async function readGitFullDiff(
  cwd: string,
  files: { path: string; untracked: boolean }[],
  ignoreWhitespace = false,
  run: GitStreamRun = defaultGitStreamRun,
  limits: DiffReadLimits = DEFAULT_DIFF_READ_LIMITS,
): Promise<GitFullDiffResult> {
  const ws = ignoreWhitespace ? ['-w'] : []
  const jobs = files.map((f) => workingTreeJob(f.path, f.untracked, ws))
  const { files: entries, truncated } = await runDiffJobs(cwd, jobs, run, limits)
  return { files: entries, truncated }
}

/**
 * Read a BRANCH-RANGE diff — `<base>...HEAD`, what this branch adds relative to where it
 * forked (#237, batched + bounded + budgeted in #390). `baseRef` undefined means
 * AUTOMATIC: resolve the default branch from `origin/HEAD`. Enumerate the range's paths
 * (`--name-only -z`, robust to renames + non-ASCII), then read each through the bounded
 * budgeted pool. Unlike the working-tree reads, a bad RANGE is a meaningful, user-actionable
 * state — an unknown base or unresolvable default returns `{ok:false, error}` (git's actual
 * reason). `truncated` flags AGGREGATE budget truncation. A failed per-file read degrades
 * to that file's empty entry. Never throws.
 */
export async function readGitRangeDiff(
  cwd: string,
  baseRef: string | undefined,
  ignoreWhitespace = false,
  run: GitStreamRun = defaultGitStreamRun,
  limits: DiffReadLimits = DEFAULT_DIFF_READ_LIMITS,
): Promise<GitRangeDiffResult> {
  try {
    const ws = ignoreWhitespace ? ['-w'] : []
    let base = baseRef
    if (base === undefined) {
      // Automatic: the default branch via origin/HEAD (kept fresh by #84's fetch loop).
      const head = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd, Infinity)
      if (head.code !== 0 || !head.stdout.trim()) {
        return { ok: false, error: 'Could not resolve the default branch — pick a base ref explicitly.' }
      }
      base = head.stdout.trim()
    }
    const range = `${base}...HEAD`
    // `-z` NUL-separation so non-ASCII / space-y paths round-trip unmangled.
    const names = await run(
      ['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, '-z', '--name-only', range],
      cwd,
      Infinity,
    )
    if (names.code !== 0) return { ok: false, error: failReason(names) }
    const paths = names.stdout.split('\0').filter(Boolean)
    const jobs: DiffJob[] = paths.map((path) => ({
      path,
      args: ['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, range, '--', path],
      successCodes: [0],
    }))
    const { files, truncated } = await runDiffJobs(cwd, jobs, run, limits)
    return { ok: true, baseRef: base, files, truncated }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}
