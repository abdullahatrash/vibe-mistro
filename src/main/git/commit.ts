import { defaultGitRun, type GitRun } from './status'
import type { GitCommitResult } from '../../shared/ipc'

/**
 * Commit working-tree changes from the Changes panel (#86, ADR-0008) — the FIRST git
 * WRITE. Like #84's status read and #85's diff read, git runs in MAIN via
 * `child_process` through the injectable `GitRun` seam (reused from `status.ts`) — no
 * git2 / isomorphic-git. There is NO stage/unstage/discard UI: selection is decided at
 * COMMIT time (like t3code's `prepareCommitContext`), so this stages exactly the
 * caller's selection, then commits.
 *
 * Staging semantics (be precise — a wrong `add`/`reset` commits the wrong files):
 *  - SUBSET (`paths.length > 0`): `git reset -q` first — a MIXED reset that unstages
 *    everything but KEEPS the working tree — then `git add -- <paths…>`. Net effect:
 *    ONLY the selected paths are staged, so a file the user previously staged out of
 *    band but did NOT select is excluded from this commit.
 *  - ALL (`paths` empty): `git add -A` — stage every change (modifications, untracked
 *    adds, and deletions).
 * Then `git -c core.quotePath=false commit -m <message>`. `core.quotePath=false` keeps
 * us consistent with #84's status read (its paths are unquoted UTF-8). Each path is its
 * own argv element (no shell), so a path with spaces is safe.
 *
 * Failure is SWALLOWED into the result — this NEVER throws (mirroring #84/#85 and the
 * #78 auth-error style): a non-zero `reset`/`add`/`commit` returns `{ok:false, error}`
 * carrying git's ACTUAL reason ("nothing to commit", a failed pre-commit hook, an
 * index lock) rather than a collapsed "commit failed". `GitRun` resolves even on a
 * non-zero exit, so we gate on `.code` after every step.
 */
export async function gitCommit(
  cwd: string,
  message: string,
  paths: string[],
  run: GitRun = defaultGitRun,
): Promise<GitCommitResult> {
  try {
    if (paths.length > 0) {
      // Mixed reset (keeps the working tree) so the index starts from HEAD, then stage
      // exactly the selection — any other previously-staged path drops out of the index.
      const reset = await run(['reset', '-q'], cwd)
      if (reset.code !== 0) return fail(reset)
      // `add -- <paths>` stages modifications, untracked adds, AND deletions of the
      // selected tracked paths (git ≥2.0 default), so a deleted selected file commits too.
      const add = await run(['add', '--', ...paths], cwd)
      if (add.code !== 0) return fail(add)
    } else {
      // Commit-all: stage everything (incl. untracked + deletions).
      const add = await run(['add', '-A'], cwd)
      if (add.code !== 0) return fail(add)
    }
    const commit = await run(['-c', 'core.quotePath=false', 'commit', '-m', message], cwd)
    if (commit.code !== 0) return fail(commit)
    return { ok: true }
  } catch (err) {
    // A truly unexpected throw (a runner that rejects) still degrades to a result.
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Map a non-zero git step to the failure result, surfacing the real reason. git writes
 * hook / lock failures to STDERR and "nothing to commit" to STDOUT, so prefer stderr
 * and fall back to stdout — never collapse to a generic message (#78 style).
 */
function fail(res: { stdout: string; stderr?: string; code: number }): GitCommitResult {
  const reason = (res.stderr ?? '').trim() || res.stdout.trim() || 'git command failed'
  return { ok: false, error: reason }
}
