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

## Considered alternatives

- **Persist the selection per-Thread in our metadata (committed on the thread +
  pending on the composer draft, `composer ?? thread ?? default`).** Rejected as the default: it
  duplicates state Vibe already tracks and risks drift; we adopt it only as the spike-contingent
  fallback if Vibe doesn't preserve Mode across reload.
- **Per-turn Model switching** ("use model X for this message"). Rejected: fights ACP's sticky
  session-state model and introduces a per-turn override concept we don't otherwise have.
