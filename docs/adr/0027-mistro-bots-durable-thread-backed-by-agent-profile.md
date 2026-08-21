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
   the outlet to its conversation exactly as a Thread does. There is **no Bots page and no fourth
   outlet view**. A Bot is hidden from its Project's Thread list but findable in Search.
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

**Deleting a Bot keeps its conversation** as an archived Thread and destroys only the identity. The
"Remove project" path must gain the same cleanup — today it drops Threads silently and would orphan
profile files, which would keep appearing as modes for Bots that no longer exist.

**Vibe validates nothing we write.** Unknown keys in a profile TOML are silently ignored — a typo'd
override loads, works, and quietly lacks the setting. Since we generate these files, we validate them.

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
