# Supervision & Attention: OS notifications, tray, Mission Control, and the Attention Firewall boundary

**Status: PROPOSED** (2026-07-06, #322)

## Context

vibe-mistro already runs many Workspaces concurrently: the warm agent pool (ADR-0006) keeps one
`vibe-acp` per open Workspace, background turns keep streaming while another Thread is on screen,
and `src/main/thread-status.ts` (`ThreadStatusTracker`) is the established single source of truth
for per-Thread `streaming` / `needsAttention`, keyed by durable `threadId` and pushed over the
`thread:status` channel (with `getThreadStatuses` as the mount-time re-seed). A **Permission
request** (`session/request_permission`) blocks its agent mid-turn until answered; the answer
travels renderer → main → agent by JSON-RPC **request id** over the `permission:respond` invoke
(ADR-0001), and both the request and the user's choice are teed to the transcript event log
(ADR-0019).

Everything above works — and is invisible. The only signal that an agent is blocked is a sidebar
dot inside the app window. When the window is minimized, on another desktop, or behind an editor,
a blocked Permission request stalls a turn indefinitely, which destroys the value of running
agents concurrently. There is no aggregate answer to "what are all my agents doing right now and
which one needs me next", and the same routine "run tests?" question interrupts the user dozens
of times a day (blanket `auto-approve` Mode being the only — too blunt — relief). The reference
implementation ships zero tray/notification/OS-attention machinery (grep-verified), so this is
verified differentiation, and it is the substrate any later away/remote supervision builds on.

This ADR settles the two architecture questions the epic raises, before any slice ships:

1. **May the client deterministically auto-answer Permission requests from user-authored, named
   rules (the "Attention Firewall")?** Where is the hard line between app-side supervision policy
   and Vibe-owned approval posture (ADR-0002 thin orchestrator, ADR-0007 Mode is Vibe-owned)?
2. **May main derive a presentation-only `activityHeadline` from `session/update`** for fleet
   rows (Mission Control, tray, notifications) without eroding ADR-0001's
   renderer-owns-conversation-state?

## Decision

1. **Yes — the app may auto-answer Permission requests from user-authored rules, and the boundary
   is: Vibe owns the approval *posture*, the app owns the *answering* of requests that fire.**
   Mode (ADR-0007) decides *whether* a Permission request is raised at all — that stays entirely
   Vibe's, changed only via `session/set_mode`, and the Firewall never touches it. Once a request
   HAS fired, answering it is already the app's job (the user clicking a `PermissionRow` button
   is the app answering by `optionId`); a Firewall rule is the same act performed by a policy the
   user authored in advance. The Firewall only ever **selects among the options the agent itself
   offered** in the request's own `options` array — it never invents an outcome, never calls a
   `session/set_*` method, never widens what the agent may do. That keeps ADR-0002 intact: this
   is orchestration policy over an existing answer channel, not a reimplemented agent capability.

2. **Firewall guard-rails (pinned, non-negotiable):**
   - Rules are **named**, **ordered**, and evaluated first-match; on any ambiguity or tie,
     **deny/ask always trumps allow**. A request matching no rule flows to the UI exactly as
     today — the Firewall is a filter in front of the existing path, never a replacement for it.
   - An allow rule may only select an option whose `kind` is `allow_once` — **never**
     `allow_always` / session-scoped options. One rule match answers exactly one request; scope
     escalation is impossible by construction (breadth lives in the rule's own match pattern,
     which the user authored and can read, not in a hidden session grant).
   - Matching is **conservative**: exact/prefix match on commands (no regex over shell strings in
     v1 — quoting, `&&`/`;` chaining, and env tricks make general command parsing a footgun),
     path globs for file operations, and the tool kind. Docs state plainly that rules reduce
     interruptions; they do not guarantee safety.
   - Rules carry an optional **scope** (this Thread / this Workspace / everywhere) and optional
     **expiry**. A global kill-switch ("pause all rules") disables evaluation instantly.
   - **Full audit, no silence:** every auto-answered request is teed to the transcript event log
     (ADR-0019) as a distinct entry kind carrying the rule name, request id, and the chosen
     option — rendered dimmed in the conversation, replayable like everything else. Note: unlike
     the human path (where main tees `optionId` with a null display name), the Firewall answers
     in main *from the request payload itself*, so it records the option's display `name` too.
     The turn surface shows a per-turn "N auto-approvals" pill. Trust through visibility.
   - Changing Mode remains forward-acting and never retroactively resolves a pending Permission
     request (ADR-0007); the same rule applies to newly authored Firewall rules — a rule created
     while a request is pending does NOT auto-answer that pending request. Only the explicit
     "adopt rule and apply to this request" action in the drafting flow may do both, because
     there the user's click IS the answer.

3. **The Firewall's match surface is spike-gated.** The captured `session/request_permission`
   payload (docs/acp-capture.md §6) carries only `sessionId`, `toolCall.toolCallId`, and the
   `options` array — the tool's kind/command/path live in the **preceding `tool_call`
   `session/update`**, correlated by `toolCallId`. Main already sees that raw stream (it forwards
   and tees it), so a shape-probe correlation is available without interpreting conversation
   state — but the exact descriptor fields per tool kind (execute vs edit vs fetch) MUST be
   captured from the live `vibe-acp` binary before the match surface is designed (per the
   standing "verify against the live binary" convention). **Pre-decided fallback:** if
   correlation proves unreliable for some tool kinds, those kinds are simply unmatched (flow to
   the UI as today) — the Firewall degrades to fewer auto-answers, never to wrong ones.

4. **The Firewall lives in main, in front of the existing relay.** A pure, exhaustively
   unit-tested predicate module evaluates each arriving `request_permission` against the rule
   store; a match answers immediately by request id through the **same single relay path** the
   human answer uses (tracker `addPermission`/`resolvePermission` bookkeeping, transcript tee,
   `thread:status` emission all included — an auto-answered request briefly exists and settles,
   it is never invisible to the machinery). Non-matching requests are forwarded to the renderer
   untouched. It cannot live in the renderer: background Threads are not mounted there (the exact
   reason `ThreadStatusTracker` lives in main, per its #53 note), and the whole point is
   answering when no view is looking. Rules persist in `state.sqlite` behind a new store seam
   following ADR-0019's conventions (hand-written SQL, forward-only migration, best-effort
   writes never reject a live flow).

5. **One resolve path, idempotent in main.** Answering may now originate from three surfaces —
   the conversation `PermissionRow`, a Mission Control row, or a Firewall rule — so main becomes
   the single idempotency point: the **first answer per (agentId, requestId) wins**; later
   answers are dropped and logged, never relayed. Correction to the epic brief: today's
   `permission:respond` handler relays unconditionally (`agent?.respondPermission(...)`) even
   though `ThreadStatusTracker.resolvePermission` already returns `null` for an
   unknown/already-settled request — the relay must be **gated on that settled check** (or an
   equivalent settled set), which is a small hardening, not a redesign. Both racing surfaces
   receive the settled state through the existing `thread:status` push (pending count drops),
   plus the renderer's own resolved handling; the double-answer race gets an explicit test.

6. **Yes — main may derive a presentation-only `activityHeadline`, under pinned constraints.**
   The `ThreadStatus` payload grows three optional presentation fields: `turnStartedAt` (epoch),
   `activityHeadline` (a short string like "Running tests" — the latest tool-call title from the
   raw stream), and a `pendingPermission` summary (`requestId`, a display title, the `options`
   array) so a Permission request is answerable from outside the conversation outlet. This does
   NOT erode ADR-0001 because it follows the established payload-shape-probe precedent
   (`sessionIdFromPayload`, `permissionRequestIdOf`): a dumb `switch` over raw event shapes that
   copies strings out, with **no folding, no item state, no interpretation of conversation
   semantics**. The constraints, pinned: the headline is (a) **best-effort** — absent on any
   unrecognized shape, and its absence must render fine everywhere; (b) **never persisted** —
   it lives only in the tracker's in-memory state and the `thread:status` push, never in the
   event log or snapshots; (c) **never an input to conversation state** — the renderer's reducer
   remains the only interpreter of conversation content. The moment a headline would need
   conversation semantics (e.g. summarizing across items), it stops being main's job — that
   variant is rejected below.

7. **Notification policy is a pure module in main; defaults are tuned against fatigue.**
   A pure `notification-policy` function (inputs: a status transition, window-focused state,
   the active/visible `threadId`, per-kind user preferences; output: a notification descriptor
   or `null`) with `index.ts` as thin wiring — the same pure-core/thin-shell pattern as
   `ThreadStatusTracker` and the app-update module. Pinned defaults: **Permission requests
   always notify when the window is unfocused or the Thread is not the one on screen; turn
   completions are OFF by default** (opt-in, with a minimum-turn-duration threshold so trivial
   turns never notify); the eviction of a needs-attention Thread notifies; **nothing ever
   notifies for the Thread currently visible in a focused window**. Multiple simultaneous
   needs-attention Threads coalesce into one "N agents need you" summary notification instead
   of a burst. Notification bodies carry Thread title + Workspace name (from the metadata
   store); click-to-activate focuses the window and navigates via a new `notify:activate`
   main→renderer push feeding the existing nav reducer — the same pattern as `menu:action`.
   Click-through to a Thread whose agent was evicted rides the existing lazy re-warm
   (`agent:evicted` → re-warm on select) and gets an explicit test. The macOS dock badge shows
   the count of needs-attention Threads, cleared as statuses resolve. macOS notification
   permission is requested on the **first relevant event**, not at launch, and denial degrades
   gracefully (badge and tray still work).

8. **The tray renders purely from tracker snapshots; it is never a second stateful UI.** A
   `src/main/tray/` module subscribes to the same status-change emissions and maps snapshots →
   tray icon state (idle / N streaming / attention) and a menu of active Threads grouped by
   Workspace, via a pure tested mapping function. Menu clicks reuse `notify:activate`. The tray
   holds no state of its own, so it cannot drift from the sidebar. **Explicitly deferred, not
   decided here:** "close the window, agents keep running" changes the app lifecycle contract
   and interacts with warm-pool eviction protection and the updater's install-on-quit path — it
   requires its own ADR; tray v1 operates with the window alive (possibly unfocused/minimized).

9. **Mission Control is a routed outlet view, read-only plus existing verbs.** It joins the nav
   reducer's view union (like Settings and Skills) with a keyboard shortcut (⌘⇧K — ⌘K stays the
   Search palette), showing one row per active/recent Thread across ALL Workspaces: live state,
   elapsed-turn timer (from `turnStartedAt`, reusing the existing working-time logic),
   `activityHeadline`, Stop, jump-to-Thread, and inline Permission triage (from the
   `pendingPermission` summary, answered through the one relay of Decision 5). Its verbs are
   strictly the ones that already exist — answer a Permission request, cancel a turn, navigate;
   **no new agent control surface**. It must render usefully with zero warm agents (cold
   Threads from the metadata store), honoring the process-free-reopen principle. The renderer
   side is a pure fleet model module (fold `thread:status` events + Thread metadata into rows)
   with thin JSX. Process vitals (RSS/CPU sampling of `vibe-acp` children) are **out of this
   epic** — deferred until a concrete need, so Mission Control v1 adds zero new sampling in main.

10. **Sequencing gate:** notification, badge, tray, and Mission Control slices may ship on the
    accepted decisions 5–9 alone. The Firewall slice ships only after the Decision 3 spike has
    captured live payload shapes, and its first release keeps matching to the conservative v1
    surface (tool kind + command prefix/exact + path glob).

## Considered options

- **Blanket `auto-approve` Mode as the answer to interruption fatigue** — rejected. It is
  Vibe-owned, all-or-nothing, and precisely the thing users who have watched an agent attempt a
  destructive command refuse to enable. The Firewall exists to be the audited middle ground; it
  composes with Mode instead of replacing it.
- **Firewall rules in the renderer** — rejected. Background Threads have no mounted view; the
  renderer can be closed to a minimized window while five agents run. Main owns the permission
  relay and sees every request first; policy that must fire unattended belongs beside it
  (same reasoning that put `ThreadStatusTracker` in main).
- **Letting rules select `allow_always` options** — rejected. A single rule match must never
  widen the agent's standing grants; session-scoped approval is a deliberate human click. Rules
  get breadth only through their own visible match patterns.
- **Regex / full shell-grammar command matching in v1** — rejected. Quoting, chaining, and env
  tricks make command-string parsing a security-theater footgun; conservative prefix/exact
  matching with deny-wins ordering is honest about what it can promise. Revisit only with
  evidence that prefix matching is too coarse in practice.
- **Main owns full fleet/conversation state (supersede ADR-0001)** — rejected. ADR-0001 already
  names durable-history/multi-window as its revisit triggers; a presentation headline is not
  that trigger. The shape-probe copy (Decision 6) gets fleet rows without a state-ownership
  migration nobody needs yet.
- **Deriving fleet rows renderer-side by mounting every live Thread** — rejected; this is
  literally the "option 1" the `ThreadStatusTracker` header documents rejecting (unbounded
  `acp:event` listeners + reducers per Thread).
- **A separate `fleet:status` channel with its own snapshot/delta protocol** — rejected for this
  epic. `thread:status` + `getThreadStatuses` already have exactly that shape; extending the
  payload keeps one source of truth instead of two channels that can disagree. Revisit if
  process vitals (a genuinely different cadence: sampled, not event-driven) ever ship.
- **Tray with its own state / background-running lifecycle now** — rejected here; deferred to a
  future ADR (Decision 8) because it changes the quit contract and interacts with eviction
  protection and install-on-quit.
- **Asking Vibe to own approval policy upstream** — not available. ACP has no policy surface in
  our capture; the client is the only place a user-owned answering policy can live today. If ACP
  ever grows one, the Firewall's rule store migrates behind the same seams.

## Consequences

- The app gains its first OS-integration surfaces (Notification, dock badge, Tray). All decision
  logic stays in pure, unit-tested modules (`notification-policy`, tray mapping, Firewall
  predicate, fleet model) with `index.ts`/thin wiring — the established pattern — so the
  OS-dependent shells stay skinny and the vitest suite (node env, no DOM) covers the behavior.
- `ThreadStatus` grows optional presentation fields. They are additive and optional, so the
  sidebar's existing consumers are untouched; anything rendering them must tolerate absence.
- A new SQLite table (Firewall rules) arrives via a forward-only migration (ADR-0019 rules
  apply: fail-closed on newer `user_version`, best-effort writes). A new transcript entry kind
  (auto-answer audit) means a `REDUCER_SCHEMA_VERSION` bump when the renderer learns to fold it.
- The permission relay becomes idempotent (first answer wins). This is a strict hardening of
  today's behavior; the only observable change is that a double-answer race no longer sends a
  duplicate JSON-RPC response to the agent.
- A misauthored allow rule remains a real footgun even with the guard-rails; the mitigations are
  visibility (named rules, dimmed audit rows, the per-turn pill, the kill-switch) and the
  `allow_once`-only constraint. This is an accepted, documented risk — the alternative (no
  middle ground between clicking forty times and `auto-approve`) is worse.
- Mission Control invites running more concurrent agents, which will pressure the pool cap
  (`MAX_WARM_AGENTS`) and eviction protection (ADR-0006). Making the cap adaptive or
  user-configurable is explicitly out of this epic; the epic makes the pool's behavior *visible*
  first, which is the prerequisite for tuning it.
- The Away/remote-companion direction inherits a ready substrate: a single status payload with
  headlines and answerable permission summaries, one idempotent resolve path, and an audited
  policy layer — none of which will need rework to be consumed by a second (remote) surface.
