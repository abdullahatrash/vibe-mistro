/**
 * Git domain of the shared IPC contract (#84-#87, ADR-0008): the streamed status
 * subscription + push, single-file diff read, commit, and branch list / checkout /
 * create. Keep this file free of Node/DOM imports so both sides can consume it.
 */

/** The git channel entries, merged into the single `IPC` const in `./index`. */
export const gitChannels = {
  /**
   * Renderer -> main: subscribe to the active Workspace's STREAMED git status
   * (#84, ADR-0008). Ref-counted per `workspaceDir` in main — the first subscribe
   * starts one fs watcher + one background fetch and emits a `snapshot`; later
   * subscribes only bump the count (and re-emit the current snapshot). Returns void;
   * status arrives on the `gitStatus` push channel. Active-Workspace-only by
   * construction: only the mounted Changes panel subscribes (ADR-0008).
   */
  gitSubscribeStatus: 'git:subscribe-status',
  /**
   * Renderer -> main: drop one subscriber's hold on a Workspace's status stream
   * (#84). The last unsubscribe tears down the watcher + fetch timer; an over-count
   * unsubscribe is a no-op. Paired with `gitSubscribeStatus` on panel mount/unmount.
   */
  gitUnsubscribeStatus: 'git:unsubscribe-status',
  /** Main -> renderer: a streamed git-status update for a subscribed Workspace (#84) — see {@link GitStatusEvent}. */
  gitStatus: 'git:status',
  /** Renderer -> main: read the FULL working-tree diff — one entry per changed path (#235) — see {@link GitFullDiffArgs}. */
  gitFullDiff: 'git:full-diff',
  /** Renderer -> main: COMMIT working-tree changes from the Changes panel (#86) — see {@link GitCommitArgs}. */
  gitCommit: 'git:commit',
  /** Renderer -> main: list the active Workspace's branches (#87) — see {@link GitBranchesArgs}. */
  gitBranches: 'git:branches',
  /** Renderer -> main: CHECK OUT a branch on the active Workspace (#87) — see {@link GitBranchOpArgs}. */
  gitCheckout: 'git:checkout',
  /** Renderer -> main: CREATE + switch to a new branch on the active Workspace (#87) — see {@link GitBranchOpArgs}. */
  gitCreateBranch: 'git:create-branch',
  /** Renderer -> main: run a STACKED git action (push/pull, #234) — see {@link GitStackedActionArgs}. */
  gitRunStackedAction: 'git:run-stacked-action',
  /** Main -> renderer: streamed progress for a running stacked action (#234) — see {@link GitActionProgressEvent}. */
  gitActionProgress: 'git:action-progress',
} as const

/**
 * One changed path in a Workspace's working tree (#84, ADR-0008). `status` is the
 * raw `git status --porcelain=2` XY code (e.g. `.M`, `A.`, `RM`, `MM`) or `?` for an
 * untracked path — the renderer maps it to a display glyph. `insertions`/`deletions`
 * are the merged `git diff` + `git diff --cached` numstat for the path (0 for a
 * binary `-`/`-` entry). `staged` is true when the index half (X) is non-clean; a
 * path can be both staged and worktree-dirty (e.g. `MM`) — `staged` then still true.
 */
export interface GitFile {
  path: string
  status: string
  insertions: number
  deletions: number
  staged: boolean
  untracked: boolean
}

/**
 * A Workspace working tree's git status (#84, ADR-0008) — the observational v1
 * payload. `isRepo:false` (with the empty defaults) covers a non-repo Workspace OR
 * any git failure swallowed into the stream (never a throw): the renderer then shows
 * no Changes panel ("a Workspace need not be a git repo", CONTEXT.md). `ahead`/
 * `behind` are 0 with no upstream; `branch`/`upstream` are null when detached / unset.
 */
export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  files: GitFile[]
}

/** Which trigger produced a `gitStatus` push (#84). */
export type GitStatusKind = 'snapshot' | 'localUpdated' | 'remoteUpdated'

/**
 * Main -> renderer streamed git-status update (#84). Tagged by `workspaceDir` so a
 * renderer with one mounted Changes panel ignores events for other Workspaces (the
 * push fans out to every window, like `thread:status`). `kind` distinguishes the
 * trigger — `snapshot` (on subscribe), `localUpdated` (fs watcher / turn-end / manual
 * refresh), `remoteUpdated` (background fetch refreshed ahead/behind). The renderer
 * filters by `workspaceDir` and holds the latest status.
 */
export interface GitStatusEvent {
  workspaceDir: string
  kind: GitStatusKind
  status: GitStatus
}

/** Args for `gitSubscribeStatus` / `gitUnsubscribeStatus` (#84). */
export interface GitStatusSubscriptionArgs {
  workspaceDir: string
}

/**
 * One path's RAW working-tree unified diff (#85, now per-entry inside {@link
 * GitFullDiffResult} — #235 retired the single-file `git:diff` channel when the
 * all-files view replaced the one-file viewer). `diffHash` (sha256 of `patch`) keys
 * the renderer's per-file memo, so an unchanged file skips a re-parse / re-render.
 * `truncated` is true when the patch was capped (~120 KB) — the viewer flags it on
 * that file's section. The empty result (`patch:''`, `diffHash:''`, `truncated:false`)
 * covers BOTH a clean path (no diff) and a swallowed git failure; the renderer renders
 * a quiet "no changes" for it (degrade quietly, like #84's non-repo panel).
 */
export interface GitDiffResult {
  patch: string
  diffHash: string
  truncated: boolean
}

/**
 * Args for `gitFullDiff` (#235, PRD #233): read the FULL working-tree diff — every
 * changed path as its own entry — for the all-files diff view. `files` is the
 * renderer's CURRENT status snapshot (`GitFile.path` + `untracked`), the same source
 * as the panel's rows, so sections and rows always line up. `ignoreWhitespace`
 * re-reads every entry with `-w` (@pierre can't ignore whitespace on a pre-parsed
 * patch, so the toggle drives a fresh read). Read-only; not agent activity, so it
 * does NOT touch the warm-agent pool.
 */
export interface GitFullDiffArgs {
  workspaceDir: string
  files: { path: string; untracked: boolean }[]
  ignoreWhitespace?: boolean
}

/** One file's entry in the full diff (#235): the per-path payload plus its path. */
export interface GitFileDiff extends GitDiffResult {
  path: string
}

/**
 * The `gitFullDiff` reply (#235). Entries preserve the caller's order; each is
 * INDIVIDUALLY capped + hashed, so one oversized generated file truncates itself —
 * flagged on ITS section — without hiding its siblings.
 */
export interface GitFullDiffResult {
  files: GitFileDiff[]
}

/**
 * Args for `gitCommit` (#86, ADR-0008 — the first git WRITE): commit working-tree
 * changes. `message` is the commit message (the panel disables Commit on an
 * empty/whitespace one). `paths` is the commit-time selection of `GitFile.path`s — a
 * NON-empty subset stages exactly those (a mixed `reset` + `add -- <paths>`), an EMPTY
 * array commits ALL changes (`add -A`). On success main re-reads status
 * (`gitStatus.refresh`) so the committed files drop off the panel — a `.git`-only
 * change the fs watcher won't see, like #84's turn-end refresh. NOT agent activity, so
 * it does NOT touch the warm-agent pool (like `git:diff`).
 */
export interface GitCommitArgs {
  workspaceDir: string
  message: string
  paths: string[]
}

/**
 * The `gitCommit` reply (#86). `{ok:true}` on a clean commit (main then refreshes the
 * Changes panel so the committed files drop off). `{ok:false, error}` carries git's
 * ACTUAL reason — "nothing to commit", a failed pre-commit hook, an index lock — not a
 * collapsed "commit failed" (#78 style). The renderer shows `error` inline + recoverable.
 */
export type GitCommitResult = { ok: true } | { ok: false; error: string }

/**
 * One branch in a Workspace's repo (#87). `name` is the local branch name (e.g. `main`,
 * `feat/x`) or, for a remote-only branch, the `<remote>/<branch>` name (e.g.
 * `origin/feature`). `isRemote` distinguishes the two; `current` marks the checked-out
 * branch; `isDefault` marks the repo's default branch (best-effort from origin/HEAD,
 * false everywhere when unresolved). The list shows local branches + only the remotes
 * with NO matching local (deduped), so a tracked branch appears once.
 */
export interface GitBranch {
  name: string
  isRemote: boolean
  current: boolean
  isDefault: boolean
}

/**
 * The `gitBranches` reply (#87). `{ok:true, branches}` on a successful list (local +
 * remote-only, deduped). `{ok:false, error}` carries git's actual reason (e.g. not a
 * git repository) — never a collapsed message. The dropdown surfaces the error inline.
 */
export type GitBranchesResult = { ok: true; branches: GitBranch[] } | { ok: false; error: string }

/**
 * The reply shape for a branch WRITE — `gitCheckout` / `gitCreateBranch` (#87).
 * `{ok:true}` on a clean switch/create (main then refreshes status so the panel header
 * shows the new branch). `{ok:false, error}` carries git's ACTUAL reason — a dirty-tree
 * checkout refusal (NO data loss; git protects), a name collision — surfaced inline +
 * recoverable.
 */
export type GitOpResult = { ok: true } | { ok: false; error: string }

/**
 * Args for `gitBranches` (#87): list one Workspace's branches. Read-only, so — like
 * `git:diff` — it does NOT touch the warm-agent pool. The dropdown fetches on open.
 */
export interface GitBranchesArgs {
  workspaceDir: string
}

/**
 * Which stacked git action to run (#234, PRD #233). Slice 1 ships the two single-phase
 * actions — `push` / `pull`; the commit-composing chains (`commit_push`,
 * `commit_push_pr`) arrive with the quick-action slice (#236) on the same engine.
 */
export type GitStackedActionKind = 'push' | 'pull'

/** One phase of a stacked action (#234). Single-phase in slice 1; `commit`/`create_pr` join in #236. */
export type GitActionPhase = 'push' | 'pull'

/**
 * Args for `gitRunStackedAction` (#234). `actionId` is CALLER-minted (the renderer
 * generates it before invoking) so the caller can correlate `gitActionProgress` pushes
 * with its own invocation — the invoke itself resolves with the final
 * {@link GitStackedActionResult}; the stream is advisory UI.
 */
export interface GitStackedActionArgs {
  workspaceDir: string
  actionId: string
  action: GitStackedActionKind
}

/**
 * Main -> renderer streamed progress for a running stacked action (#234), tagged by
 * `workspaceDir` + `actionId` (fans out to every window like `gitStatus`; the renderer
 * filters). Ordered per action: `actionStarted`, then per phase `phaseStarted` /
 * optional `output` (a finished command's non-empty stdout/stderr — hook output lives
 * here) / `phaseFinished`, closed by exactly one of `actionFinished` | `actionFailed`.
 * A failed phase STOPS the chain — later phases never start (#236 relies on this).
 */
export type GitActionProgressEvent = { workspaceDir: string; actionId: string } & (
  | { kind: 'actionStarted'; action: GitStackedActionKind }
  | { kind: 'phaseStarted'; phase: GitActionPhase }
  | { kind: 'output'; phase: GitActionPhase; text: string }
  | { kind: 'phaseFinished'; phase: GitActionPhase }
  | { kind: 'actionFinished' }
  | { kind: 'actionFailed'; phase: GitActionPhase; error: string }
)

/**
 * The `gitRunStackedAction` reply (#234). `{ok:false}` names the phase that failed and
 * carries git's ACTUAL reason (a rejected push, a non-fast-forward pull, a failed hook)
 * — never a collapsed message (#86 style). Surfaced inline + recoverable.
 */
export type GitStackedActionResult = { ok: true } | { ok: false; phase: GitActionPhase; error: string }

/**
 * Args for `gitCheckout` / `gitCreateBranch` (#87). For a CHECKOUT `name` is the branch's
 * full name and `track` says whether it's a remote-only branch: `track:true` →
 * `git switch --track <remote>/<branch>` (an unambiguous tracking-local create), else
 * `git switch <name>` (a local name, which may contain `/`, switches verbatim). For a
 * CREATE, `name` is the NEW branch name (`git switch -c <name>` from the current HEAD;
 * no base ref in v1, `track` unused). On success main re-reads status so the header
 * shows the new branch.
 */
export interface GitBranchOpArgs {
  workspaceDir: string
  name: string
  track?: boolean
}
