import { defaultGitRun, errorMessage, failReason, type GitRun } from './run'
import { collectRenameOrigins } from './commit'
import type { GitOpResult } from '../../shared/ipc'

/**
 * REVERT working-tree changes (#250) — the app's one deliberately DESTRUCTIVE git
 * write. Like every git module, it runs in main through the injectable `GitRun` seam
 * and swallows failure into a typed result (never throws). The renderer's warning
 * dialog is the consent gate; this module's job is to destroy EXACTLY the selection:
 *
 *  - ALL (`all: true`): `git reset --hard -q` (tracked: staged + worktree back to
 *    HEAD) then `git clean -fd -q` (untracked files AND directories deleted).
 *  - SELECTION: bucketed by the porcelain status the panel already holds —
 *      · untracked (`?`)            → `clean -f -q --` (DELETED — nothing to restore)
 *      · index-only add (X === 'A') → `reset -q --` (unstage) then `clean` — a
 *        `restore --source=HEAD` would FAIL on a path HEAD doesn't have
 *      · staged rename (X === 'R')  → unstage the NEW name, `restore` the ORIGIN
 *        (via the same rename-origin scan as #86's commit), `clean` the new name
 *      · everything else            → `restore --source=HEAD --staged --worktree --`
 *    Steps run in that dependency order; the first failure stops the chain with
 *    git's actual reason (#86 style). Paths are argv elements — spaces are safe.
 */
export async function gitRevert(
  cwd: string,
  files: { path: string; status: string; untracked: boolean }[],
  all: boolean,
  run: GitRun = defaultGitRun,
): Promise<GitOpResult> {
  try {
    if (all) {
      const reset = await run(['reset', '--hard', '-q'], cwd)
      if (reset.code !== 0) return { ok: false, error: failReason(reset) }
      const clean = await run(['clean', '-fd', '-q'], cwd)
      if (clean.code !== 0) return { ok: false, error: failReason(clean) }
      return { ok: true }
    }
    if (files.length === 0) return { ok: true }

    const untracked = files.filter((f) => f.untracked).map((f) => f.path)
    const added = files.filter((f) => !f.untracked && f.status[0] === 'A').map((f) => f.path)
    const renamed = files.filter((f) => !f.untracked && f.status[0] === 'R').map((f) => f.path)
    const restorable = files
      .filter((f) => !f.untracked && f.status[0] !== 'A' && f.status[0] !== 'R')
      .map((f) => f.path)

    // A selected rename reverts as: origin restored, new name deleted. Scan for the
    // origins BEFORE any reset decomposes the rename (same trick as gitCommit).
    const renameOrigins = renamed.length > 0 ? await collectRenameOrigins(cwd, renamed, run) : []

    // 1. Unstage what HEAD doesn't have (adds + rename new-names) so clean can take it.
    const toUnstage = [...added, ...renamed]
    if (toUnstage.length > 0) {
      const reset = await run(['reset', '-q', '--', ...toUnstage], cwd)
      if (reset.code !== 0) return { ok: false, error: failReason(reset) }
    }

    // 2. Restore tracked-in-HEAD paths (both halves) — including rename origins.
    const toRestore = [...restorable, ...renameOrigins]
    if (toRestore.length > 0) {
      const restore = await run(
        ['-c', 'core.quotePath=false', 'restore', '--source=HEAD', '--staged', '--worktree', '--', ...toRestore],
        cwd,
      )
      if (restore.code !== 0) return { ok: false, error: failReason(restore) }
    }

    // 3. Delete what only exists in the working tree (untracked + now-unstaged paths).
    const toClean = [...untracked, ...added, ...renamed]
    if (toClean.length > 0) {
      const clean = await run(['-c', 'core.quotePath=false', 'clean', '-f', '-q', '--', ...toClean], cwd)
      if (clean.code !== 0) return { ok: false, error: failReason(clean) }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}
