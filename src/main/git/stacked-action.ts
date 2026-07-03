import { defaultGitRun, errorMessage, failReason, type GitRun } from './run'
import type {
  GitActionPhase,
  GitActionProgressEvent,
  GitStackedActionArgs,
  GitStackedActionResult,
} from '../../shared/ipc'

/**
 * The stacked git-action engine (#234, PRD #233): runs one action as an ordered chain
 * of phases over the injectable `GitRun` seam (like #86's `gitCommit`), streaming
 * tagged progress events through `emit` and resolving with a typed result. Slice 1
 * ships the single-phase actions — PUSH and PULL; #236 composes commit→push→PR chains
 * onto the same engine, which is why the event grammar already speaks in phases.
 * Event order per action: `actionStarted`, then per phase `phaseStarted` / optional
 * `output` / `phaseFinished`, closed by exactly one of `actionFinished`|`actionFailed`.
 * A failed phase STOPS the chain. Failure is SWALLOWED into the result — never throws.
 */

/** The progress sink — wired to a `webContents` broadcast in `index.ts`, a collector in tests. */
export type GitActionEmit = (event: GitActionProgressEvent) => void

export async function runStackedAction(
  args: GitStackedActionArgs,
  emit: GitActionEmit,
  run: GitRun = defaultGitRun,
): Promise<GitStackedActionResult> {
  const chain = new ActionChain(args, emit, run)
  emit({ workspaceDir: args.workspaceDir, actionId: args.actionId, kind: 'actionStarted', action: args.action })
  try {
    return args.action === 'pull' ? await chain.pull() : await chain.push()
  } catch (err) {
    // A truly unexpected throw (a runner that rejects) still degrades to a result —
    // nothing crosses the IPC boundary as an exception (#86 style).
    return chain.fail(args.action === 'pull' ? 'pull' : 'push', errorMessage(err))
  }
}

/** One running action: the tag + emit + runner shared by its phases. */
class ActionChain {
  constructor(
    private readonly args: GitStackedActionArgs,
    private readonly emit: GitActionEmit,
    private readonly run: GitRun,
  ) {}

  /** PULL: fast-forward ONLY — a diverged branch surfaces git's reason instead of the
   *  app deciding a merge/rebase on the user's behalf (PRD #233). */
  async pull(): Promise<GitStackedActionResult> {
    this.phaseStarted('pull')
    const pull = await this.run(['pull', '--ff-only'], this.args.workspaceDir)
    if (pull.code !== 0) return this.fail('pull', failReason(pull))
    return this.finishPhase('pull', pull)
  }

  /** PUSH: plain `git push` with an upstream; a FIRST push sets the upstream on the
   *  primary remote so ahead/behind and the PR section's `hasUpstream` gate work on. */
  async push(): Promise<GitStackedActionResult> {
    const { workspaceDir } = this.args
    this.phaseStarted('push')
    const upstream = await this.run(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      workspaceDir,
    )
    let pushArgs = ['push']
    if (upstream.code !== 0) {
      // Detached HEAD has no branch to set an upstream for — fail with git's reason.
      const branch = await this.run(['symbolic-ref', '--short', 'HEAD'], workspaceDir)
      if (branch.code !== 0) return this.fail('push', failReason(branch))
      const remotes = await this.run(['remote'], workspaceDir)
      const names = remotes.stdout.split('\n').map((r) => r.trim()).filter(Boolean)
      // Prefer `origin` when present, else the first configured remote.
      const remote = names.includes('origin') ? 'origin' : names[0]
      if (!remote) return this.fail('push', 'No remote configured — add one with `git remote add`.')
      pushArgs = ['push', '-u', remote, branch.stdout.trim()]
    }
    const push = await this.run(pushArgs, workspaceDir)
    if (push.code !== 0) return this.fail('push', failReason(push))
    return this.finishPhase('push', push)
  }

  /** Fail the chain: emit `actionFailed` + resolve `{ok:false}` — later phases never start. */
  fail(phase: GitActionPhase, error: string): GitStackedActionResult {
    this.emitTagged({ kind: 'actionFailed', phase, error })
    return { ok: false, phase, error }
  }

  private phaseStarted(phase: GitActionPhase): void {
    this.emitTagged({ kind: 'phaseStarted', phase })
  }

  /** Close a successful phase: non-empty command output (hook chatter, fast-forward
   *  summaries) as an `output` event — a FAILURE's text travels in `actionFailed.error`
   *  instead, never both — then `phaseFinished` + (slice 1: single-phase) `actionFinished`. */
  private finishPhase(
    phase: GitActionPhase,
    res: { stdout: string; stderr?: string },
  ): GitStackedActionResult {
    const text = `${res.stdout}\n${res.stderr ?? ''}`.trim()
    if (text) this.emitTagged({ kind: 'output', phase, text })
    this.emitTagged({ kind: 'phaseFinished', phase })
    this.emitTagged({ kind: 'actionFinished' })
    return { ok: true }
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
