# Mistro Bots: a durable Thread backed by a Vibe agent profile, native to the sidebar

**Status: PROPOSED** (2026-08-19, #419 → #426). Builds on **ADR-0002** (thin orchestrator — we
configure Vibe, we never reimplement it), **ADR-0005/0019** (persistence ownership and the SQLite
event log), **ADR-0006** (the warm-agent pool and the pure nav reducer), and **ADR-0007** (Agent
controls are Vibe-owned and displayed from session state — **this ADR amends its scope claim**, see
Consequences).

## Context

Every Thread starts from nothing. A user who works with the same project daily re-explains its shape
on every new chat, and the app has no concept of a continuing relationship with an agent — only of
individual conversations. The idea arrived from Rakazo, which models persistent "bots" as
first-class teammates; the question this ADR settles is what that can honestly mean in a **local,
single-user, thin-orchestrator desktop app** that drives an external agent it does not own.

Nine wayfinder tickets (#420–#442) settled it, two of them empirical probes against the live
`vibe-acp` binary. The findings that constrain the design:

- **There is no system-prompt parameter in ACP.** `session/new` takes `{cwd, mcpServers}`. Persona
  cannot be passed at session creation.
- **Vibe has user-authorable agent profiles**, and every `AgentType.AGENT` profile — builtin or
  custom — is published over ACP as a selectable **mode** (`build_mode_state`, verified at 2.24.1).
  A profile can name a custom `system_prompt_id` `.md`. This is Vibe's own mechanism for what we
  need.
- **Compaction always preserves system messages.** A persona living in a system prompt does not
  drift, however long the conversation runs.
- **Mode does not survive `session/load`**, and the app's re-assert cache is deliberately in-memory
  only (ADR-0007).
- **Hidden-but-selectable profiles are impossible**: `_is_primary_mode` re-derives from
  `build_mode_state`, so the presentation filter *is* the authorization gate.

## Decision

**A Mistro Bot is one continuing Thread inside an existing Workspace, whose persona is a Vibe agent
profile that we generate and own, surfaced as a section of the app's existing sidebar.**

Five parts, each load-bearing:

1. **A Bot is one continuing conversation, not a persona you start Threads from.** It maps to a
   single durable Thread; you return to it for weeks. Continuity — not specialisation — is the job.
2. **A Bot lives inside an existing Workspace.** `session/new` requires a `cwd`, and a Bot that knows
   *this project* is the point. Consequence, accepted: **a Bot cannot exist without a Project.**
3. **The persona is a Vibe agent profile we generate**: a TOML in `~/.vibe/agents/` plus a custom
   system prompt in `~/.vibe/prompts/`, selected on bind via the mode axis. The **Bot record is the
   source of truth and the profile files are a projection of it** — we write them, mark them
   generated, and can rebuild them. Profile ids are `mistro-bot-<uuid>`: generated, immutable, and
   therefore incapable of shadowing a builtin mode.
4. **Sidebar-native.** Bots occupy a bounded, scrollable section above Projects; selecting one swaps
   the outlet to its conversation exactly as a Thread does. There is **no Bots page and no Bots
   BROWSING view** — nothing reachable from a nav row, and nothing that lists Bots outside the
   sidebar. *(Amended in #447, which built the create/edit form: **create and edit are a transient
   outlet view** — `nav.view === 'bot-form'`, with no list, no nav row and no way to reach it except
   the section's ＋ or a Bot's Edit, cleared by any selection. The original wording said "no fourth
   outlet view", which would have forbidden the roomy form the same design requires; the thing it
   meant to forbid — the top-level `view: 'bots'` with its second list column, killed in #422 — is
   still forbidden.)* A Bot is hidden from its Project's Thread list but findable in Search.
5. **A Bot's behaviour is its profile.** Model, Mode and reasoning effort are all changed by editing
   the Bot, never by a per-Thread control — so none of the three pickers appear on a Bot.

Everything below the identity layer is unchanged: the warm-agent pool, thread-binding, the transcript
tee, `thread:status`, and tiered replay all serve a Bot exactly as they serve a Thread. **A Bot's turn
is an ordinary Thread turn.**

## Consequences

**ADR-0007 is amended, not overturned.** Its decision (Vibe-owned, display-from-session-state, sticky
per-Thread, optimistic reflection, re-assert after resume) stands for Threads. Two corrections:

- Its *scope* claim is wrong for two axes. Verified at 2.24.1: `set_config_option` for `model` and
  `thinking` **rewrites the user's global `~/.vibe/config.toml`**; only `mode` is session-scoped. They
  are user-level settings with a per-session override, not per-Thread state (#434).
- Bot profiles are **filtered out** of ordinary Threads' Mode pickers. That is a deliberate departure
  from display-from-session-state: the principle forbids inventing or staling state, not presenting a
  known subset. Recorded here so the exception is written down rather than assumed.

**A Bot's `profile_id` must be durable.** Mode resets on `session/load` and the re-assert cache is
in-memory, so without this a Bot reopened after an app restart is a nameless agent with no persona and
no signal. This is forced by the code, not chosen.

**The Search exclusion cannot be a store-level filter.** The Thread list and Search share one
expression, so hiding Bots in the store would hide them from Search too. It is a per-row flag, read
differently by each side.

**A Bot's Thread is durable from creation, unlike every other Thread.** The Draft Thread invariant
(`CONTEXT.md`) says a Thread is written to disk only on its first prompt. A Bot's record carries a
`threadId`, so creating a Bot writes the Thread with zero prompts. The carve-out is recorded in the
glossary; the invariant still holds for every Thread a user starts by hand.

**Deleting a Bot keeps its conversation** as an archived Thread and destroys only the identity. The
"Remove project" path must gain the same cleanup — today it drops Threads silently and would orphan
profile files, which would keep appearing as modes for Bots that no longer exist.

**The Bots empty state lives in the sidebar section, not the outlet** (#447). The PRD sketched
"nothing selected → a roomy empty state" in the outlet, which was written before the outlet's other
two states were weighed against it: the app already has an idle hero there, and a Bots-specific
outlet state would be a Bots surface by another name — the thing decision 4 exists to avoid — while
also being unavailable for **Edit**, where a Bot is selected. So the empty state is the section's
own (one line explaining what a Bot is, plus a Create CTA), and the section's ＋ is the create
affordance in every other state.

**A Bot's Project is chosen once and cannot be changed** (#447). Decision 2 says a Bot cannot exist
*without* a Project; this is the stronger consequence the create/edit form made concrete. The live
ACP session is bound to one `cwd`, and a Bot's whole value is that it knows *this* project — one
that changed Project mid-conversation would answer about files it has never seen, with weeks of
history implying otherwise. `BotsUpdateArgs` therefore carries no `workspaceId`, and the edit form
shows the Project read-only, saying why rather than merely locking it. Moving a Bot means making a
new one.

**Vibe validates nothing we write.** Unknown keys in a profile TOML are silently ignored — a typo'd
override loads, works, and quietly lacks the setting. Since we generate these files, we validate them.

**A Bot profile is written `safety = "neutral"`, never wider.** That is Vibe's own `from_toml`
default and the value the `ask` builtin carries, so creating a Bot can never quietly widen what an
agent is allowed to do: tool executions still need approval. Approval posture is **Mode**'s job, and
a Bot is not a way to smuggle one in. (`AgentSafety` is `safe | neutral | destructive | yolo` and
`AgentType` is `agent | subagent` — read from the installed `mistral-vibe` at implementation time,
`vibe/agents.py`, because the #420 probe profile carried neither key and the capture therefore does
not cover them.)

**The override allow-list is exactly `system_prompt_id`.** `AgentProfile.from_toml` pops
`display_name`, `description`, `safety` and `agent_type`, then sweeps every remaining key into
`overrides` — i.e. the whole ~80-field `VibeConfigSchema` is reachable from a Bot's profile. We
deliberately reach exactly one field of it. Model and reasoning effort are the reason: at 2.24.1
`set_config_option` for `model` and `thinking` writes THROUGH to the user's global
`~/.vibe/config.toml` (#434), so a Bot that set them would silently re-point the user's default
model. A Bot configures its persona, not the user's Vibe. Any future addition to this list is an
ADR-level decision, not an implementation detail — validation enforces the list, so it fails closed.

**Bots are visible to the `vibe` CLI**, deliberately: they are ordinary agent profiles in Vibe's own
directory. A rename updates what the CLI shows.

## Considered alternatives

- **A Bot as a reusable persona with many Threads.** Rejected: it is a preset, not a teammate, and
  #379 already covers presets. Continuity is the job.
- **Prompt-text injection instead of a profile.** The original plan. Superseded once profiles were
  verified on the wire: a system prompt is immune to compaction, and injection is not.
- **A top-level Bots page** (prototyped as variants A and B, #422). Both grow a second list column
  beside the real sidebar — three columns of chrome before any conversation. Only visible at real
  density, which is why the variants were mounted in the real shell.
- **Project-scoped profile files.** Rejected on three counts: writes into the user's git repo,
  workspace **trust** gates loading (an untrusted project would silently strip the persona), and
  project-level `.vibe/prompts/` is unverified.
- **Hiding Bot profiles from Vibe rather than from our UI.** Probed and impossible (#424).
- **A per-Bot compaction threshold.** Rejected: an envelope holds up to 20,000 tokens of verbatim user
  messages, so a threshold below that can never be met and guarantees permanent thrash. The only safe
  direction is upward, and the default already has headroom.
- **Autonomy — routines and scheduled turns.** Ruled out of scope: no background daemon, and the
  unattended-permission question is unanswered. #175 remains its own epic.
