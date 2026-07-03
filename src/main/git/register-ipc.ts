import { ipcMain } from 'electron'
import {
  IPC,
  type GitBranchesArgs,
  type GitBranchesResult,
  type GitBranchOpArgs,
  type GitCommitArgs,
  type GitCommitResult,
  type GitFullDiffArgs,
  type GitFullDiffResult,
  type GitOpResult,
  type GhCreatePrArgs,
  type GhCreateResult,
  type GhCurrentPrArgs,
  type GhPrResult,
  type GitActionProgressEvent,
  type GitStackedActionArgs,
  type GitStackedActionResult,
  type GitStatusSubscriptionArgs,
} from '../../shared/ipc'
import { readGitFullDiff } from './diff'
import { gitCommit } from './commit'
import { runStackedAction } from './stacked-action'
import { gitBranches, gitCheckout, gitCreateBranch } from './branches'
import { ghCreatePr, ghCurrentPr } from './github'
import type { GitStatusManager } from './status-stream'

/**
 * The git/gh IPC handlers (#84-#88, ADR-0008), registered next to the modules they
 * pass through to. All of these run against the renderer-supplied Workspace dir (where
 * #84's status ran, so path keys match) and NONE are agent activity — no `pool.touch`,
 * so a git read/write never keeps a warm agent alive past its idle window (TB5 #50).
 * Every operation swallows its failure into a typed result (never throws).
 */
export function registerGitIpc(deps: {
  gitStatus: GitStatusManager
  /** Broadcast one stacked-action progress event to every window (#234) — wired to `webContents.send` in `index.ts`, like `gitStatus.emit`. */
  emitGitActionProgress: (event: GitActionProgressEvent) => void
}): void {
  /**
   * Settle a mutating git/gh op: on success optionally re-read the Workspace's streamed
   * status (a commit/switch touches only `.git/`, which the working-tree fs watcher
   * ignores — exactly like #84's turn-end refresh); on failure log the op's reason.
   */
  function settle<T extends { ok: boolean } & { error?: string }>(
    result: T,
    errLabel: string,
    refreshDir?: string,
  ): T {
    if (result.ok) {
      if (refreshDir) deps.gitStatus.refresh(refreshDir)
    } else {
      console.error(`${errLabel}: ${result.error}`)
    }
    return result
  }

  ipcMain.handle(IPC.gitSubscribeStatus, (_event, args: GitStatusSubscriptionArgs) => {
    // Subscribe the active Workspace's Changes panel to its streamed git status (#84).
    // Ref-counted in the manager: the first subscribe starts the watcher + fetch and
    // emits a snapshot, later ones just bump the count + re-emit the snapshot.
    deps.gitStatus.subscribe(args.workspaceDir)
  })

  ipcMain.handle(IPC.gitUnsubscribeStatus, (_event, args: GitStatusSubscriptionArgs) => {
    // Panel unmount / Workspace switch-away (#84): the last unsubscribe tears the
    // watcher + fetch timer down (active-Workspace-only streaming, ADR-0008).
    deps.gitStatus.unsubscribe(args.workspaceDir)
  })

  ipcMain.handle(IPC.gitFullDiff, (_event, args: GitFullDiffArgs): Promise<GitFullDiffResult> => {
    // Read the FULL working-tree diff — one entry per changed path — for the all-files
    // view (#235). Per-file failure swallows into that file's empty entry inside
    // `readGitFullDiff` (#85 style); the invoke itself never rejects.
    return readGitFullDiff(args.workspaceDir, args.files, args.ignoreWhitespace ?? false)
  })

  ipcMain.handle(IPC.gitCommit, async (_event, args: GitCommitArgs): Promise<GitCommitResult> => {
    // Commit working-tree changes from the Changes panel (#86, the first git WRITE).
    // On success re-read status so the committed files drop off the panel.
    return settle(
      await gitCommit(args.workspaceDir, args.message, args.paths),
      `[vibe-mistro:git] commit failed (${args.workspaceDir})`,
      args.workspaceDir,
    )
  })

  ipcMain.handle(IPC.gitBranches, (_event, args: GitBranchesArgs): Promise<GitBranchesResult> => {
    // List the active Workspace's branches for the header dropdown (#87). Read-only.
    return gitBranches(args.workspaceDir)
  })

  ipcMain.handle(IPC.gitCheckout, async (_event, args: GitBranchOpArgs): Promise<GitOpResult> => {
    // Check out a branch (#87). A switch changes `.git/HEAD` + the working tree, so on
    // success re-read status to update the panel header (branch / ahead-behind) + file list.
    return settle(
      await gitCheckout(args.workspaceDir, args.name, args.track ?? false),
      `[vibe-mistro:git] checkout failed (${args.workspaceDir} -> ${args.name})`,
      args.workspaceDir,
    )
  })

  ipcMain.handle(IPC.gitCreateBranch, async (_event, args: GitBranchOpArgs): Promise<GitOpResult> => {
    // Create + switch to a new branch (#87). A successful create moves HEAD, so re-read status.
    return settle(
      await gitCreateBranch(args.workspaceDir, args.name),
      `[vibe-mistro:git] create-branch failed (${args.workspaceDir} -> ${args.name})`,
      args.workspaceDir,
    )
  })

  ipcMain.handle(
    IPC.gitRunStackedAction,
    async (_event, args: GitStackedActionArgs): Promise<GitStackedActionResult> => {
      // Run a stacked git action — slice 1: push / pull (#234). Progress streams over
      // `gitActionProgress` while this invoke is in flight; the resolve is the final
      // word. On success re-read status: a push moves ahead/behind + upstream, a pull
      // rewrites the working tree — both are `.git`-side moves the watcher may miss.
      const result = await runStackedAction(args, deps.emitGitActionProgress)
      if (result.ok) {
        deps.gitStatus.refresh(args.workspaceDir)
      } else {
        console.error(`[vibe-mistro:git] ${args.action} failed (${args.workspaceDir}): ${result.error}`)
      }
      return result
    },
  )

  ipcMain.handle(IPC.ghCurrentPr, (_event, args: GhCurrentPrArgs): Promise<GhPrResult> => {
    // Read the current branch's GitHub PR via `gh` (#88). A NETWORK call, but read-only.
    return ghCurrentPr(args.workspaceDir)
  })

  ipcMain.handle(IPC.ghCreatePr, async (_event, args: GhCreatePrArgs): Promise<GhCreateResult> => {
    // Create a PR for the current branch via `gh pr create` (#88). No status refresh needed —
    // a PR creation doesn't change the working tree (the renderer swaps in the chip from the URL).
    return settle(
      await ghCreatePr(args.workspaceDir, { title: args.title, body: args.body }),
      `[vibe-mistro:gh] create-pr failed (${args.workspaceDir})`,
    )
  })
}
