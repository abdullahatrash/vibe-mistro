import type { FilesListResult, GitStatusKind } from '../../shared/ipc'

/**
 * Per-Workspace cache of the file listing (#188, ADR-0013 decision 4). The listing is an
 * expensive full gitignore-honoring walk, so main serves the cached result until it is
 * invalidated — by the panel's explicit Refresh (the handler bypasses the cache with
 * `refresh:true`) or by the existing git status-stream watcher firing (NO new fs
 * watcher). Keyed by the `workspaceDir` the handler receives — the same key the git
 * handlers and the status manager use.
 */
export class FilesListCache {
  private readonly byDir = new Map<string, FilesListResult>()

  get(workspaceDir: string): FilesListResult | undefined {
    return this.byDir.get(workspaceDir)
  }

  set(workspaceDir: string, result: FilesListResult): void {
    this.byDir.set(workspaceDir, result)
  }

  invalidate(workspaceDir: string): void {
    this.byDir.delete(workspaceDir)
  }

  clear(): void {
    this.byDir.clear()
  }
}

/**
 * Whether a git-status push of `kind` should invalidate the files cache (#188). Only a
 * `localUpdated` push reflects a WORKING-TREE change (the fs watcher fire, a turn-end
 * refresh, or a commit); a `snapshot` (emitted on every subscribe) or a `remoteUpdated`
 * (a background fetch) does not change local files, so the cache stays valid. Pure, so
 * the invalidation decision is unit-tested without the manager or electron.
 */
export function shouldInvalidateFilesCacheOnGitStatus(kind: GitStatusKind): boolean {
  return kind === 'localUpdated'
}
