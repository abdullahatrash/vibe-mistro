import { useEffect, useRef, useState, type JSX } from 'react'
import { Boxes, Monitor, PanelRightClose, RefreshCw } from 'lucide-react'
import type { GhPr, GitActionPhase, GitStackedActionKind, GitStatus } from '../../../shared/ipc'
import {
  Badge,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Input,
  Textarea,
} from '../ui'
import { getCommitDraft, setCommitDraft } from './commit-draft-store'
import { readDiffScope, writeDiffScope, type DiffScopeState } from './diff-scope-store'
import { BranchDiffView } from './BranchDiffView'
import { buildChangesView, reconcileUnchecked } from './status-view'
import { autoCommitMessage, isDefaultBranch, suggestBranchName } from './commit-guard'
import { deriveQuickAction, type QuickActionKind } from './quick-action'
import { QuickActions } from './QuickActions'
import { BranchMenu } from './BranchMenu'
import { PrSection } from './PrSection'
import { FileRow } from './FileRow'
import { DiffWorkerProvider } from './DiffWorkerProvider'
import { AllFilesDiffView } from './AllFilesDiffView'

/**
 * The right "Changes" panel for a connected Workspace (#84, ADR-0008). It subscribes to
 * the Workspace's STREAMED git status while it is the ACTIVE one (`isActive`), holds the
 * latest snapshot, and renders the branch header + changed-files list. Clicking a file
 * opens the working-tree diff (#85, reshaped by #235): the panel has two modes —
 *  - LIST: the file list + branch header (the #84 view), filling the SurfacePanel shell.
 *  - DIFF: a WIDER (`flex-1`) ALL-FILES view (`AllFilesDiffView`) — every changed file
 *    as a collapsible section in one scroll, scrolled to the clicked row (the list is
 *    its table of contents) — with a "← Changes" back button. A diff needs width, so
 *    the panel widens rather than cramming a side-by-side into 80px.
 * The status subscription runs in BOTH modes (the effect is render-mode-independent), so
 * the panel keeps streaming while a diff is open — and if the changed set empties
 * (reverted / committed), the panel falls back to the list.
 *
 * Subscription lifecycle (active-Workspace-only, ADR-0008): the effect runs only when
 * active, registering `onGitStatus` (filtered by `workspaceDir`) and calling
 * `gitSubscribeStatus`; its cleanup removes the listener and `gitUnsubscribeStatus`.
 * ConnectedWorkspace stays MOUNTED (hidden) for background Workspaces, so gating on
 * `isActive` — not mere mount — is what bounds streaming to one watcher + one fetch.
 *
 * Degrades to nothing for a non-repo Workspace (`isRepo:false`) or before the first
 * snapshot — "a Workspace need not be a git repo" (CONTEXT.md): no panel, not an error.
 *
 * Visuals (#119, ADR-0010): the panel is on the design-system primitives + the warm,
 * rounded "Environment / Review" aesthetic — Button / Input / Textarea / Badge and the
 * soft `--border-muted` dividers. The git BEHAVIOUR is untouched (ADR-0008): only the
 * chrome changed.
 *
 * Re-homed as the Review Surface (#187, ADR-0013): this is now rendered by `SurfacePanel`
 * only when the Review Surface is expanded. Its former standalone collapse toggle is
 * FOLDED into the Surface model — the header collapse affordance calls `onCollapse`, which
 * returns to the launcher-card stack. The git behaviour above is unchanged.
 */
export function ChangesPanel({
  workspaceDir,
  isActive,
  busy,
  onCollapse,
}: {
  workspaceDir: string
  isActive: boolean
  /**
   * Whether this Workspace has a streaming turn (#86 concurrency guard). The agent can
   * run `git commit` itself as a tool-call mid-turn, so the v1 guard simply DISABLES the
   * commit affordance while a turn is in flight — there is no concurrent user+agent
   * commit (no locks/queues). Status re-reads after the turn (#84 turn-end refresh), so
   * the panel reflects whatever the agent committed before the user can commit again.
   */
  busy: boolean
  /** Collapse the Review Surface back to the card stack (#187) — the header affordance. */
  onCollapse: () => void
}): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  // Commit-time file selection (#86), tracked as the paths the user DESELECTED — default
  // empty = all selected, so a new file is selected by default. `message` is the commit
  // message; `committing` blocks a double-submit; `commitError` surfaces git's reason.
  // Both seed from the module-level draft store: Surface collapse now UNMOUNTS this panel
  // (#187) where the old collapse merely hid it, so without the store a half-typed commit
  // message would be one accidental ⌃⇧G away from vanishing.
  const [unchecked, setUnchecked] = useState<Set<string>>(
    () => new Set(getCommitDraft(workspaceDir)?.unchecked ?? []),
  )
  const [message, setMessage] = useState(() => getCommitDraft(workspaceDir)?.message ?? '')
  const [committing, setCommitting] = useState(false)
  const [commitError, setCommitError] = useState<string | null>(null)
  // Bumped by the header refresh button so the PR section re-fetches `ghCurrentPr` on a
  // manual refresh too (its own effect otherwise only fires on a branch change — a PR is a
  // network call we don't tie to every status tick).
  const [prRefreshKey, setPrRefreshKey] = useState(0)
  // The default-branch guard dialog (#238): open flag, the escape hatch's editable
  // branch name (prefilled from the effective message), its in-flight + error state.
  // `guardPendingKind` (#236) is WHICH commit-family action the guard interposed on —
  // Continue / create-branch resume exactly that action, not always a plain commit.
  const [guardOpen, setGuardOpen] = useState(false)
  const [guardBranchName, setGuardBranchName] = useState('')
  const [guardWorking, setGuardWorking] = useState(false)
  const [guardError, setGuardError] = useState<string | null>(null)
  const [guardPendingKind, setGuardPendingKind] = useState<QuickActionKind>('commit')
  // The current branch's PR, reported up by PrSection (#236) — feeds the quick-action
  // derivation (an OPEN PR flips the dirty-tree primary to "Commit & push").
  const [pr, setPr] = useState<GhPr | null>(null)
  // The diff scope (#237): Working tree (live, the #84 stream) vs Branch changes
  // (`base...HEAD`, on demand). Persisted per Workspace so reopening the panel
  // restores the review context.
  const [diffScope, setDiffScope] = useState<DiffScopeState>(() =>
    readDiffScope(window.localStorage, workspaceDir),
  )
  function updateDiffScope(patch: Partial<DiffScopeState>): void {
    setDiffScope((prev) => {
      const next = { ...prev, ...patch }
      writeDiffScope(window.localStorage, workspaceDir, next)
      return next
    })
  }
  // The in-flight stacked action (#236): its kind, the streamed phase line, its error,
  // and the renderer-minted id the progress events are filtered by.
  const [acting, setActing] = useState<GitStackedActionKind | null>(null)
  const [actionProgress, setActionProgress] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const actionIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isActive) return
    const off = window.api.onGitStatus((event) => {
      if (event.workspaceDir === workspaceDir) setStatus(event.status)
    })
    void window.api.gitSubscribeStatus({ workspaceDir })
    return () => {
      off()
      void window.api.gitUnsubscribeStatus({ workspaceDir })
    }
  }, [workspaceDir, isActive])

  // Reconcile the deselection set on every status snapshot: drop a path that's vanished
  // (committed / reverted), keep new files selected by default. `reconcileUnchecked`
  // returns the same ref when nothing changed, so an unrelated tick is a no-op setState.
  useEffect(() => {
    const paths = status?.isRepo ? status.files.map((f) => f.path) : []
    setUnchecked((prev) => reconcileUnchecked(prev, paths))
  }, [status])

  // Mirror the live draft into the store on every change (#187): a successful commit
  // clears `message`, which empties (deletes) the entry via setCommitDraft's residue rule.
  useEffect(() => {
    setCommitDraft(workspaceDir, { message, unchecked })
  }, [workspaceDir, message, unchecked])

  // One progress subscription for the panel's lifetime (#236): streamed phase events
  // are dropped unless they carry the CURRENT action's id, then mapped to the inline
  // phase line ("Committing…" → "Pushing…" → "Creating PR…").
  useEffect(() => {
    return window.api.onGitActionProgress((event) => {
      if (event.workspaceDir !== workspaceDir || event.actionId !== actionIdRef.current) return
      if (event.kind === 'phaseStarted') setActionProgress(PHASE_LABELS[event.phase])
    })
  }, [workspaceDir])

  // Manual refresh: a subscribe/unsubscribe pair re-emits a fresh snapshot without
  // changing the net ref-count (the panel keeps its own hold across this).
  function refresh(): void {
    void window.api
      .gitSubscribeStatus({ workspaceDir })
      .then(() => window.api.gitUnsubscribeStatus({ workspaceDir }))
    // Also re-check the current branch's PR (a network call the PR section keys on this).
    setPrRefreshKey((k) => k + 1)
  }

  // Before the first snapshot, or for a non-repo Workspace: the git surface degrades to a
  // quiet empty state (#84 "a Workspace need not be a git repo"). As a Surface it still
  // renders its header so the collapse affordance is always reachable (#187) — a Surface
  // must never strand the user with no way back to the card stack.
  if (!status || !status.isRepo) {
    return (
      <aside className="flex min-h-0 flex-1 flex-col text-text">
        <ReviewHeader onCollapse={onCollapse} onRefresh={refresh} />
        <p className="px-3 py-3 text-[13px] text-muted">
          {!status ? 'Loading changes…' : 'Not a Git repository.'}
        </p>
      </aside>
    )
  }

  const view = buildChangesView(status)

  // The selected files = everything not explicitly deselected (#86). These are the exact
  // paths handed to `gitCommit`; main stages precisely this selection then commits.
  const selectedFiles = view.files.filter((f) => !unchecked.has(f.path))
  const selectedPaths = selectedFiles.map((f) => f.path)
  // A BLANK message no longer blocks committing (#238): the heuristic message shows as
  // the placeholder — what you see is exactly what a blank submit commits.
  const generatedMessage = autoCommitMessage(selectedFiles)
  const effectiveMessage = message.trim() || generatedMessage
  const canCommit = effectiveMessage.length > 0 && selectedPaths.length > 0 && !busy && !committing

  // The smart quick action (#236): pure derivation from the streamed status + the PR
  // reported up by PrSection. Only an OPEN PR counts — a merged/closed one should lead
  // back to "Commit, push & PR".
  const quickAction = deriveQuickAction(status, pr !== null && pr.state.toUpperCase() === 'OPEN')

  const actionsDisabled =
    busy || committing || acting !== null || (view.files.length > 0 && selectedPaths.length === 0)

  /** The quick-action dispatch (#236): guard the commit family (#238), run the rest. */
  async function runQuickAction(kind: QuickActionKind): Promise<void> {
    if (actionsDisabled) return
    if (kind === 'view_pr') {
      // The anchor path: routed through main's setWindowOpenHandler -> openExternal.
      if (pr) window.open(pr.url, '_blank', 'noreferrer')
      return
    }
    if (kind === 'commit' || kind === 'commit_push' || kind === 'commit_push_pr') {
      if (!canCommit) return
      // Default-branch guard (#238): interpose BEFORE any commit-family action that
      // would land straight on the default branch. Strictly best-effort — a failed
      // branches read (or an unresolved default) skips the guard rather than blocking.
      const branches = await window.api.gitBranches({ workspaceDir })
      if (branches.ok && isDefaultBranch(status?.branch ?? null, branches.branches)) {
        setGuardPendingKind(kind)
        setGuardBranchName(suggestBranchName(effectiveMessage))
        setGuardError(null)
        setGuardOpen(true)
        return
      }
    }
    await executeAction(kind)
  }

  /** Run the (possibly guard-approved) action: plain commit via `gitCommit`, everything
   *  else as a stacked action. */
  async function executeAction(kind: QuickActionKind): Promise<void> {
    if (kind === 'view_pr') return
    if (kind === 'commit') return doCommit()
    await runStacked(kind)
  }

  async function doCommit(): Promise<void> {
    setCommitting(true)
    setCommitError(null)
    try {
      const result = await window.api.gitCommit({ workspaceDir, message: effectiveMessage, paths: selectedPaths })
      if (result.ok) {
        // The committed files drop off via the status refresh main triggers; clear the
        // message so the next commit starts fresh. The deselection set reconciles itself
        // as the now-committed paths vanish from the next snapshot.
        setMessage('')
      } else {
        // Recoverable: surface git's actual reason inline; the user can edit + retry.
        setCommitError(result.error)
      }
    } finally {
      // Always re-enable the button — even if the IPC unexpectedly rejects, it can't
      // stick on "Committing…".
      setCommitting(false)
    }
  }

  /** Run a stacked action (#234/#236) with a renderer-minted id; progress streams into
   *  the inline phase line, the resolve is the final word. */
  async function runStacked(kind: GitStackedActionKind): Promise<void> {
    const actionId = crypto.randomUUID()
    actionIdRef.current = actionId
    setActing(kind)
    setActionProgress(null)
    setActionError(null)
    setCommitError(null)
    const commitFamily = kind === 'commit_push' || kind === 'commit_push_pr'
    try {
      const result = await window.api.gitRunStackedAction({
        workspaceDir,
        actionId,
        action: kind,
        ...(commitFamily ? { commitMessage: effectiveMessage, paths: selectedPaths } : {}),
      })
      if (result.ok) {
        if (commitFamily) setMessage('')
        // Anything that pushed changed the PR surface (a new upstream, a new PR):
        // re-fetch it so the chip appears without a manual refresh (#236).
        if (kind !== 'pull') setPrRefreshKey((k) => k + 1)
      } else {
        // The FAILED PHASE is named — a rejected push after a successful commit must
        // not read as "commit failed" (#236). Earlier phases have already landed.
        setActionError(`${PHASE_LABELS[result.phase].replace('…', '')} failed: ${result.error}`)
      }
    } finally {
      actionIdRef.current = null
      setActing(null)
      setActionProgress(null)
    }
  }

  /** The guard's escape hatch (#238/#236): create + switch to the named branch, then
   *  resume the ORIGINAL action on it. A create failure (name collision) stays IN the
   *  dialog. */
  async function createBranchAndContinue(): Promise<void> {
    const name = guardBranchName.trim()
    if (!name) return
    setGuardWorking(true)
    setGuardError(null)
    try {
      const result = await window.api.gitCreateBranch({ workspaceDir, name })
      if (!result.ok) {
        setGuardError(result.error)
        return
      }
      setGuardOpen(false)
      await executeAction(guardPendingKind)
    } finally {
      setGuardWorking(false)
    }
  }

  // DIFF mode (#235: ALL files in one scroll, the clicked row is just the scroll
  // target), gated on `isActive` so a backgrounded (mounted-hidden) Workspace left in
  // DIFF doesn't keep the `@pierre/diffs` worker pool alive while off-screen — and only
  // while the tree still HAS changes, so a streamed status update that empties the set
  // (revert / commit) falls the panel back to the list. The LIVE sorted files feed the
  // view each render, so sections track the list and churn drives its refetch.
  if (isActive && selectedPath !== null && view.files.length > 0) {
    return (
      <aside className="flex min-h-0 flex-1 flex-col text-text">
        <DiffWorkerProvider>
          <AllFilesDiffView
            workspaceDir={workspaceDir}
            files={view.files}
            initialPath={selectedPath}
            onBack={() => setSelectedPath(null)}
          />
        </DiffWorkerProvider>
      </aside>
    )
  }

  return (
    // The SHELL (SurfacePanel) owns the panel's width + border-l chrome now; this fills
    // it and scrolls internally — the shell column is viewport-height, not <main>-scrolled.
    <aside className="flex min-h-0 flex-1 flex-col overflow-y-auto text-text">
      <ReviewHeader count={view.fileCount} onCollapse={onCollapse} onRefresh={refresh} />

      {/* Environment (#119) — a STATIC placeholder gesturing at the mockup's fuller
          "Environment / Local / Sources" side-panel (styled chrome, non-functional,
          like the sidebar's Search/Scheduled/Plugins "Soon" rows). Not wired to
          anything; the live git surface begins at the branch header below. */}
      <div className="border-b border-border-muted px-3 py-2.5">
        <p className="mb-1 px-1 text-[11px] font-medium text-faint">Environment</p>
        <div className="flex flex-col gap-0.5">
          <EnvPlaceholder icon={<Monitor className="size-4" aria-hidden />}>Local</EnvPlaceholder>
          <EnvPlaceholder icon={<Boxes className="size-4" aria-hidden />}>Sources</EnvPlaceholder>
        </div>
      </div>

      <BranchMenu
        workspaceDir={workspaceDir}
        branch={view.branch}
        ahead={view.ahead}
        behind={view.behind}
        busy={busy}
      />

      <PrSection
        workspaceDir={workspaceDir}
        branch={view.branch}
        detached={view.detached}
        hasUpstream={status.upstream !== null}
        busy={busy}
        refreshKey={prRefreshKey}
        onPrChange={setPr}
      />

      {/* Diff scope (#237): Working tree (live) vs Branch changes (`base...HEAD`, on
          demand) — persisted per Workspace. Branch scope swaps the list + commit area
          for the read-only range view; review keeps working after commits land. */}
      <div className="flex items-center border-b border-border-muted px-3 py-2 text-[13px]">
        <div className="flex overflow-hidden rounded-md border border-border">
          <button
            type="button"
            aria-pressed={diffScope.scope === 'working'}
            onClick={() => updateDiffScope({ scope: 'working' })}
            className={
              diffScope.scope === 'working'
                ? 'bg-accent/10 px-2.5 py-1 text-accent-text'
                : 'px-2.5 py-1 text-muted transition-colors hover:text-accent-text'
            }
          >
            Working tree
          </button>
          <button
            type="button"
            aria-pressed={diffScope.scope === 'branch'}
            onClick={() => updateDiffScope({ scope: 'branch' })}
            className={
              diffScope.scope === 'branch'
                ? 'bg-accent/10 px-2.5 py-1 text-accent-text'
                : 'px-2.5 py-1 text-muted transition-colors hover:text-accent-text'
            }
          >
            Branch changes
          </button>
        </div>
      </div>

      {diffScope.scope === 'branch' ? (
        <DiffWorkerProvider>
          <BranchDiffView
            workspaceDir={workspaceDir}
            currentBranch={status.branch}
            baseRef={diffScope.baseRef}
            onBaseRefChange={(baseRef) => updateDiffScope({ baseRef })}
            refreshKey={prRefreshKey}
          />
        </DiffWorkerProvider>
      ) : view.files.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-muted">No changes — working tree clean.</p>
      ) : (
        <ul className="flex flex-col gap-0.5 py-1.5">
          {view.files.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              checked={!unchecked.has(file.path)}
              onToggle={() =>
                setUnchecked((prev) => {
                  const next = new Set(prev)
                  if (next.has(file.path)) next.delete(file.path)
                  else next.add(file.path)
                  return next
                })
              }
              onSelect={() => setSelectedPath(file.path)}
            />
          ))}
        </ul>
      )}

      {/* Action area (#86/#234/#236/#238): the message box (dirty tree only — a BLANK
          message commits with the heuristic shown as the placeholder, #238) + the smart
          quick-action control (primary follows repo state: Commit, push & PR / Commit &
          push / Push / Pull / View PR; the rest in the attached menu). Disabled while a
          turn streams (`busy`) or an action runs. git's reason surfaces inline. */}
      {diffScope.scope === 'working' && (view.files.length > 0 || quickAction.primary !== null) && (
        <div className="flex flex-col gap-2 border-t border-border-muted px-3 py-2.5">
          {view.files.length > 0 && (
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={generatedMessage || 'Commit message'}
              rows={2}
              className="min-h-16 resize-y text-[13px]"
              // Ctrl/Cmd+Enter runs the primary action, matching the composer's chord.
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  if (quickAction.primary) void runQuickAction(quickAction.primary.kind)
                }
              }}
            />
          )}
          {busy && <p className="text-[11px] text-muted">Agent is working…</p>}
          <QuickActions
            view={quickAction}
            commitCount={selectedPaths.length}
            disabled={actionsDisabled}
            actingLabel={acting !== null ? (actionProgress ?? '…') : committing ? 'Committing…' : null}
            error={actionError ?? commitError}
            onRun={(kind) => void runQuickAction(kind)}
          />
        </div>
      )}

      {/* Default-branch guard (#238, generalized by #236): interposed by
          `runQuickAction` on ANY commit-family action when HEAD is the repository's
          default branch — Cancel / Continue on default / Create feature branch
          (prefilled, editable) & continue. Continue and the escape hatch resume the
          ORIGINAL action; a create failure stays in the dialog with git's reason. */}
      <Dialog open={guardOpen} onOpenChange={(open) => !guardWorking && setGuardOpen(open)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Commit on {view.branch}?</DialogTitle>
            <DialogDescription>
              {view.branch} is this repository’s default branch. You can continue here, or move the
              commit onto a new feature branch.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="guard-branch-name" className="text-[11px] font-medium text-muted">
              New branch name
            </label>
            <Input
              id="guard-branch-name"
              value={guardBranchName}
              onChange={(e) => setGuardBranchName(e.target.value)}
              disabled={guardWorking}
              className="text-[13px]"
            />
            {guardError && (
              <p className="text-[11px] text-bad" role="alert">
                {guardError}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" size="sm" disabled={guardWorking} />}>
              Cancel
            </DialogClose>
            <Button
              variant="outline"
              size="sm"
              disabled={guardWorking}
              onClick={() => {
                setGuardOpen(false)
                void executeAction(guardPendingKind)
              }}
            >
              Continue on {view.branch}
            </Button>
            <Button
              size="sm"
              disabled={guardWorking || guardBranchName.trim().length === 0}
              onClick={() => void createBranchAndContinue()}
            >
              {guardWorking ? 'Creating…' : 'Create branch & continue'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  )
}

/** The inline phase line per streamed phase (#236). */
const PHASE_LABELS: Record<GitActionPhase, string> = {
  commit: 'Committing…',
  push: 'Pushing…',
  pull: 'Pulling…',
  create_pr: 'Creating PR…',
}

/**
 * The Review Surface header (#187): the "Changes" title + optional changed-file count, a
 * collapse-to-stack affordance (folds the panel's former standalone collapse into the
 * Surface model, ADR-0013), and the manual git-status Refresh. Shared by the live list
 * and the non-repo/pre-snapshot empty state so the collapse control is always present.
 */
function ReviewHeader({
  count,
  onCollapse,
  onRefresh,
}: {
  count?: number
  onCollapse: () => void
  onRefresh: () => void
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 border-b border-border-muted px-3 py-2.5">
      <button
        type="button"
        onClick={onCollapse}
        title="Collapse"
        aria-label="Collapse Review panel"
        className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left text-sm font-semibold text-text-strong"
      >
        <PanelRightClose size={15} aria-hidden className="shrink-0 text-muted" />
        <span>Changes</span>
        {count !== undefined && count > 0 && (
          <Badge variant="outline" className="ml-0.5 rounded-full px-1.5 py-0 text-[11px] tabular-nums text-muted">
            {count}
          </Badge>
        )}
      </button>
      <IconButton size="icon-sm" onClick={onRefresh} title="Refresh" aria-label="Refresh git status" className="text-muted">
        <RefreshCw className="size-3.5" aria-hidden />
      </IconButton>
    </div>
  )
}

/**
 * A static, non-functional "Environment" row (#119): the mockup's Local / Sources
 * concepts as styled-but-inert chrome, mirroring the sidebar's disabled "Soon"
 * placeholders. Purely decorative — no handler, `cursor-default`, muted + tagged.
 */
function EnvPlaceholder({ icon, children }: { icon: JSX.Element; children: string }): JSX.Element {
  return (
    <div
      title="Coming soon"
      className="flex cursor-default items-center gap-2 rounded-md px-2 py-1 text-[13px] text-muted opacity-70"
    >
      <span className="shrink-0 text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-[10px] font-medium text-faint">Soon</span>
    </div>
  )
}
