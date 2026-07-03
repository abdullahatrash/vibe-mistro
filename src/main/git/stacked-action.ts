import { defaultGitRun, errorMessage, failReason, type GitRun } from './run'
import { gitCommit } from './commit'
import { ghCreatePr } from './github'
import type {
  GitActionPhase,
  GitActionProgressEvent,
  GitStackedActionArgs,
  GitStackedActionResult,
} from '../../shared/ipc'

/**
 * The stacked git-action engine (#234/#236, PRD #233): runs one action as an ordered
 * chain of phases over the injectable `GitRun` seam (like #86's `gitCommit`), streaming
 * tagged progress events through `emit` and resolving with a typed result. #234 shipped
 * the single-phase PUSH / PULL; #236 composes the chains onto the same grammar —
 * `commit_push` (commit → push) and `commit_push_pr` (commit → push → create PR).
 * Event order per action: `actionStarted`, then per phase `phaseStarted` / optional
 * `output` / `phaseFinished`, closed by exactly one of `actionFinished`|`actionFailed`.
 * A failed phase STOPS the chain — earlier phases have already landed (their
 * `phaseFinished` is on the stream); later ones never start. Failure is SWALLOWED into
 * the result — never throws. The commit phase reuses `gitCommit` (the #86 staging
 * semantics, rename origins included); the PR phase reuses `ghCreatePr` (#88), injected
 * as `createPr` so tests fake it without a gh binary.
 */

/** The progress sink — wired to a `webContents` broadcast in `index.ts`, a collector in tests. */
export type GitActionEmit = (event: GitActionProgressEvent) => void

/** The create-PR seam (#236): `ghCreatePr` in production, a fake in tests. */
export type CreatePr = (
  cwd: string,
  fields: { title: string; body: string },
) => Promise<{ ok: true; url: string } | { ok: false; error: string }>

export async function runStackedAction(
  args: GitStackedActionArgs,
  emit: GitActionEmit,
  run: GitRun = defaultGitRun,
  createPr: CreatePr = ghCreatePr,
): Promise<GitStackedActionResult> {
  const chain = new ActionChain(args, emit, run, createPr)
  emit({ workspaceDir: args.workspaceDir, actionId: args.actionId, kind: 'actionStarted', action: args.action })
  try {
    return await chain.run()
  } catch (err) {
    // A truly unexpected throw (a runner that rejects) still degrades to a result —
    // nothing crosses the IPC boundary as an exception (#86 style).
    return chain.fail(chain.currentPhase, errorMessage(err))
  }
}

/** One running action: the tag + emit + runners shared by its phases. */
class ActionChain {
  /** The phase a mid-flight throw is attributed to; each phase sets it as it starts. */
  currentPhase: GitActionPhase

  constructor(
    private readonly args: GitStackedActionArgs,
    private readonly emit: GitActionEmit,
    private readonly runGit: GitRun,
    private readonly createPr: CreatePr,
  ) {
    this.currentPhase = args.action === 'pull' ? 'pull' : args.action === 'push' ? 'push' : 'commit'
  }

  /** Run the action's phase sequence in order; the first failure stops the chain. */
  async run(): Promise<GitStackedActionResult> {
    const { action } = this.args
    if (action === 'pull') return this.finish(await this.pull())
    if (action === 'commit_push' || action === 'commit_push_pr') {
      const committed = await this.commit()
      if (!committed.ok) return committed
    }
    const pushed = await this.push()
    if (!pushed.ok) return pushed
    if (action === 'commit_push_pr') {
      return this.finish(await this.createPullRequest())
    }
    return this.finish(pushed)
  }

  /** COMMIT (#236): the #86 staging semantics via `gitCommit` — selection subset or all. */
  private async commit(): Promise<GitStackedActionResult> {
    this.phaseStarted('commit')
    const res = await gitCommit(
      this.args.workspaceDir,
      this.args.commitMessage ?? '',
      this.args.paths ?? [],
      this.runGit,
    )
    if (!res.ok) return this.fail('commit', res.error)
    this.emitTagged({ kind: 'phaseFinished', phase: 'commit' })
    return { ok: true }
  }

  /** PULL: fast-forward ONLY — a diverged branch surfaces git's reason instead of the
   *  app deciding a merge/rebase on the user's behalf (PRD #233). */
  private async pull(): Promise<GitStackedActionResult> {
    this.phaseStarted('pull')
    const pull = await this.runGit(['pull', '--ff-only'], this.args.workspaceDir)
    if (pull.code !== 0) return this.fail('pull', failReason(pull))
    this.finishPhase('pull', pull)
    return { ok: true }
  }

  /** PUSH: plain `git push` with an upstream; a FIRST push sets the upstream on the
   *  primary remote so ahead/behind and the PR section's `hasUpstream` gate work on. */
  private async push(): Promise<GitStackedActionResult> {
    const { workspaceDir } = this.args
    this.phaseStarted('push')
    const upstream = await this.runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      workspaceDir,
    )
    let pushArgs = ['push']
    if (upstream.code !== 0) {
      // Detached HEAD has no branch to set an upstream for — fail with git's reason.
      const branch = await this.runGit(['symbolic-ref', '--short', 'HEAD'], workspaceDir)
      if (branch.code !== 0) return this.fail('push', failReason(branch))
      const remotes = await this.runGit(['remote'], workspaceDir)
      const names = remotes.stdout.split('\n').map((r) => r.trim()).filter(Boolean)
      // Prefer `origin` when present, else the first configured remote.
      const remote = names.includes('origin') ? 'origin' : names[0]
      if (!remote) return this.fail('push', 'No remote configured — add one with `git remote add`.')
      pushArgs = ['push', '-u', remote, branch.stdout.trim()]
    }
    const push = await this.runGit(pushArgs, workspaceDir)
    if (push.code !== 0) return this.fail('push', failReason(push))
    this.finishPhase('push', push)
    return { ok: true }
  }

  /** CREATE PR (#236): `gh pr create`, title = the commit message's FIRST LINE (the
   *  conventional summary), empty body — the renderer swaps the chip in from `prUrl`. */
  private async createPullRequest(): Promise<GitStackedActionResult> {
    this.phaseStarted('create_pr')
    const title = (this.args.commitMessage ?? '').split('\n')[0].trim() || 'Changes'
    const res = await this.createPr(this.args.workspaceDir, { title, body: '' })
    if (!res.ok) return this.fail('create_pr', res.error)
    this.emitTagged({ kind: 'output', phase: 'create_pr', text: res.url })
    this.emitTagged({ kind: 'phaseFinished', phase: 'create_pr' })
    return { ok: true, prUrl: res.url }
  }

  /** Fail the chain: emit `actionFailed` + resolve `{ok:false}` — later phases never start. */
  fail(phase: GitActionPhase, error: string): GitStackedActionResult {
    this.emitTagged({ kind: 'actionFailed', phase, error })
    return { ok: false, phase, error }
  }

  /** Close the whole action successfully, preserving any phase payload (prUrl). */
  private finish(result: GitStackedActionResult): GitStackedActionResult {
    if (result.ok) this.emitTagged({ kind: 'actionFinished' })
    return result
  }

  private phaseStarted(phase: GitActionPhase): void {
    this.currentPhase = phase
    this.emitTagged({ kind: 'phaseStarted', phase })
  }

  /** Close a successful command phase: non-empty output (hook chatter, fast-forward
   *  summaries) as an `output` event — a FAILURE's text travels in `actionFailed.error`
   *  instead, never both — then `phaseFinished`. */
  private finishPhase(phase: GitActionPhase, res: { stdout: string; stderr?: string }): void {
    const text = `${res.stdout}\n${res.stderr ?? ''}`.trim()
    if (text) this.emitTagged({ kind: 'output', phase, text })
    this.emitTagged({ kind: 'phaseFinished', phase })
  }

  private emitTagged(
    event:
      | { kind: 'phaseStarted'; phase: GitActionPhase }
      | { kind: 'output'; phase: GitActionPhase; text: string }
      | { kind: 'phaseFinished'; phase: GitActionPhase }
      | { kind: 'actionFinished' }
      | { kind: 'actionFailed'; phase: GitActionPhase; error: string },
  ): void {
    this.emit({ workspaceDir: this.args.workspaceDir, actionId: this.args.actionId, ...event })
  }
}
