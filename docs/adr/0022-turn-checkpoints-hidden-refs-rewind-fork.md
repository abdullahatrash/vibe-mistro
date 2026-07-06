# Turn checkpoints: hidden-ref workspace snapshots, guarded restore, and Rewind & Fork

**Status: PROPOSED** (2026-07-06, #335). Builds on **ADR-0002** (thin orchestrator —
this is pure supervision of the agent's effect on the workspace, zero model-loop involvement),
**ADR-0019** (the transcript event log the checkpoints tee into), **ADR-0008** (the injected
`GitRun` seam and the raw-patch diff contract the turn diff reuses), **ADR-0011** (fork = a new
Draft Thread that binds on first prompt), **ADR-0017** (the fork's conversation prefix rides as a
Context attachment, flattened to text at send), and **ADR-0001** (main tees and forwards; the
renderer folds). Explicitly does NOT revisit the recorded worktree-per-Thread deferral — see
Decision 3.

## Context

The review surface shows the working tree NOW: the all-files diff, the branch-range diff, and the
per-file revert (#233–#239, #250) all answer "what is different at this moment?". Nothing links
the **conversation timeline** to **workspace history**. When a Thread runs five turns and turn 3
broke something, the user cannot see what THAT turn changed, cannot roll the Workspace back to
before it, and cannot retry turn 4 with a different instruction without hand-reconstructing
context in a fresh Thread. The only recovery tools are Stop, the whole-tree revert, and starting
over.

The reference implementation's headline safety feature is exactly this: hidden-git-ref checkpoints
bracketing every turn, per-turn diffs in the timeline, and a first-class revert-to-checkpoint. It
is the single biggest trust unlock an agent client can offer — when failure is cheap, users
delegate bigger tasks. We own every seam needed to build it as one more best-effort tee:
`runPromptTurn` (`src/main/index.ts`) already tees the turn's input and completion into the
transcript event log; every git module already shells out through the injectable `GitRun`
(`src/main/git/run.ts`); the destructive-write pattern (typed result, renderer warning dialog as
the consent gate) exists in `src/main/git/revert.ts`; and turn-scoped diffs can serve through the
existing per-file raw-patch contract (`GitFileDiff` in `src/shared/ipc/git.ts`).

Three honesty constraints shape everything below:

- **The working tree is shared.** All Threads of a Workspace operate on one directory (worktrees
  are a deferred epic). A "per-Thread checkpoint" would be a lie: turns from parallel Threads
  interleave in the same tree.
- **A snapshot is files, not the world.** Installed deps, DB migrations, running dev servers, and
  gitignored artifacts are outside git's reach. Restore copy must say what it restores.
- **ACP session state cannot rewind.** The protocol has no rewind method, and Vibe owns the
  agent's context (ADR-0005/0019 ownership split). Any "rewind" that pretends the agent forgot
  turns 5–7 would be a fabrication. The honest primitive is a **fork**: a new Thread whose context
  is visibly re-fed text.

## Decision

1. **Checkpoints are hidden git commits under `refs/vibe-mistro/checkpoints/<workspaceId>/<seq>`.**
   One flat, app-owned ref namespace per Workspace repo, monotonically sequenced by a
   main-process counter. Refs are invisible to `git branch`/`git log` and normal tooling, never
   touch the user's HEAD, index, stash, or reflog, and keep their objects reachable so `git gc`
   is always safe to run (pruned refs release their objects to normal gc — Decision 10).
   `<workspaceId>`, not `<threadId>`: checkpoints are honestly **workspace-scoped**, because the
   tree is shared; Thread/turn attribution lives in the transcript event log (Decision 4), never
   in the ref name. (This corrects the per-Thread namespace floated during proposal drafting.)

2. **Capture mechanism: temporary-index `write-tree`, never the user's index.** A capture in
   `src/main/git/checkpoints.ts` (built on `GitRun`, injectable for tests like every git module):
   set `GIT_INDEX_FILE` to a temp file, seed it from HEAD (`read-tree HEAD`), stage everything
   (`add -A` — includes untracked, honors `.gitignore`, so ignored build artifacts and secrets
   stay out), `write-tree`, then `commit-tree` with the current HEAD as parent and a marker
   message, and update the ref. Each capture records `{ref, commit, tree, headSha}` — `headSha`
   is load-bearing: the agent may itself commit mid-turn, so nothing may assume HEAD is stable
   between brackets. `git stash create` was considered and rejected for this job (it does not
   capture untracked files and its dual-parent shape buys nothing here).
   - **Skip-if-unchanged**: if the produced `tree` equals the previous checkpoint's `tree` and
     HEAD is unchanged, no new commit is minted — the entry records the previous checkpoint's
     identifiers. Consecutive post/pre pairs across an idle gap collapse to one object.
   - **Size cap + time budget** (thresholds are spike-gated, slice 1): a pre-capture
     `status --porcelain -uall` scan that exceeds a file-count/byte cap, or a capture that
     exceeds its soft time budget, records a **skipped** checkpoint entry with a reason
     (`too-large` / `timeout` / `error` / `not-a-repo`) instead of blocking the turn.
   - **Non-repo Workspaces** (a Workspace need not be a git repo): capture is silently disabled;
     the per-turn UI simply does not render. No nagging.

3. **Bracketing in `runPromptTurn`; best-effort, never gating the live flow.** The **pre-turn**
   capture runs after `ensureBoundSession` and before `session/prompt` goes out — awaited (a torn
   snapshot taken while the agent edits is worthless) but budget-bounded per Decision 2; on
   skip/failure the turn proceeds and the skip is teed. The **post-turn** capture runs when
   `agent.prompt` settles (success, error, or interrupt) and is fire-and-forget — the
   `SendPromptResult` never waits on it. ADR-0019's discipline applies verbatim: no persistence
   or checkpoint write ever rejects a live flow. No worktree creation, no branch switching, no
   isolation theater — checkpoints record what happened to the shared tree; Epic-scale isolation
   composes later when worktrees land, by pointing the same capture at a different `cwd`.

4. **Checkpoints are transcript entries — the event log is the linkage.** A new `TranscriptEntry`
   kind (`turn-checkpoint`, carrying boundary `pre`/`post`, the checkpoint identifiers of
   Decision 2 or a skip reason) is teed to the prompting Thread, globally sequenced with the
   conversation by the log's `seq` (ADR-0019 Decision 3). This makes per-turn diffs derivable
   forever, replayable on cold reopen with no agent spawned, and eviction-proof. The renderer
   folds the entry into its conversation state like any other — main never interprets it
   (ADR-0001). **This is a conversation-item shape change: `REDUCER_SCHEMA_VERSION` must be
   bumped**, invalidating fold snapshots (cost: one lazy full re-fold per Thread, per ADR-0019).

5. **Turn diff: pre-tree vs post-tree, served through the existing raw-patch contract.** A new
   read-only invoke (registered in the git feature registrar) diffs the bracketing checkpoint
   trees and returns per-file entries in the established `GitFileDiff` shape — raw patch,
   `diffHash`, individual truncation cap — so the existing diff viewer renders it unchanged.
   Fallback chain when a bracket is missing (skipped capture, crash mid-turn): pre(N) → pre(N+1);
   for the latest turn, pre(N) → working tree (a live diff, labeled as such). Not agent activity;
   never touches the warm-agent pool.

6. **Renderer: a per-turn collapsible changed-files summary.** Each completed turn renders a
   folded row (changed files + add/del stats, derived lazily from Decision 5's invoke on expand —
   never eagerly for every turn on reopen) with click-through to the full turn-scoped diff and a
   "Restore workspace to before this turn" action. Skipped checkpoints render an unobtrusive
   "checkpoint skipped" note in the expanded state. Collapse state is renderer-local
   (`localStorage`), like every fold.

7. **Restore semantics: files match the pre-turn snapshot; HEAD and branches are never moved.**
   Restore makes the working tree **content-identical** to the checkpoint tree:
   - **Dry-run first, always.** Main computes the plan before touching anything: paths to be
     rewritten, and — separately — the **deletion set**: every path present in the working tree
     now (tracked or untracked; gitignored paths are excluded and never touched) that is absent
     from the checkpoint tree. The confirm dialog (reusing the revert-warning pattern, the app's
     established consent gate for destructive writes) **enumerates the deletions by name** —
     untracked-file removal is unrecoverable and must never hide inside a summary count.
   - **Then apply**: restore the checkpoint tree over worktree + index, delete exactly the
     enumerated set (targeted paths, never a blanket `clean -fdx`), refresh git status. First
     failing step stops the chain with git's actual reason (the `failReason` discipline).
   - **HEAD is untouched.** If the agent (or user) committed between capture and restore, those
     commits survive in history; only file contents roll back. When HEAD-now differs from the
     recorded `headSha`, the dialog says so.
   - **Pinned limitations, stated in the dialog copy**: restores files only (deps/DB/processes
     out of scope); staged-vs-unstaged granularity at capture time is not preserved (one tree is
     snapshotted, not the index separately); the restore is **workspace-wide** — it rolls back
     interleaved turns of sibling Threads too, and the dialog says so when other Threads have
     prompted since the checkpoint.
   - **Refused mid-turn.** The guard is `ThreadStatusTracker`: any streaming Thread in the
     Workspace blocks restore (disabled action + main-side refusal — the renderer check is
     advisory, main's is authoritative). Restoring under a live agent's feet is never allowed.
   - A restore is itself teed to the transcript (a notice entry), so history shows that and when
     the tree was rolled back.

8. **Rewind & Fork: rewind is defined as forking a NEW Thread, never as rewinding ACP session
   state.** "Rewind here" on a turn boundary does two independent things, each skippable:
   (a) offers the Decision-7 restore to that turn's pre-checkpoint; (b) creates a **new Draft
   Thread** in the same Workspace (ADR-0011 lifecycle: renderer-only until first prompt, then
   `session/new` — the old Thread's ACP session is **never mutated, truncated, or re-loaded**)
   whose composer is pre-seeded with a **Context attachment** containing the conversation prefix
   up to that boundary — user prompts and agent replies, not reasoning or tool payloads —
   flattened to plain text at send per ADR-0017 (a marker-fenced trailing block, same family as
   `<attached_files>`). The agent resumes with honest, visible, user-editable context; we never
   pretend its memory rewound, and the token cost of re-feeding is visible rather than hidden.
   The old Thread stays intact as the abandoned branch. Fork lineage is recorded as an additive
   optional field on the Thread's metadata row (`ThreadMeta.pinned` precedent — no migration:
   absent reads as not-a-fork) and rendered in the sidebar as a lightweight "forked from" marker
   on the new Thread. Prefix extraction and flattening are pure renderer modules (the renderer
   owns conversation state, ADR-0001); main only records lineage.

9. **Retention: keep the last N checkpoints per Workspace** (default 50; constant, not a setting,
   until someone asks). Pruning deletes the oldest refs beyond N and runs off the hot path
   (post-capture, debounced — same best-effort posture as the pool sweep). Transcript entries
   keep their identifiers forever; a turn whose checkpoints were pruned degrades to a
   "checkpoint expired" note in place of its diff/restore actions (detected by ref lookup at
   read time, not by log rewriting — the log is append-only truth, ADR-0019).

10. **Ref hygiene on removal.** Workspace removal (the existing `remove-workspace` path) deletes
    the Workspace's entire ref namespace, best-effort (the directory may already be gone — a
    missing repo is success). After ref deletion the snapshot objects are unreachable and normal
    `git gc` reclaims them; we never run gc ourselves.

11. **Rollout: slice 1 ships capture behind a flag, with the spike built in.** The capture spike
    (cost on a large real repo, cold and warm; behavior with in-flight agent writes; cap/budget
    calibration) is acceptance criteria of the first slice, not a separate work item. The flag
    gates capture only; once numbers are in, the flag defaults on and later slices build the UI.
    **Pre-decided fallback** if pre-turn capture proves too slow on large repos even with the
    skip-if-unchanged fast path: demote the pre-turn capture to fire-and-forget with a
    "checkpoint may lag the turn start" marker on affected entries — brackets degrade gracefully
    rather than the feature dying; the entry shape already carries skip/degrade reasons.

## Considered options

- **`git stash create` snapshots** — rejected. Does not capture untracked files (the majority of
  an agent's "new file" output), and its synthetic merge-commit shape complicates tree diffing
  for zero benefit. The temporary-index `write-tree` path captures tracked + untracked in one
  tree, gitignore-honoring.
- **Real commits on the user's branch, or a visible shadow branch** — rejected. Pollutes history
  and every git tool the user runs; a shadow branch invites accidental checkout/merge. Hidden
  refs are invisible by default and exactly as durable.
- **Per-Thread ref namespace (`.../checkpoints/<threadId>/<seq>`)** — rejected as a false
  promise: Threads share one working tree, so a "Thread's checkpoint" would silently contain
  sibling Threads' interleaved edits. Workspace-scoped refs + log attribution tell the truth.
  Worktree-per-Thread isolation is a separate, explicitly deferred epic — not smuggled in here.
- **Our own snapshot store (file copies / content-addressed cache outside git)** — rejected.
  Reinvents the git object store badly: no delta compression, no gc, a second disk-usage story,
  and it forfeits `git diff` for turn diffs. Non-repo Workspaces lose the feature (Decision 2)
  rather than justify a parallel engine.
- **Restore via `git reset --hard` + `git clean -fdx`** — rejected. Moves HEAD (destroying the
  agent's mid-turn commits), and `-x` deletes gitignored files (`node_modules`, `.env`) that were
  never in the snapshot. Restore must be tree-content restore + enumerated targeted deletions.
- **"True" rewind of the existing Thread (truncate our transcript, `session/load`, or replay
  prompts into the same session)** — rejected. ACP has no rewind; Vibe owns session context;
  truncating our log breaks append-only truth (ADR-0019); silent re-prompting fabricates a
  conversation the user didn't have. Fork-with-visible-prefix is the honest semantics, and it
  additionally enables trying multiple branches from one point.
- **Snapshot the index and worktree separately (preserve staging state)** — rejected for v1.
  Doubles capture cost and object count to preserve a nicety; the restore dialog states the
  limitation instead. Revisit only on real demand.
- **Checkpoint on every fs write the agent makes** — rejected. Turn boundaries are the unit users
  reason about ("what did this turn do"), captures stay O(turns) not O(edits), and the transcript
  already brackets turns.

## Consequences

- New main modules: checkpoint capture/restore/prune beside the other git modules on the `GitRun`
  seam (pure, injectable, unit-tested with fake runners — the established pattern); a small tee
  addition inside `runPromptTurn`; new read/restore invokes in the git feature registrar.
- New `TranscriptEntry` kind ⇒ **`REDUCER_SCHEMA_VERSION` bump** with the first shipping slice;
  every Thread pays one lazy full re-fold (ADR-0019's stated cost).
- `.git` grows by the delta between turn snapshots (bounded by retention + skip-if-unchanged +
  delta compression); after pruning, `git gc` reclaims it. Documented, not managed.
- Checkpoints are workspace-scoped until worktrees land; the restore dialog owns the honesty about
  interleaved sibling-Thread turns. When the worktree epic ships, capture composes by `cwd` with
  no model change — refs then live in the worktree's repo, naturally per-isolation-unit.
- Fork lineage is an additive metadata field (no migration); the fork's context prefix rides the
  existing plain-text wire (ADR-0017) — no new protocol shapes, no session mutation, thin
  orchestrator intact (ADR-0002).
- The restore guard couples to `ThreadStatusTracker` (workspace-level "any Thread streaming")
  rather than the per-agent `inFlightTurns` eviction counter — the tracker is the user-facing
  turn truth; eviction accounting stays untouched.
- Skipped/expired checkpoints degrade per-turn UI to notes, never errors; a non-repo Workspace
  sees nothing. The feature is additive everywhere and removable by flag until slice 1's spike
  numbers confirm the capture budget.
