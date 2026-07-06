# Utility chat sessions: agent-written commit messages and PR bodies are delegation, not an embedded model

**Status: PROPOSED** (2026-07-06, #341). Interprets and stays inside **ADR-0002**
(thin orchestrator). Builds on **ADR-0006** (warm agent pool), **ADR-0007** (Agent controls are
Vibe-owned; Mode `chat` is read-only conversational), **ADR-0012** (eager primary session — whose
handle this ADR explicitly must NOT touch), **ADR-0003** (auth delegated; `-32000` = expiry),
**ADR-0011** (zero-residue drafts — the same residue discipline applied to protocol handles), and
**ADR-0008/0017** (the commit/PR flows and composer-attachment machinery the generated text lands
in). The reference implementation ships this feature via a configurable client-side
text-generation model; this ADR is the pure-orchestration answer to the same need.

## Context

Commit messages and PR bodies in vibe-mistro are hand-typed. The commit flow ships a zero-cost
path heuristic (`apps/desktop/src/renderer/src/git/commit-guard.ts` derives a filename-based
suggestion) and persisted drafts (`commit-draft-store.ts`), but nobody would call either "the
message the author of the diff would write" — and the diff's author is sitting right there: the
Workspace's warm `vibe-acp` agent (ADR-0006) that produced the changes. Today users literally ask
the agent in-thread to "write me a commit message" and copy-paste the answer — which burns the
Thread's context window on housekeeping and leaves commit-message chatter in a conversation that
was about the feature.

The reference implementation solves this with an embedded, configurable text-generation model
called client-side. That door is closed to us by ADR-0002: no embedded model, no client-side
model loop. The question this ADR settles: **is minting a throwaway chat-Mode ACP session on the
Workspace's already-warm agent, sending one templated prompt, and parsing one response —
delegation within ADR-0002, or an embedded-model violation by the back door?** And if it is
delegation, what bounds keep it so as the pattern inevitably attracts new callers?

Ground truth already captured (`docs/acp-capture.md`):

- Mode `chat` exists on vibe-acp ("Read-only conversational mode for questions and discussions",
  §on `session/new`) and is set via `session/set_mode {sessionId, modeId}` (§10, ADR-0007 spike).
- One `vibe-acp` process hosts many ACP sessions (CONTEXT.md); `session/new`, `session/prompt`,
  `session/cancel` (notification), and capability-gated best-effort `session/close` all exist on
  `WorkspaceAgent` today (`apps/desktop/src/main/workspace-agent.ts`).
- §12: a second `session/prompt` on the **same session** mid-turn hard-errors
  `-32602 "Concurrent prompts are not supported yet, wait for agent loop to finish"`. Whether a
  second **session** on the same process can prompt while another session's turn streams is
  **unverified** — and the error wording ("agent loop", not "session") hints the loop may be
  process-wide. This is the epic's load-bearing spike.

## Decision

**Yes — with the bounds below, this is delegation, and it ships.** The test that makes it
delegation rather than embedding: *the model loop never runs in our process.* We assemble a
prompt, send it over ACP to the same external agent the user already talks to, and render the
reply into an editable field. The user could produce the identical result by typing the identical
prompt into a Thread; we are automating the courier trip and keeping their conversation clean —
exactly the "spawn/supervise, send prompts, render output" mandate of ADR-0002. No client-side
model, no provider registry, no API keys (ADR-0003 stays intact), no new protocol.

1. **New concept: the utility session.** A throwaway ACP session minted via `session/new` on the
   Workspace's warm `WorkspaceAgent`, used for **exactly one** prompt turn, then discarded. A
   utility session is **never a Thread**: it has no `threadId`, writes no metadata row and no
   transcript entries (the transcript tee is simply never attached), never appears in the sidebar,
   never registers with the thread-status tracker, and is never addressed by the renderer — it
   lives and dies inside one main-process function call. The term goes into CONTEXT.md alongside
   "ACP session" (which remains "never surfaced in the UI" — a utility session is the same handle
   one level more disposable).

2. **The lifecycle is fixed and non-negotiable: mint → chat → one turn → extract → close.**
   A generic main-side seam — `runUtilityTurn(agent, promptText)` in a new module beside
   `workspace-agent.ts` — performs, in order:
   - `session/new` (a **fresh** session; see decision 4 for what it must never reuse);
   - `session/set_mode {modeId: 'chat'}` — **fail-closed**: if `set_mode` errors, the generation
     aborts with a typed failure. A utility turn NEVER runs in `default` (or any tool-capable)
     Mode. Chat Mode is what makes the turn inert: read-only, no tool use, therefore **no
     Permission request can ever fire** from a utility session — there is no UI surface that
     could answer one;
   - one `session/prompt` with the assembled template;
   - collect the streamed agent-message chunks for **that sessionId only** (the existing
     `acp:event` fan-out already tags by session; utility-session updates are consumed in main
     and never forwarded to the renderer as conversation events);
   - best-effort `session/close` (capability-gated, failures swallowed — the existing
     `closeSession` semantics). An unclosed utility session is an in-memory handle on `vibe-acp`
     that dies with the process at eviction; acceptable residue, mirroring ADR-0011's reasoning.

3. **Kind-specific assembly stays pure and testable.** The first two callers are
   `generateGitText(workspaceId, kind: 'commit' | 'pr')` behind one `invoke` IPC channel in the
   git domain module: a pure template builder per kind (staged-file list + a size-capped,
   tail-trimmed diff summary, reusing the surgical-staging diff machinery from the commit flow)
   and a pure, tolerant **output extractor** (strip markdown fences, leading "Here's a commit
   message:" chatter, trailing sign-off) with colocated tests. Extraction failure is a typed
   failure, not an exception; the input caps are load-bearing and unit-tested (a 40 MB lockfile
   diff must not become a 40 MB prompt).

4. **Zero context contamination — three "nevers", all pinned:**
   - **Never the Thread's session.** The whole point: the user's conversation context (Vibe-owned,
     ADR-0005/0019) is not polluted with housekeeping, and no transcript entry is synthesized or
     suppressed (ADR-0001's tee-everything discipline stays intact because nothing enters the tee).
   - **Never the Workspace's primary session.** ADR-0012 keeps one eager unconsumed session
     reserved for a Draft's first prompt. A utility turn must not claim it via
     `consumePrimarySession` and must not prompt on it — a Draft binding afterwards would inherit
     commit-message chatter as its opening context. Utility sessions are always freshly minted.
   - **Never reused.** One generation = one session. A long-lived per-Workspace utility session
     would accumulate context across generations (generation N sees N−1 prior diffs) and acquire
     its own auth/eviction lifecycle. Rejected for v1; see Considered options.

5. **Explicit user trigger, single turn, never automatic.** Generation runs only on a click (the
   sparkle button in the commit-message box and the PR-create flow). No generation on commit-box
   focus, on staging, on a timer, or as a turn side effect. Two reasons, both load-bearing: each
   generation costs the user real tokens on their Mistral account, and "the app never spends the
   user's model budget without being asked" is part of what keeps this delegation rather than a
   hidden client-side model habit. Generated text always lands in an **editable draft** — never
   auto-commits, never auto-submits the PR (matching the reference implementation's own behavior).
   The existing heuristic suggestion stays as the zero-cost default; the sparkle is an upgrade,
   not a replacement.

6. **Concurrency gating is spike-gated, with both outcomes pre-decided.** The mandatory first step
   of the implementing slice is a probe script (repo spike-first discipline, same
   bundle-to-node-and-run harness as the §9–§12 spikes): on one warm `vibe-acp` process, start a
   turn streaming on session A, then `session/prompt` on a fresh session B.
   - **If cross-session concurrency works**: the sparkle is available even mid-turn. The utility
     turn registers `beginTurn`/`endTurn` on `AgentActivity` (keyed by agentId) so the pool never
     evicts an agent mid-generation — but it does NOT touch the thread-status tracker (no
     `threadId`, no sidebar spinner).
   - **If the agent loop serializes process-wide** (the `-32602` wording suggests it): the feature
     **degrades to idle-only** — the sparkle is enabled only when the Workspace's agent has no
     in-flight turn (`AgentActivity` already knows), disabled-with-reason otherwise ("Vibe is
     busy in this Workspace"). Additionally, **user turns always preempt utility turns**: if a
     real prompt is submitted anywhere in the Workspace while a utility turn is in flight under
     the serialized regime, main immediately `session/cancel`s the utility session and the
     generation reports a typed "superseded" failure. A utility turn may never delay, queue
     behind, or steal priority from a Thread's turn.
   The spike result is appended to `docs/acp-capture.md` as a new numbered section either way;
   its answer is shared infrastructure for the parallel-agents epic's concurrency question.

7. **Failure semantics: everything degrades to manual typing.**
   - Agent cold / evicted / not spawned → sparkle disabled-with-reason (the established
     disabled-with-reason tooltip pattern); clicking never spawns an agent just to write prose —
     warming stays select-driven (ADR-0006).
   - Unauthenticated, or `-32000` mid-generation → abort the generation (no auto-retry), route
     through the existing keep-agent-alive sign-in path (ADR-0003), leave the draft untouched.
   - Extractor yields nothing usable → typed failure, toast/inline error, draft untouched.
   - Every failure is logged and surfaced (log-don't-swallow); none of them block committing or
     PR creation, which never depended on generation in the first place.

8. **Model and Reasoning effort: session defaults for v1.** The utility session runs whatever
   `session/new` reports as current — no `session/set_model` call (it false-accepts arbitrary
   strings, ADR-0007 spike ⚠) and no effort override. A Settings choice ("model used for
   generated messages") is an explicitly deferred follow-up; adding it later is one `set_model`
   call with an id from `availableModels`, no redesign.

9. **The bright line, written down for future callers.** A utility session stays inside ADR-0002
   only while ALL of these hold: chat Mode (no tool use, no Permission requests) · explicit user
   trigger · single turn · fresh session, closed after · output into an editable field · no
   persistence of the exchange · no client-side credentials or direct model HTTP. Any feature
   that wants to cross one of these — multi-turn utility conversations, tool-enabled utility
   sessions, automatic/background generation, a client-side API key — is **not covered by this
   ADR** and needs its own, argued against ADR-0002 from scratch. This clause exists because
   "just one more bound relaxed" is exactly how a courier becomes an embedded agent.

## Considered options

- **Embedded / client-side text-generation model** (the reference implementation's shape: a
  configurable model called directly by the client) — rejected. A direct ADR-0002 violation, and
  it drags in credential storage (contra ADR-0003), a provider registry we deliberately don't own
  (contra ADR-0012's reasoning), and a second billing surface. The entire premise of this app is
  that Vibe is the model provider we orchestrate.
- **Ask in the Thread's own session with a hidden prompt** — rejected. Contaminates the Thread's
  Vibe-owned context/history with housekeeping, and forces an ugly choice on the transcript:
  either the hidden exchange appears in the conversation (noise) or we suppress entries from the
  tee (breaking ADR-0001/0019's "the entry stream is the event log" — the transcript would no
  longer be what happened). Also burns the Thread's context window.
- **Reuse the Workspace's primary session (ADR-0012)** — rejected. It is reserved: the next
  Draft's first prompt binds to it, and would inherit the generation exchange as its opening
  context. Consuming it instead would silently defeat ADR-0012's purpose (instant controls +
  first-prompt reuse) once per generation.
- **One long-lived utility session per Workspace, reused across generations** — rejected for v1.
  Saves a `session/new` round-trip on a warm process (a handshake, not a spawn — ADR-0011's own
  math) at the cost of cross-generation context bleed and a session lifecycle to manage across
  auth expiry and eviction. Pre-decided revisit trigger: mint latency proving user-visible.
- **Keep only the local heuristic** (`commit-guard.ts` path summary) — kept as the zero-cost
  default and the universal fallback, but rejected as the endgame: a filename heuristic cannot
  write a PR body, and "the agent that made the changes writes the message" is the differentiator.
- **Wait for a dedicated ACP text-generation / one-shot-completion method** — rejected as
  indefinite. Nothing in the protocol capture suggests one exists or is coming; the utility
  session composes it from four methods that all exist today.

## Consequences

- Each generation costs the user real tokens; the explicit-trigger bound (Decision 5) is the
  mitigation, and the button's presence is honest about it (sparkle = "ask Vibe").
- The spike outcome shapes the UX ceiling: cross-session concurrency gives "generate any time";
  serialization gives idle-only, which is still useful (the commit moment is usually idle) but
  weaker. Both are shippable; neither changes the architecture.
- Chat-Mode output can include preamble/chatter; the strict-format template plus tolerant
  extractor (Decision 3) is the mitigation, and its fixture tests are the regression net.
- Utility turns are deliberately invisible: nothing in the transcript, nothing to replay, no
  fold-snapshot or `REDUCER_SCHEMA_VERSION` interaction (ADR-0019 untouched). The generated text
  becomes durable only if the user commits it / submits the PR — at which point git/GitHub is the
  system of record, not us.
- `AgentActivity` gains a caller outside the prompt-turn path (Decision 6's eviction shield);
  its count-based `beginTurn`/`endTurn` already tolerates overlap, so no changes to
  `agent-protection.ts`'s predicate are expected.
- CONTEXT.md gains **Utility session** as a glossary term; "ACP session — never surfaced in the
  UI" remains true and is in fact strengthened (a whole session class now exists that the
  renderer never even hears about).
- The pattern is now available cheaply, which is precisely the risk Decision 9 exists to contain:
  the bright line is part of the decision, not commentary.
