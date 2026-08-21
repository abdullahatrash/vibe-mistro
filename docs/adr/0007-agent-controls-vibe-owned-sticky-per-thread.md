# Agent controls (Mode / Model / Reasoning effort) are Vibe-owned, sticky per-Thread, and display-from-session-state

**Agent controls** — a Thread's **Mode** (collaboration/approval posture: `default`/`chat`/`plan`/`auto-approve`),
**Model** (which LLM), and **Reasoning effort** (`thinking`: off…max) — are surfaced from `session/new`
(and `session/load`), changed mid-Thread via Vibe's config-option method, and **owned by Vibe at
runtime**: we display whatever the session reports and relay changes, rather than persisting the
selection in our metadata store. They are **sticky per-Thread** (set once, hold until changed — matching
ACP's session-state model), not per-turn.

## Decisions

- **Scope:** the three ACP-native axes only (Mode, Model, Reasoning effort), grouped as Agent controls.
  Out: a separate access/runtime-mode axis (covered for us by `default` mode gating writes +
  fs confinement, ADR-0004) and the `/fast` service tier (no ACP surface in our capture).
- **Ownership / persistence:** Vibe owns the live value; we render it from `session/new`/`session/load`
  and do NOT persist it as authoritative in our metadata store (ADR-0005: Vibe owns session state, we
  own only the durable Thread id, resume cursor, title, transcript). A cold (un-resumed) Thread simply
  shows no Mode until opened.
- **Change flow:** renderer initiates → main relays the change method (like `respondPermission`) → the
  agent is authoritative for the new current value, ideally via a `current_mode_update` `session/update`
  the renderer folds into the connection's `modes`/`models` (NOT the conversation reducer, which holds
  items). Optimistic update is the fallback if no notification is emitted.
- **Timing:** between-turns only for the first slice (controls disabled while a turn is in flight, like
  the send button). A Mode change is **forward-acting** — it never retroactively auto-resolves a pending
  Permission request (auto-approving without the user's click would be a trust-violating side effect).
- **Pre-session:** a #58 renderer-only draft has no session, so Agent controls are enabled only once the
  Thread is bound (after first prompt); a draft starts under Vibe's defaults. A draft-level pending
  selection (extending the #60 composer-draft store) is a deferred follow-up.

## Status: spike resolved (#65, 2026-06-30) — the cache-and-re-assert fallback applies

The #65 spike captured the change mechanism against vibe-acp 2.18.0 (acp-capture §10). Outcome:
- **Change methods are three distinct calls**, not one `set_config_option`: Mode → `session/set_mode
  {sessionId, modeId}`; Model → `session/set_model {sessionId, modelId}`; Reasoning effort →
  `session/set_config_option {sessionId, configId, value}` (note `configId`, not `id`). All return `{}`.
- **No change-notification** is emitted ⇒ the renderer updates the displayed value **optimistically**
  (revert on error). The "agent-authoritative via `current_mode_update`" path in the change-flow decision
  above does NOT exist on vibe-acp 2.18.0 — optimistic is the primary path, not the fallback.
- **Mode is NOT preserved across `session/load`** (set `plan`, reload → `default`) ⇒ the **fallback is
  now the required design**: the picker caches the selected Mode (and Model) per-Thread and re-asserts
  via the setters after a resume. This is the one place Agent-controls state touches our side; it stays
  out of the durable metadata store unless we choose otherwise.
- ⚠️ `session/set_model` false-accepts any string as a `modelId` — pass only `availableModels` ids.

## Amendment (#427, 2026-08-19) — vibe-acp 2.24.1 moved all three axes onto one setter

Re-captured against the installed 2.24.1 binary (acp-capture §14.0). The three-distinct-calls finding
above is **stale**; the decision (Vibe-owned, display-from-session-state, sticky per-Thread, optimistic
reflection, re-assert after resume) is unchanged. What changed underneath it:

- **One setter for every axis:** `session/set_config_option {sessionId, configId, value}` with
  `configId` = `mode` / `model` / `thinking`. `session/set_model` was **removed** (`-32601`), and
  `session/set_mode` still exists but **silently no-ops on an unknown id** (returns `{}`), so it is now
  a fallback for agents that advertise no `mode` config option — never the preferred path. The config
  setter validates (`-32602 "Unsupported config option …"`), which matters most for the re-assert-
  after-resume choreography, where a silent no-op would leave the Thread in the wrong posture.
- **Model is no longer a top-level `session/new` block** — it lives only in `configOptions[id="model"]`
  (`currentValue` + `options[].value`). We read every axis from `configOptions`, with the 2.18 top-level
  blocks kept as a fallback (`src/main/acp/agent-controls.ts`).
- **Mode ids changed:** `default` → `ask`, and `chat` is gone. Nothing may hardcode an id; the Side
  Draft's read-only posture now prefers `plan` (`src/renderer/src/connection/side-thread-controls.ts`).
- Both drifts failed **silently** (a hidden picker, a dead setter). `missingControlAxes` now logs any
  axis the agent stops advertising, so the next drift leaves a trace instead of vanishing.

## Amendment (#448, ADR-0027, 2026-08-21) — Mistro Bot profiles are filtered out of the Mode picker

A **Mistro Bot**'s persona is a Vibe agent profile we generate, and Vibe publishes *every*
`AgentType.AGENT` profile as a selectable mode. Left alone, every Bot a user owns would appear in
every ordinary Thread's Mode picker, beside `ask` and `plan` — a list of approval postures filling up
with teammates. Hiding them Vibe-side is impossible: `_is_primary_mode` re-derives from
`build_mode_state`, so the presentation filter **is** the authorization gate (probed, #424).

So the Mode picker **omits every `mistro-bot-<uuid>` id** — client-side and deliberate
(`src/renderer/src/conversation/ordinary-modes.ts`, applied in `AgentControls`). This is a departure
from display-from-session-state, and it is recorded here rather than assumed: the principle forbids
**inventing** or **staling** state, not presenting a known subset. Nothing is fabricated, nothing goes
stale, and the ids removed are only ever ones we minted — the `mistro-bot-<uuid>` shape is a
mechanical ownership test, so a hand-written profile of the user's is never hidden from them.

Two related consequences of the same design, for the reader who arrives here from the picker:

- A **Bot's own** conversation shows no Mode, Model or reasoning-effort picker at all. Its persona is
  selected on the Mode axis, so a Mode picker would offer `plan` as a peer of the personality — and
  picking it would silently switch the Bot off while it kept its name, row and history.
- The re-assert-after-resume choreography above is **in-memory by design**, which is right for a
  Thread and not enough for a Bot: a cold restart has no cache. A Bot's `profile_id` is therefore
  durable in our store and re-asserted on **every bind that produces a fresh session result** — a
  mint, a re-bind, or a `session/load` resume (`src/main/bots/select-bot-profile.ts`). A plain reuse
  of a session already bound this run is skipped, which is only safe because a Bot never binds to a
  session that could not host its persona in the first place (it declines the eager primary session
  unless that session advertises the profile). The re-assertion goes through `WorkspaceAgent.setMode`,
  which prefers the **validating** `session/set_config_option` wherever the session advertises the
  `mode` config option — every 2.24.x binary does, and 2.24 is our floor. The qualifier matters: the
  same method falls back to `session/set_mode` for a session that advertises no such option, and that
  method's silent no-op on an unknown id would leave a nameless agent wearing a teammate's name. When
  the profile is absent from the session's advertised modes, the app says so (banner + rebuild)
  instead of quietly proceeding.

## Considered alternatives

- **Persist the selection per-Thread in our metadata (committed on the thread +
  pending on the composer draft, `composer ?? thread ?? default`).** Rejected as the default: it
  duplicates state Vibe already tracks and risks drift; we adopt it only as the spike-contingent
  fallback if Vibe doesn't preserve Mode across reload.
- **Per-turn Model switching** ("use model X for this message"). Rejected: fights ACP's sticky
  session-state model and introduces a per-turn override concept we don't otherwise have.
