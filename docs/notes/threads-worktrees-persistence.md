# Reference multi-agent GUI: Threads, Worktrees & Local Persistence — Findings

> Investigation notes on a production Effect-TS multi-agent GUI we studied (2026-07-01). Specific
> file references to that codebase have been removed; the architectural findings stand alone.

## Q1: Is each thread a git worktree?

**No.** A thread is an orchestration/projection entity that belongs to a project
(`projectId`) and carries an **optional, nullable `worktreePath`**. Thread → worktree is a
*zero-or-one* reference (by filesystem path); worktree → threads is *one-to-many*.

### Three possible states for a thread
1. **Own worktree** — dedicated git worktree + temporary branch (a namespaced `<prefix>/<hex>`).
2. **Shared worktree** — multiple threads point at the same `worktreePath`.
3. **Local mode** — no worktree; runs in the project root checkout (`workspaceRoot`).

An env-mode toggle in the branch toolbar lets the user pick **"local"** vs **"worktree"** per
thread.

### Key mechanics
- The thread shell shape carries a nullable `worktreePath` + `branch`; the projection layer
  exposes them as read-model columns.
- A worktree is prepared only on the thread's **first message**, when the send env-mode is
  `"worktree"` and no path exists yet; the server creates the worktree and writes path/branch
  back onto the thread.
- The actual git call is `git worktree add -b <branch> <path> <ref>`, with
  path `worktreesDir/<repoName>/<sanitizedBranch>` and a namespaced branch prefix.
- When a thread has no worktree, execution falls back to the project root:
  `workspaceRoot = thread.worktreePath ?? project.workspaceRoot`.
- Sharing is real: the orphan-cleanup check skips worktrees still referenced by other threads.

### Git isolation
Opt-in per thread. "worktree" mode → dedicated worktree/branch (isolated cwd + branch).
"local" / reused path → shares the checkout, no per-thread isolation. The same
`worktreePath` flows into terminal sessions and setup-script execution.

---

## Q2: How does the reference app save threads & conversations locally?

**One SQLite file, event-sourced (CQRS).** A single `state.sqlite` under the app's home dir
(+ `-wal` / `-shm` sidecars, WAL mode).

### Storage engine
SQLite via Effect's `unstable/sql`. Driver picked at runtime:
- Bun → `@effect/sql-sqlite-bun/SqliteClient`
- Node → a local client wrapping `node:sqlite`
  (`DatabaseSync`; needs Node >=22.16/23.11/24)

On connect: `PRAGMA journal_mode = WAL`, `PRAGMA foreign_keys = ON`, then run migrations.
No JSON/LevelDB store for chat data.

### Architecture — event sourced, not a plain row store
1. **Append-only event log** → an `orchestration_events` table.
   Immutable rows; global `sequence AUTOINCREMENT` + per-stream `stream_version` with optimistic
   concurrency (unique on `(aggregate_kind, stream_id, stream_version)`). Store only INSERTs /
   reads forward.
2. **Projector** folds events → read-model tables, tracking a per-projector cursor
   `last_applied_sequence` in a `projection_state` table.
3. **Read side** queries the projection tables to build UI snapshots.

Flow: commands → append events → project into `projection_*` → snapshot queries read them.

### Main read-model tables
- `projection_projects`
- `projection_threads` — `thread_id PK`, `project_id`, `title`, `model`, `branch`,
  `worktree_path`, `latest_turn_id`, timestamps, `deleted_at` (indexed by `project_id`)
- `projection_thread_messages` — `message_id PK`, `thread_id`, `turn_id?`, `role`, `text`,
  `is_streaming`, timestamps; `attachments_json` added in a later migration. Ordered history via
  an index on `(thread_id, created_at)`
- `projection_turns` — one request/response cycle; `UNIQUE (thread_id, turn_id)`
- `projection_thread_activities` (tool calls), `projection_thread_sessions` (live session state)

Messages are written by idempotent upsert `INSERT ... ON CONFLICT(message_id) DO UPDATE`,
so streaming assistant text repeatedly upserts the same row. A message links to its conversation
via `thread_id` and its cycle via `turn_id`.

### On-disk path config
- A server-config module derives `stateDir = baseDir/{userdata|dev}` and
  `dbPath = stateDir/state.sqlite`
- The default `baseDir` is a dotdir in `$HOME`; overridable via a CLI flag / env var
- The SQLite layer reads `dbPath` off the server config; a `:memory:` variant serves tests

### Migrations
Numbered migration modules (32 at time of study), run via Effect `Migrator`
(tracking table `effect_sql_migrations`).

---

## Q3: vibe-mistro persistence vs the reference, and the adoption path

### What vibe-mistro does today (`/Users/abdullahatrash/mistral/vibe-mistro`)
Purely files, **no database** (design in `docs/adr/0005-persistence-json-metadata-vibe-owns-history.md`).
Single-writer: only the Electron main process mutates; renderer is pure.

- **`metadata.json`** — one flat index file: `{ workspaces[], threads[] }` (`src/main/persistence/metadata-store.ts`).
  - `WorkspaceMeta` = `{ id, dir, displayName, lastOpenedAt }` (keyed by absolute `dir`)
  - `ThreadMeta` = `{ id, workspaceId, sessionId, title, createdAt, lastActiveAt }` (`src/shared/ipc.ts:570`)
  - **No messages here** — it's a light index. Atomic write via tmp + `fs.rename` (`metadata-store.ts:186`).
- **`transcripts/<threadId>.jsonl`** — one append-only JSONL per thread (`src/main/persistence/transcript.ts`).
  - Each line is a `TranscriptEntry` union: `user-prompt | acp-event | turn-complete | turn-error |
    resolve-permission | agent-rebound` (`ipc.ts:598`)
  - Replayed through the renderer's `conversationReducer` on reopen to rebuild the view.
- Rooted at Electron `userData` (`app.getPath('userData')`, macOS `~/Library/Application Support/vibe-mistro/`),
  derived in `src/main/index.ts:1004-1019`. Project dirs are referenced only by absolute path in metadata.
- Store modules: `metadata-store.ts` (`load`/`persist`/`upsertWorkspace`/`upsertThread`/`deleteThread`),
  `transcript.ts` (`append`/`read`/`delete`, per-thread promise-chained appends), `delete-thread.ts`.

### Head-to-head

| | vibe-mistro | reference app |
|---|---|---|
| Store | JSON index + per-thread JSONL | single SQLite `state.sqlite` (WAL) |
| Model | metadata rows + append-only transcript | event log + projected read tables (CQRS) |
| Source of truth | the JSONL transcript | `orchestration_events` (immutable) |
| Read model | rebuilt in renderer reducer at open | `projection_*` tables, cursor-tracked |
| Queries | load whole file, filter in JS | SQL (indexed by project/thread/turn) |
| Schema evolution | ad-hoc shape-filtering on load | numbered migrations (`Migrator`) |

**Key insight:** vibe-mistro already has the important half of the reference design — an append-only
event stream (its JSONL *is* the log; `TranscriptEntry` ≈ an event). What's missing is (1) a queryable
projected read-model and (2) formal migrations. So this is less of a rewrite than it looks.

### Adoption path (staged, each stage shippable)

**Stage 0 — scope.** Likely don't need full CQRS. Real wins: SQL queryability, indexed lists,
migrations. Target "SQLite + a projections layer," not "adopt the whole Effect orchestration engine."

**Stage 1 — SQLite behind the existing store interface.**
- Add `node:sqlite` (Node ≥22.16, as the reference's Node client does) or `better-sqlite3`.
- Keep `MetadataStore`/`TranscriptStore` public methods identical; swap bodies for SQL. IPC/renderer unchanged.
- On open: `journal_mode=WAL`, `foreign_keys=ON`.
- _Captures ~80% of the durability benefit for ~10% of the effort._

**Stage 2 — port the event log.**
- Table `events(sequence INTEGER PK AUTOINCREMENT, thread_id, stream_version, type, payload_json, created_at)`
  = the JSONL, one row per `TranscriptEntry`. `append()` → INSERT.
- Optional `UNIQUE(thread_id, stream_version)` for optimistic concurrency — probably skip initially
  given single-writer.

**Stage 3 — projection tables + projector.**
- `projection_threads`, `projection_thread_messages`, `projection_turns` (crib the reference's
  projection-table shapes), plus `projection_state(name, last_applied_sequence)`.
- Projector folds events → tables; messages via idempotent
  `INSERT ... ON CONFLICT(message_id) DO UPDATE` for streaming.
- `listMetadata` becomes an indexed SQL query instead of load-whole-JSON + filter.

**Stage 4 — migrations + one-time importer.**
- Adopt a numbered-migration runner (Effect `Migrator`, or a tiny `PRAGMA user_version` one).
- Importer reads existing `metadata.json` + every `transcripts/*.jsonl`, replays into `events`,
  rebuilds projections. Keep JSON files as backup for one release.

**Pragmatic stopping points:** Stages 1–2 alone give atomic multi-thread writes, crash safety, and
cross-thread queries without a projector. Stages 3–4 add the fast indexed read-model and safe schema
evolution. Full Effect-style CQRS is optional — only worth it at the reference's scale/concurrency.

**Caveat:** vibe-mistro's current design is clean, documented, single-writer. Justify the migration by
real pain: (a) large-JSON load/filter getting slow, (b) wanting relational cross-thread/turn queries,
(c) schema-evolution churn. If none bite yet, do Stage 1 and stop.

---

## Decision log — grill session 2026-07-01 (branch `docs/persistence-adoption`)

**Persistence migration: DEFERRED, per ADR-0005.** Re-evaluated adopting the reference's SQLite +
event-sourcing. Verdict: no fired trigger.
- Search (0005's stated trigger) is a *future* feature, not present → not yet.
- The "slow cold-start" symptom was traced and is **NOT** a storage problem: launch reads only the small
  `metadata.json`; zero JSONL is touched at startup; transcripts load lazily on thread-open. SQLite would
  not fix it. Real suspects live outside persistence (`vibe-detect` `execFile`, bundle startup, lazy
  agent spawn, per-open replay). *Separate investigation if cold-start is worth chasing.*

**Instead: hardened the seam (done this session).**
- **Seam audit: clean.** All `metadata.json` / `*.jsonl` access is funneled through `MetadataStore` /
  `TranscriptStore`; path derivation single-sourced in `index.ts:1007/1013`; single-writer (main) holds;
  renderer/preload go through IPC only. The SQLite swap is genuinely drop-in (reimplement the two classes
  behind their injected `deps`). Added a SEAM CONTRACT comment atop each store to keep it that way.
- **Metadata versioning + fail-closed.** `metadata.json` is now a `{ schemaVersion, workspaces, threads }`
  envelope (`METADATA_SCHEMA_VERSION = 1`; legacy files read as v1). A file with a *newer* version
  **locks** the store: `load()` refuses to load and `persist()` becomes a no-op, so an older build can
  never atomically overwrite (wipe) newer data. `isLocked()` exposed for a future UI notice.
- **Transcript versioning.** Each log's first line is a version header
  (`TRANSCRIPT_SCHEMA_VERSION = 1`), written once, restart-safe (checks file contents), skipped on replay.
  `transcriptVersionOf(raw)` for future migrators; legacy header-less logs read as v1.

**Empty-thread bug: confirmed + specified fix (ADR-0011 written, code fix pending).**
- Opening a Workspace persists an empty Thread (`startThread` → `openThread()` + `recordThread()`,
  `index.ts:671`). The #58 draft fix (`85e95ef`) only ever covered the + button.
- Decision: **Option 1** — Workspace-open creates a renderer-only Draft (like the + button); defer both
  `session/new` and persistence to first prompt. Workspace metadata still persists on open; only the
  Thread defers. Captured as the **Draft Thread** term (CONTEXT.md) + **ADR-0011**.
- ✅ Code fix IMPLEMENTED. `startThread`'s normal branch (and the post-sign-in `openThread` handler) now
  return a `draftConnection` — mint a Thread id, no `session/new`, no `recordThread` — mirroring the
  proven `continueConnection` session-less shape. First prompt binds + persists via `mintAndBind`. Dead
  `recordThread` / `connectionFor` / `ThreadIds` removed. Renderer unchanged (reducers already handle a
  draft connection via the Continue flow). Typecheck clean, 501 tests green.
- Controls note: vibe-acp only advertises Mode/Model/effort via `session/new`, so the first draft's
  picker is empty until first prompt — same as the existing Continue flow, not a new regression. An
  agent-level controls cache (deferred) would populate it after any Thread runs once. See ADR-0011.

**Docs touched:** `CONTEXT.md` (Thread + new Draft Thread terms), `docs/adr/0011-*.md` (new),
`src/main/persistence/{metadata-store,transcript}.ts` (+ tests). All 501 tests green, typecheck clean.
