import { createHash } from 'node:crypto'
import { defaultGitRun, errorMessage, failReason, type GitRun } from './run'
import type { GitDiffResult, GitFullDiffResult, GitRangeDiffResult } from '../../shared/ipc'

/**
 * Read a single changed path's WORKING-TREE unified diff (#85, ADR-0008). Like #84's
 * status read, git runs in MAIN via `child_process` through the injectable `GitRun`
 * seam (reused from `status.ts`) — no git2 / isomorphic-git. The renderer parses +
 * renders the raw patch with `@pierre/diffs`; this side only produces the raw text.
 *
 * The data contract is deliberately thin: main returns the RAW unified-diff text plus
 * a content `diffHash` (so the renderer can memoize an unchanged file and skip a
 * re-parse), and a `truncated` flag when the patch is capped. Working-tree source
 * only (no branch-range). Read-only. Any git failure is swallowed into the empty
 * result — it NEVER throws, mirroring `readGitStatus`.
 */

/**
 * Cap on the raw patch size handed to the renderer (~120 KB). A huge diff (a vendored
 * lockfile, a generated bundle) would otherwise bloat the IPC payload and stall the
 * worker render; past the cap we hand back a `truncated` prefix the viewer flags.
 */
const MAX_PATCH_BYTES = 120 * 1024

/**
 * PURE seam: turn a raw `git diff` stdout into the renderer payload. Caps the patch at
 * `MAX_PATCH_BYTES` (BY BYTES, so a multibyte UTF-8 file can't smuggle past the cap),
 * flags `truncated`, and hashes the FINAL (post-cap) patch with sha256 — the hash keys
 * the renderer's memo, so it must reflect exactly the text the renderer receives. An
 * empty input yields the empty result (`patch:''`, `diffHash:''`) — also the
 * swallow-all-errors fallback shape, so a no-diff and a failed-diff read look alike.
 */
export function finalizeDiff(raw: string): GitDiffResult {
  if (!raw) return { patch: '', diffHash: '', truncated: false }
  const bytes = Buffer.from(raw, 'utf8')
  const truncated = bytes.byteLength > MAX_PATCH_BYTES
  const patch = truncated ? bytes.subarray(0, MAX_PATCH_BYTES).toString('utf8') : raw
  const diffHash = createHash('sha256').update(patch).digest('hex')
  return { patch, diffHash, truncated }
}

/**
 * Impure read (#85): run `git diff` for one path in `cwd` and finalize it. Two shapes:
 *  - TRACKED: `git -c core.quotePath=false diff --no-color [-w] -- <path>` (exit 0 OK).
 *  - UNTRACKED: `git ... diff --no-color [-w] --no-index -- /dev/null <path>`. `--no-index`
 *    exits **1 when there IS a diff** (verified against real git) — so 0 AND 1 are both
 *    success (capture stdout); only a LARGER code (a real error) degrades to empty.
 * `core.quotePath=false` so non-ASCII paths come back as plain UTF-8 (matching #84's
 * status read). `ignoreWhitespace` adds `-w` (`--ignore-all-space`) — @pierre can't
 * ignore whitespace on a pre-parsed patch, so the toggle re-reads the diff here.
 * All git failure is swallowed into the empty result — this NEVER throws.
 */
export async function readGitDiff(
  cwd: string,
  path: string,
  untracked: boolean,
  ignoreWhitespace = false,
  run: GitRun = defaultGitRun,
): Promise<GitDiffResult> {
  try {
    const ws = ignoreWhitespace ? ['-w'] : []
    if (untracked) {
      const res = await run(
        ['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, '--no-index', '--', '/dev/null', path],
        cwd,
      )
      // `--no-index`: 0 = no diff, 1 = diff present, >1 = a real failure.
      if (res.code !== 0 && res.code !== 1) return finalizeDiff('')
      return finalizeDiff(res.stdout)
    }
    // `HEAD` (not the bare worktree-vs-index `git diff`) so a fully-STAGED file still
    // shows its diff: the Changes panel lists a file's churn as staged+unstaged (vs
    // HEAD), so the viewer must match — a bare `git diff` is empty for an `M.`/`A.`
    // file and would dead-click. (A zero-commit repo has no HEAD → empty; rare edge.)
    const res = await run(['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, 'HEAD', '--', path], cwd)
    if (res.code !== 0) return finalizeDiff('')
    return finalizeDiff(res.stdout)
  } catch {
    return finalizeDiff('')
  }
}

/**
 * Read the FULL working-tree diff — every changed path as its own entry (#235, PRD
 * #233). One `readGitDiff` per file (run concurrently), so each entry is individually
 * capped + hashed: a huge generated file truncates ITSELF (surfaced per section in the
 * all-files view) without hiding its siblings, and the renderer memoizes per file on
 * `diffHash`. The caller (the Review Surface) supplies the file list from its CURRENT
 * status snapshot — same source as the panel's rows, so entries and rows always line
 * up. Order is preserved. A failed per-file read degrades to that file's empty entry
 * (never throws), matching `readGitDiff`'s swallow-to-empty contract.
 */
export async function readGitFullDiff(
  cwd: string,
  files: { path: string; untracked: boolean }[],
  ignoreWhitespace = false,
  run: GitRun = defaultGitRun,
): Promise<GitFullDiffResult> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const diff = await readGitDiff(cwd, file.path, file.untracked, ignoreWhitespace, run)
      return { path: file.path, ...diff }
    }),
  )
  return { files: entries }
}

/**
 * Read a BRANCH-RANGE diff — `<base>...HEAD`, what this branch adds relative to where
 * it forked (#237, PRD #233). `baseRef` undefined means AUTOMATIC: resolve the
 * repository's default branch from `origin/HEAD` (same source as #87's default-branch
 * flag). Shape mirrors `readGitFullDiff`: enumerate the range's paths, then one
 * per-file read (concurrent), each entry individually capped + hashed. Unlike the
 * working-tree reads, a bad RANGE is a meaningful, user-actionable state — an unknown
 * base or an unresolvable default returns `{ok:false, error}` (git's actual reason)
 * instead of degrading to an empty diff the renderer can't explain. A failed PER-FILE
 * read still degrades to that file's empty entry. Never throws.
 */
export async function readGitRangeDiff(
  cwd: string,
  baseRef: string | undefined,
  ignoreWhitespace = false,
  run: GitRun = defaultGitRun,
): Promise<GitRangeDiffResult> {
  try {
    const ws = ignoreWhitespace ? ['-w'] : []
    let base = baseRef
    if (base === undefined) {
      // Automatic: the default branch via origin/HEAD (kept fresh by #84's fetch loop).
      const head = await run(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], cwd)
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
    )
    if (names.code !== 0) return { ok: false, error: failReason(names) }
    const paths = names.stdout.split('\0').filter(Boolean)
    const files = await Promise.all(
      paths.map(async (path) => {
        const res = await run(['-c', 'core.quotePath=false', 'diff', '--no-color', ...ws, range, '--', path], cwd)
        return { path, ...finalizeDiff(res.code === 0 ? res.stdout : '') }
      }),
    )
    return { ok: true, baseRef: base, files }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}
