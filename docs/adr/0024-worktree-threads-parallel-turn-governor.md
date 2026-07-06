# Parallel Threads: main-side turn governor + opt-in Worktree Threads (per-session cwd, sibling-agent fallback)

**Status: PROPOSED** (2026-07-06, #348). **Supersedes the worktree-per-Thread
rejection of ADR-0008** (the scoped supersession pattern of 0005→0019 and 0017→0020): ADR-0008's
git-integration decisions — git in main via `child_process`, `@pierre/diffs` rendering, streamed
status, the raw-patch+`diffHash` contract — are unchanged and remain in force. Only its
foundation-level rejection of worktree-per-Thread is superseded, exactly as that ADR anticipated
("worktree-per-Thread isolation … stays a deferred, separate epic"). This is that epic's ADR.
Related: ADR-0002 (thin orchestrator), ADR-0004 (fs confinement), ADR-0006 (warm-agent pool),
ADR-0007 (Agent controls), ADR-0009 (follow-up queue), ADR-0011/0012 (first-prompt binding),
ADR-0014 (Terminal), ADR-0019 (SQLite persistence).

## Context

Parallel agents are the product's founding premise, but today two Threads prompting in the same
Workspace share one working tree. Nothing prevents — or even signals — two simultaneous turns
interleaving writes in one checkout, so cross-Thread parallelism is effectively unusable for real
work; users must serialize themselves. Separately, nothing bounds *total* simultaneous turns
across Workspaces: a user can unknowingly run many agents at once burning tokens and CPU.

The existing serialization machinery does not cover this. The renderer's follow-up queue
(ADR-0009, `conversation/follow-up-queue.ts`) serializes turns only WITHIN one Thread, because
vibe-acp rejects a concurrent `session/prompt` on a session with `-32602` (spike #102). There is
no cross-Thread policy anywhere, in either process.

The reference implementation makes worktree-per-task a first-class environment mode chosen at
task creation and builds its whole parallel-work story on it; it offers no shared-checkout safety
at all (worktrees are its default) and no fan-out-and-compare loop. We can do both: govern the
shared checkout (original supervision work, squarely the thin orchestrator's mandate) *and* offer
opt-in isolation, and — because our per-Thread Agent controls already let a prompt run under a
pinned Model/Reasoning effort — close a loop nobody in the category has: fan a prompt out into N
isolated attempts, compare their diffs, merge the winner.

The protocol groundwork exists: `session/new` and `session/load` take a per-session `cwd`
(`docs/vibe-acp-protocol.md`; `workspace-agent.ts` currently always passes the Workspace dir, but
the parameter is per-call). What is NOT yet known — and what ADR-0009's spike did not answer — is
whether the `-32602` concurrent-prompt rejection is per-*session* or per-*process*, whether one
`vibe-acp` process honors differing cwds across its sessions, and how the agent-initiated
`fs/read_text_file`/`fs/write_text_file` paths resolve under a non-Workspace cwd. Those three
answers are the pivot of this ADR's hosting decision, so they are spike-gated (the repo's
spike-first discipline, per ADR-0019's `node:sqlite` spike).

This ADR settles: how one Workspace hosts isolated Threads (per-session cwd on the single warm
agent vs a sibling agent per active worktree), where cross-Thread turn queueing lives (a
main-side governor vs the renderer's per-Thread follow-up queue), and the eviction/protection
accounting for whichever hosting shape the spike selects.

## Decision

1. **Cross-Thread turn queueing lives in MAIN, in a new pure `turn-governor.ts`** (same shape as
   `agent-protection.ts` / `thread-status.ts`: a pure, fake-clock-testable core that `index.ts`
   feeds live state). The governor is consulted by `runPromptTurn` before dispatch. The boundary
   with the renderer's follow-up queue (ADR-0009) is pinned crisply to prevent double-queueing:
   **the renderer queue serializes turns within ONE Thread** (a protocol constraint — `-32602`)
   and flushes one message per turn-end, exactly as today; **the governor arbitrates ACROSS
   Threads** (a policy constraint — shared-checkout safety and the global cap). A prompt reaches
   the governor only after the renderer's per-Thread queue has released it. Main is the right
   home because the governor must cover Threads whose conversation views aren't mounted (the
   same argument that put `thread-status.ts` in main) and must dispatch a queued turn later even
   if its window is gone.
2. **Governor semantics, pinned.** A prompt for a *local-checkout* Thread while another
   local-checkout Thread of the SAME Workspace is mid-turn is ENQUEUED, not dispatched — FIFO per
   checkout root. Independently, a **global max-simultaneous-turns cap** (default 4, a Settings
   knob) bounds concurrent turns across all Workspaces; excess turns queue FIFO globally.
   Worktree Threads (Decision 4) bypass the same-checkout queue — isolation is precisely what
   buys true parallelism, and the governor makes that trade legible — but still count against the
   global cap. The governor NEVER hard-blocks: the queued Thread's composer shows a banner naming
   the blocking Thread with **"Run anyway"** (dispatch immediately, accepting interleaving — one
   click, preserving today's behavior for users whose Threads touch disjoint files) and
   **"Cancel"** (drop the queued prompt back into the composer). A per-Workspace
   "allow concurrent turns" setting is the permanent opt-out. Single-Thread Workspaces and
   non-overlapping cases never see the governor at all — the queue path only engages when a
   second same-checkout turn would actually overlap.
3. **Queued turns are held in memory in main, fully serialized at enqueue time.** The prompt is
   captured in its final wire form (text with context attachments already flattened per ADR-0017,
   image refs already persisted via the attachment store) so a later auto-dispatch re-serializes
   nothing. On dispatch the governor routes through the exact same `runPromptTurn` path as a
   direct send. Queued prompts are NOT persisted (consistent with the renderer follow-up queue's
   pinned ephemerality, ADR-0009) but are surfaced honestly: the quit-confirm dialog states the
   dropped count. `ThreadStatusTracker` gains a third flag, **`queued` (with position)**, pushed
   over the existing `thread:status` channel and rendered in the sidebar Thread row and the
   composer banner; `getThreadStatuses` re-seeds it on mount like the other flags.
4. **Worktree Threads are OPT-IN at draft time and mint at first prompt.** The composer's
   Agent-controls row gains an environment selector: **"This checkout"** (default, unchanged
   forever) vs **"Isolated worktree"** — hidden entirely for non-git Workspaces ("a Workspace
   need not be a git repo", CONTEXT.md; degrade like ADR-0008's Changes panel). Choosing
   isolation makes the first prompt — the single durability trigger of ADR-0011/0012 — also mint
   the worktree: a new main-side `git/worktree-manager.ts` (pure over the injectable `GitRun`
   seam, like `stacked-action.ts`) runs `git worktree add` under
   `userData/worktrees/<workspaceId>/<threadId>` on an auto-named branch (the commit-guard's
   suggested-branch naming, reimplemented as a shared pure helper — the current slug helper is
   renderer-side in `git/commit-guard.ts` and the mint is main-side). The Thread's metadata row
   records `worktree_root` and `branch` (Decision 8), and the session binds with
   `cwd = worktreeRoot`. Abandoning a Draft still leaves zero residue — no prompt, no worktree.
   The sidebar Thread row and conversation header show a branch badge. Dependency setup
   (node_modules, env files) is deliberately out of scope for v1: the agent can run installs
   itself; we document that, not automate it.
5. **Hosting: per-session cwd on the ONE warm agent is the primary design; a sibling agent per
   active worktree is the pre-decided fallback. A spike decides.** The spike (a bundled node
   script against the live binary, per the CLAUDE.md child-process rule, captured into
   `docs/acp-capture.md`) must answer three questions: (a) does one `vibe-acp` process honor
   differing `cwd`s across its `session/new` calls (tool calls, path display, project-context
   discovery all rooted per-session)? (b) does a concurrent `session/prompt` across TWO sessions
   of one process run, or does `-32602` apply process-wide? (c) against which root do
   agent-initiated `fs/read_text_file`/`fs/write_text_file` paths resolve? Outcomes:
   - **Primary (spike passes a+c):** the pool's one-agent-per-Workspace invariant (ADR-0006) is
     untouched. `WorkspaceAgent.openThread`/`loadThread` take an optional per-call `cwd`;
     eviction/protection accounting is UNCHANGED — `inFlightTurns` is already per-agent, and a
     worktree session's turn protects its (only) agent exactly like a local one. If (b) fails —
     turns serialize per process — worktree Threads still isolate *writes* but run staggered;
     the governor then also queues cross-session turns on that agent (same `queued` surfacing),
     and fan-out degrades gracefully (Decision 9).
   - **Fallback (spike fails a or c):** the pool gains **sibling agents** — one `vibe-acp` child
     per *active* worktree Thread, keyed by its own pool-minted `agentId`, grouped under the
     parent Workspace. Accounting is pinned now so the fallback is a pool extension, not a
     redesign: siblings count against `MAX_WARM_AGENTS`; `isProtected` gains nothing new
     (mid-turn protection already covers a streaming sibling) EXCEPT that the sibling hosting the
     *selected* Thread is protected exactly as `activeAgentId` is today (the wrapper in
     `index.ts` resolves the selected Thread's hosting agent, not just the Workspace's primary).
     An idle evicted sibling re-warms lazily via `session/load` with `cwd = worktreeRoot` —
     transparent, like every re-warm today.
6. **Write confinement becomes per-session-root; reads stay unconfined.** `acp/fs-write.ts`
   already takes its confinement root as an injected `workspaceDir`; the WorkspaceAgent wires it
   **per session**: a worktree session confines writes to its `worktreeRoot` (symlink-resolved,
   same check), a local session to the Workspace root as today. ADR-0004's asymmetry (reads
   UNCONFINED for CLI parity) is unchanged. This is a wiring change behind an existing seam, not
   a new policy.
7. **Workspace surfaces key off the active Thread's EFFECTIVE ROOT** (worktreeRoot if set, else
   the Workspace dir), resolved MAIN-SIDE from the pool/metadata store — never trusted from the
   renderer (the established discipline of the git/files/terminal registrars). Concretely: the
   streamed git status (`git/status-stream.ts` is already keyed per directory — the active
   subscription follows the active Thread's root), the Changes panel and diff IPC (the requests
   already carry a directory), the Files browser root, and the Terminal. Terminal sessions
   become keyed by effective root (the ADR-0014 `term-1` singleton becomes per-root); a worktree
   Thread's Terminal Surface opens rooted in its worktree. Lifecycle rules of ADR-0014 are
   otherwise unchanged.
8. **Schema: three nullable columns on `threads`** via a forward-only migration in
   `state-migrations.ts` (ADR-0019 rules): `worktree_root` (absolute path), `branch`, and
   `attempt_group_id` (Decision 9). No new tables; the worktree is recoverable from git itself
   (`git worktree list`) — the columns are the binding, not the truth.
9. **Worktree lifecycle is guarded, and orphans are swept.** Archive/delete of a worktree Thread
   tears its worktree down (`git worktree remove` + branch cleanup) behind a **dirty-tree guard**:
   uncommitted changes present the choice "commit / discard / keep worktree" (keep detaches the
   Thread from teardown; the worktree remains on disk and the startup sweep re-offers it). A
   startup sweep reconciles `userData/worktrees/**` and `git worktree list` against the metadata
   store: orphaned worktrees (no live Thread) surface a reattach-or-remove notice — never a
   silent delete. All lifecycle git runs go through the injectable `GitRun` seam and are
   best-effort surfaced (log, don't swallow).
10. **Fan-out attempts ride entirely on the above plus existing seams** (ADR-0002-clean: pure
    orchestration + git + UI; the agent is never reimplemented). "Run N attempts" (N ≤ 4, hard
    cap) clones the composer's current prompt + context attachments into N new Worktree Threads
    sharing an `attempt_group_id`, each optionally pinned to a different Model/Reasoning-effort
    combo through the existing pre-prompt controls path (ADR-0007's Vibe-owned knobs; the
    per-Workspace controls cache already lets a draft pre-pick before bind). The fan-out menu
    surfaces the honest N× token cost up front. Attempts are ordinary Threads: sidebar-visible,
    individually steerable, individually stoppable. A **Compare Surface** (a new side-panel
    Surface, read-only in v1) renders one tab per attempt — the existing branch-range diff
    (`git/diff.ts` `baseRef…HEAD` + `BranchDiffView`) pointed at each attempt's root against the
    common base ref recorded at mint — plus a summary strip (files changed, +/− counts, turn
    duration, token usage from the existing usage data). **"Keep this one"** runs the existing
    stacked-action engine (`git/stacked-action.ts`) to merge the winning branch into the primary
    working tree (fast-forward when possible, else a merge commit, behind the default-branch
    guard); losers are archived through Decision 9's guarded teardown. A merge conflict is a
    graceful hand-off — "open a Thread to resolve" — never an in-app merge tool. If the spike's
    question (b) failed, attempts run staggered under the governor rather than simultaneously:
    degraded, not broken.

## Considered options

- **Keep the shared checkout and ship only the governor** — rejected as the end state. Queueing
  makes the footgun legible but caps the product at one effective writer per Workspace; the
  founding premise is parallel agents. The governor ships FIRST (it is independent, zero new
  protocol, and protects the default mode forever) but is not sufficient.
- **Worktree-per-Thread as the default (the reference implementation's shape)** — rejected.
  Our default Thread must stay zero-ceremony in the user's real checkout (the CLI-parity
  instinct behind ADR-0004/0014); worktrees cost disk, an unfamiliar mental model, and a
  merge-back step. Opt-in at draft time keeps the default intact and makes isolation a choice
  with a visible payoff (governor bypass).
- **Queueing in the renderer (extend the follow-up queue cross-Thread)** — rejected. The
  renderer queue exists because of a protocol limit and lives above one Thread's remount; a
  cross-Thread policy needs the authority main already has (turn lifecycle, `thread-status`,
  unmounted Threads, dispatch-after-quit-of-window). Two queues with a crisp boundary beat one
  queue in the wrong process.
- **A hard block instead of queue-with-override** — rejected as paternalistic. Threads often
  touch disjoint files; "Run anyway" (plus the per-Workspace opt-out) preserves expert flow
  while making the risk visible. Never a modal wall.
- **Sibling agent per worktree as the PRIMARY design (skip the spike)** — rejected. It
  multiplies `vibe-acp` children, stresses the pool's LRU/eviction math, and abandons the
  one-agent-per-Workspace invariant without evidence it is necessary. It survives as the
  pre-decided fallback with its accounting pinned (Decision 5) so a failed spike costs a wiring
  change, not a redesign.
- **Copy-the-directory isolation (no git)** — rejected: loses branch identity, diffability, and
  the merge-back story; enormous on real repos. Non-git Workspaces simply don't get isolation.
- **Persisting queued turns across restart** — rejected, consistent with ADR-0009: a queued
  prompt that fires after a restart would surprise the user. Ephemeral + honest drop count.
- **An in-app merge/conflict-resolution tool for keep-the-winner** — rejected for v1 (and
  probably forever): conflict resolution is agent work; hand off to a Thread.

## Consequences

- Slice order is pinned by the dependencies: governor (independent, ships first) → spike →
  worktree mint/bind → per-session confinement + root-keyed surfaces → lifecycle guard/sweep →
  fan-out + Compare + keep-the-winner. The spike's outcome must be captured in
  `docs/acp-capture.md` and recorded against this ADR (primary vs fallback) before slice 3 lands.
- `ThreadStatusTracker` grows a third flag; the sidebar and composer learn `queued`. The
  quit-confirm dialog learns a dropped-queue count.
- The `threads` table gains three nullable columns (forward-only migration; older builds
  fail-closed per ADR-0019). Conversation item shapes are untouched — no
  `REDUCER_SCHEMA_VERSION` bump.
- `userData/worktrees/` becomes app-managed state: backups (ADR-0019's `VACUUM INTO`) do NOT
  cover it — git itself is the recovery story, and the startup sweep is the reconciler.
- Disk usage grows with active worktree Threads on large repos; v1 documents rather than
  automates dependency setup. A future "setup script per Workspace" is left open.
- If the spike selects the fallback, warm-agent memory pressure rises (one child per active
  worktree Thread); `MAX_WARM_AGENTS` accounting already bounds it, and idle siblings evict and
  re-warm transparently. If concurrent prompts stay process-serialized, parallelism is staggered
  until Vibe lifts the limit — the governor surfaces that honestly rather than hiding it.
- Fan-out multiplies token spend by design; the N× cost is surfaced in the menu before dispatch,
  and per-attempt usage is shown in the Compare summary strip. N is capped at 4.
- ADR-0008's "generalizes cleanly later (the 'working tree' simply becomes a worktree's tree)"
  claim is now cashed in: every git surface that resolved the Workspace root main-side resolves
  an effective root instead. Any future surface must do the same from day one.
