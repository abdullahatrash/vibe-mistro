import { realpath, stat } from 'node:fs/promises'
import { resolveWorkspacePath } from '../resolve-workspace-path'
import { isWithinDir } from '../open-target'

/**
 * The ONE read-side Workspace confinement for agent-authored/untrusted paths (#116
 * `shell:reveal-path`, #189 `files:read` — ADR-0013). Both handlers must make the
 * identical decision — "is this an existing regular file that really lives inside the
 * Workspace?" — so the sequence lives here once instead of two hand-maintained copies:
 *   1. Resolve the (possibly relative / `~`) input against the Workspace cwd
 *      (`resolveWorkspacePath`); an absolute input resolves too — step 4 rejects it if
 *      it lands outside.
 *   2. `realpath` the Workspace root (collapsing a symlinked root so it isn't falsely
 *      rejected).
 *   3. `stat` the target and require a regular FILE (blocks dirs / sockets; a missing
 *      target throws — see below).
 *   4. `realpath` the target (collapsing any symlink) and require
 *      `isWithinDir(realRoot, realTarget)` — an in-tree symlink pointing out, a `..`
 *      escape, or an absolute out-of-tree path is refused.
 *
 * Filesystem failures (missing path, unreadable root) THROW — each caller already has
 * a best-effort catch with its own log tag, and the refusal cases that matter for the
 * security posture are typed results, not throws. The caller decides what to log; on
 * an `outside-workspace` refusal the offending realpath is returned so the caller can
 * log it main-side (it must never reach the renderer).
 */

/** Injectable fs boundary (Seam) — `files/read-file.ts`'s richer seam satisfies it structurally. */
export interface ConfineFs {
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isFile(): boolean; size: number }>
}

const nodeFs: ConfineFs = { realpath: (p) => realpath(p), stat: (p) => stat(p) }

export type ConfineResult =
  | { ok: true; realTarget: string; size: number }
  | { ok: false; reason: 'not-a-file' }
  | { ok: false; reason: 'outside-workspace'; realTarget: string }

export async function confineExistingFile(
  workspaceDir: string,
  inputPath: string,
  homeDir: string,
  fs: ConfineFs = nodeFs,
): Promise<ConfineResult> {
  const requested = resolveWorkspacePath(workspaceDir, inputPath, homeDir)
  const [realRoot, stats] = await Promise.all([fs.realpath(workspaceDir), fs.stat(requested)])
  if (!stats.isFile()) return { ok: false, reason: 'not-a-file' }
  const realTarget = await fs.realpath(requested)
  if (!isWithinDir(realRoot, realTarget)) return { ok: false, reason: 'outside-workspace', realTarget }
  return { ok: true, realTarget, size: stats.size }
}
