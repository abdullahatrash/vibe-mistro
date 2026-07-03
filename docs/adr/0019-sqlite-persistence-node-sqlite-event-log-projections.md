# Persistence engine: SQLite via `node:sqlite` — event log + disposable projections

**Status: ACCEPTED** (2026-07-03, #292/#293). **Supersedes the engine decision of ADR-0005**
(JSON metadata + per-Thread JSONL). ADR-0005's three-way ownership split — Workspace/Thread
metadata is ours, the visible transcript is ours, agent context/memory is Vibe's (`session/load`)
— is unchanged and restated here; only the storage engine and the load strategy change.

## Context

ADR-0005 deliberately deferred a database "until a feature concretely needs it — relational or
full-text queries at scale". That trigger has fired: ⌘K transcript search (#174) ships as an
explicit linear scan that reads and prose-parses **every Thread's JSONL on every query**, and
reopening a Thread re-reads and re-folds its entire transcript unless it is one of the last 8 in
the in-memory replay cache. Both costs grow with usage. Every store was written for this swap:
each carries a SEAM CONTRACT comment pinning its public method surface as the migration boundary.

The reference implementation persists with full event-sourcing over SQLite: an append-only,
globally-sequenced event log as the source of truth, read-model tables as disposable projections,
snapshot-then-incremental client sync, denormalized summary columns, WAL — and, notably, the
built-in `node:sqlite` on Node rather than a native addon, and files-on-disk for image bytes.

## Decision

1. **One `state.sqlite` in `userData`, owned by the main process** (no separate server process —
   the reference implementation's process split is transport machinery we don't need; its data
   model works over our existing typed IPC). WAL journal mode, `synchronous=NORMAL`, foreign keys
   ON. Main stays the single writer; synchronous queries on the main thread are microseconds-per-
   write at our scale (spike numbers below). If that ever changes, the DB moves to a
   `worker_thread` behind the same seams.
2. **Engine: Node's built-in `node:sqlite`** — zero native dependency, which dissolves ADR-0005's
   original objection (the Electron-ABI rebuild tax). This requires **Electron ≥ 37**; we upgraded
   to Electron 42 (bundled Node 24.x, where `node:sqlite` is stable). Crucially the test suite
   (vitest under the dev-machine Node ≥ 22.16) exercises the **same engine** the app ships —
   the ABI split that makes `better-sqlite3` painful (dev/packaged Electron ABI vs test-runner
   Node ABI over one node_modules copy) never exists.
   **Pre-decided fallback**: `better-sqlite3` behind the same thin DB seam if `node:sqlite` had
   failed the spike — accepting electron-rebuild in packaging, asarUnpack, and a test-ABI
   strategy. The spike passed in both runtimes, so the fallback stays unexercised.
3. **The transcript entry stream is the event log** — the source of truth. `transcript_entries`:
   global `AUTOINCREMENT seq` (total order, replacing per-file append order), `thread_id`
   (cascading from `threads`), entry kind, and the whole `TranscriptEntry` as a JSON payload —
   the wire type in `shared/ipc` is unchanged. `workspaces` + `threads` tables replace
   `metadata.json` (single-row updates replace whole-file rewrites). Timestamps stay epoch
   numbers, booleans are 0/1 integers.
4. **Exactly two projections, both disposable and rebuildable from the log** (not the reference
   implementation's full CQRS pipeline — main is a single serialized writer, so per-stream
   optimistic versioning and per-projector watermarks buy nothing here):
   - **Prose/FTS**: `prose_items` (one row per conversation item; agent chunks upsert-concatenated
     at write time) + an FTS5 external-content index (unicode61, `remove_diacritics 2`) kept in
     sync by triggers. Replaces the per-query scan; reasoning/tool payloads stay excluded.
   - **Fold snapshots**: per-Thread renderer-folded `ConversationState` stored as an **opaque
     blob** with the highest folded `seq` and a `reducer_version`. Reopen = snapshot + fold only
     the tail (usually empty) — O(new entries), not O(conversation). The renderer folds; main
     never parses the blob — ADR-0001's ownership is untouched. Version mismatch or parse failure
     falls back to a full fold that rewrites the snapshot: projections are caches, never truth.
5. **Schema versioning fail-closed**: `PRAGMA user_version`, forward-only migrations statically
   imported into a numbered array (no filesystem discovery — survives bundling), auto-run at
   connection setup. A database written by a newer build makes stores read-only rather than
   letting an older build clobber it (ADR-0005's rule, carried over).
6. **No ORM.** Hand-written SQL behind the existing store seams + a minimal migration runner — no
   Drizzle/Kysely. The schema is six frozen tables; the load-bearing SQL is SQLite-specific
   (FTS5 virtual table + triggers, `MATCH`/`bm25()`/`snippet()`, pragmas, upsert-concatenate)
   which ORMs can't manage; row-to-type mapping happens once per store against the existing
   `shared/ipc` types. Revisit (Kysely, not an ORM) only if the table count grows materially.
7. **Import & rollback**: on first launch with no database and legacy files present, import
   metadata then each JSONL through the existing tolerant line parser, in chunked transactions.
   On success the legacy files are renamed to `.bak` — kept, never deleted. On failure the
   partial DB is dropped, the session runs on the legacy JSON stores (kept in-tree behind the
   construction seam for one release, with an env escape hatch), and import retries next launch.
   Fold snapshots are not imported; they populate lazily on first open.
8. **Bytes stay out of the database**: attachments remain files on disk with refs in entries
   (the reference implementation makes the same call). Best-effort discipline is unchanged — no
   persistence write ever rejects a live flow.

## Spike results (#293, `scripts/spike-node-sqlite.mjs`)

Identical checks run in both runtimes; all pass (WAL, enforced+cascading foreign keys,
`user_version`, FTS5 `MATCH`/`snippet()`/`bm25()` with diacritic folding):

| runtime | node | 50k inserts (1 txn) | read 50k rows | single append | FTS query |
|---|---|---|---|---|---|
| dev-machine node | 22.22.1 | 106 ms | 38 ms | 0.24 ms | 0.09 ms |
| Electron 42.5.2 main | 24.17.0 | 94 ms | 32 ms | 0.20 ms | 0.07 ms |

A live-turn append costs ~0.2 ms; a 50k-entry conversation reads in ~35 ms; FTS queries are
sub-millisecond. Per-event persistence and conversation loads are a non-issue.

## Considered options

- **Keep JSONL, add an on-disk search index only** — rejected. Leaves the O(conversation) reopen
  fold, the whole-file metadata rewrites, and invents a bespoke index format SQLite gives us for
  free, tested.
- **`better-sqlite3` as primary** — rejected while `node:sqlite` passes. Mature and fast, but a
  native addon: Electron-ABI rebuild in packaging, bun postinstall-trust friction, and one
  node_modules copy that cannot serve both Electron (dev/app) and Node (vitest) ABIs at once.
  Retained as the pre-decided fallback behind the same DB seam.
- **An ORM (Drizzle/Kysely) for schema + migrations** — rejected (Decision 6).
- **Full event-sourcing/CQRS with a separate DB process** (the reference implementation's shape)
  — rejected as over-provisioned: we adopt its philosophy (log as truth, projections as caches,
  snapshot-then-incremental, denormalize-at-write, bytes out of the DB), not its machinery.

## Consequences

- Electron is now ≥ 42 (Node 24 runtime in main). node-pty is unaffected (N-API prebuilds).
  Packaged-app + updater smoke passed on 42.5.2; no native-rebuild config was added.
- `bun run dist:unsigned` produces an ad-hoc-signed app whose **hardened runtime + library
  validation** blocks direct launch (no shared Team ID). Pre-existing, unrelated to the upgrade;
  real Developer-ID releases are unaffected. For local smokes, re-sign without the runtime flag:
  `codesign --force --deep -s - "dist/mac-arm64/Vibe Mistro.app"`.
- One database file concentrates what per-Thread JSONL spread out. WAL + transactions make torn
  writes far rarer than torn JSONL lines; slice 6 (#298) decides a `VACUUM INTO` backup for the
  residual risk.
- Changing conversation item shapes requires bumping the reducer schema version constant — the
  cost of a stale snapshot is one full re-fold per Thread, lazily.
- The migration is delivered as slices #294–#298; this ADR is slice #293's output. No persistence
  code changes ship with the upgrade itself.
