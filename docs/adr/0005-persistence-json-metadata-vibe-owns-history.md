# Persistence: JSON metadata + a per-Thread JSONL transcript we own; Vibe owns agent context

> **Engine decision superseded by ADR-0019** (2026-07-03, #292): the deferred-SQLite trigger named
> below — full-text queries at scale — fired with transcript search (#174). Storage moves to
> `node:sqlite` (event log + projections); the three-way ownership split here still governs.

vibe-mistro needs Workspaces and Threads to survive a restart: reopen the app and your
Workspaces, their Threads, titles, last-active order, **and the visible conversation** are
back — instantly, without spawning an agent. This ADR fixes the storage primitives for that
backbone.

We split the persisted data **three** ways, by owner and volume:

1. **Workspace + Thread metadata — OURS, small.** A handful of Workspaces, each with up to
   dozens-to-hundreds of Threads; each record is a few fields (Workspace: dir, display name,
   last-opened; Thread: minted id, bound ACP `sessionId` resume cursor, title, created/last-active,
   selected model/mode). The main process is the **single writer**; no joins, no query SQL would earn.
2. **The visible conversation transcript — OURS.** A **minimal append-only log, one JSONL file per
   Thread.** The main process tees the streamed `session/update` events (and the user's own prompts)
   to the Thread's log as they flow. On reopen we **replay the log through the existing renderer
   reducer** (ADR-0001) to rebuild the conversation view **without spawning `vibe-acp`**.
3. **Agent context / memory — VIBE's.** `vibe-acp` advertises `agentCapabilities.loadSession: true`
   (`docs/acp-capture.md` §1) and the CLI has `--continue` / `--resume <SESSION_ID>`. To let the agent
   *continue* a conversation with its prior context, we `session/load` the stored `sessionId`. The
   agent's runtime memory is not ours to store — only its *rendered output* (item 2) is.

**Decision:**

1. Persist Workspace + Thread **metadata as JSON** owned by the main process (a small store in
   `userData`). No database.
2. Persist each Thread's visible history as an **append-only JSONL transcript** (one file per Thread,
   keyed by the minted Thread id). Render a reopened Thread by replaying its JSONL through the reducer —
   process-free and instant. **Not SQLite.**
3. Bind a Thread to its ACP session via the stored `sessionId` (a resume cursor). To continue a
   conversation, spawn the Workspace agent and `session/load` that `sessionId`. **On a resume failure**
   (session missing/rotated/changed server-side), **re-bind the Thread to a fresh `session/new`** and
   show an honest notice that the *agent's* context was reset — the **visible history remains** (it is
   read from our JSONL, not from the agent). The Thread survives; only agent memory restarts.
4. **Defer `better-sqlite3` (or any native DB) until a feature concretely needs it** — relational or
   full-text queries at scale (e.g. search across thousands of Threads). The JSONL→SQLite migration is
   bounded (small metadata + per-Thread logs) and deliberately kept that way by not starting there.

**Why own the transcript (the revision):** the mature references we studied **all** own their
transcript (typically a SQLite event log or message table — opencode's `SessionMessageTable` is one)
and all mint their own ids and lazy-load (metadata list, transcript on open). Owning the transcript is
what makes thread UX robust: instant process-free reopen, survivable session loss, and a basis for
future search. We adopt **own-id + lazy + own-transcript**, but **right-size the engine to JSONL** for
a single-user, single-provider app with no native-dependency budget. The minimal shape is "a single
session row per Thread + an append-only message log".

**Spike, now de-risked:** `session/load` replay is still marked "to verify" in the capture doc. It no
longer gates the reopen UX — we render from our JSONL regardless — so the spike only confirms whether
the *agent* can resume context; if it can't, we re-bind fresh and the user still sees their history.

## Considered options

- **Rely solely on Vibe's `loadSession`, own NO transcript** (this ADR's first draft) — rejected.
  Nothing to render on a lost session, reopen always requires spawning the agent, no basis for search,
  and it is the outlier versus both references. It also forced an unappealing "dead/read-only Thread"
  behavior on resume failure because there was no history to show.
- **`better-sqlite3` (transcript + metadata) from day one** — deferred. Real query power and cheap
  incremental appends, and it is what the reference apps use, but it is a **native addon** requiring an
  Electron-ABI rebuild in packaging — the same native-build tax we declined for `openat` in #21
  (ADR-0004) — and it over-provisions for our scale. Adopt when a feature (search) justifies it.
- **JSON metadata + per-Thread JSONL transcript + Vibe for agent context** (chosen) — owns the display
  history without a native dependency, keeps the metadata store trivial, and lets a lost ACP session
  re-bind gracefully with history intact. Revisited only when a concrete feature outgrows JSONL.

## Consequences

- The main process gains a **transcript write path**: it tees `session/update` events (and echoed user
  prompts) to the active Thread's JSONL as they stream. Append-only; flush discipline TBD in the slice.
- Our transcript is a faithful record of *what streamed*; after a re-bind the agent's context is fresh,
  so the visible history can be "ahead of" the agent's memory. Surface this honestly — never imply the
  agent remembers what only our log retains.
- **Reopen renders from JSONL with no `vibe-acp` process**; spawning + `session/load` happens only when
  the user continues the conversation (consistent with the metadata-first, lazy-per-Thread reopen flow).
- The persisted Thread record holds the ACP `sessionId` as the resume cursor; a re-bind updates it.
- Migrating to SQLite later imports small JSON metadata (easy) and per-Thread JSONL (bounded) — a
  deliberately small migration.

## Amendment (2026-07-02, #203): reopen is resume-on-first-prompt, no Continue step

The explicit **Continue** affordance (read-only `ColdThread` replay + a button to promote it live) was
removed from the primary flow. Clicking a Thread in the sidebar now opens it **ready to resume**:

- **Connected Workspace**: the Thread is hosted live immediately — the conversation renders from JSONL
  (process-free for the Thread, the Workspace agent is already warm), the composer is enabled, and the
  Thread's FIRST prompt drives the `session/load` resume via `ensureBoundSession` (re-bind + "context
  reset" notice on failure). Reading old chats still touches no session.
- **No connection yet** (cold app start / evicted agent): the click auto-continues — the same
  `startThread({continueThreadId})` the button fired. This trades the "browsing never spawns" purity
  for one-click reopen; clicking a Workspace row already spawned its agent, so a Thread click matching
  that is consistent. The launch list itself is still served entirely from our stores.

`ColdThread`/`ColdOutlet` remain as edge-state fallbacks only. The "reopen renders from JSONL" bullet
above still holds for the connected case — what changed is that no user-visible Continue step gates the
live view.
