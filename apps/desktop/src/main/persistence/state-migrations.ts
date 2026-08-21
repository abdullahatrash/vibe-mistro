import type { Migration } from './sqlite-db'
import { projectEntryProse } from './prose-projection'
import { isTranscriptEntry } from './transcript'

/**
 * The state database's forward-only migration history (ADR-0019). Statically
 * registered — append new migrations to the END with the next id; never edit or
 * reorder an applied one, and never reuse a `name`. A database ahead of this list
 * fails closed in `openStateDb`.
 *
 * Applied migrations are recorded BY NAME in `schema_migrations` (#475), so a
 * long-lived branch that appends its own migration no longer consumes an `id`
 * that `main` needs — the two lists can disagree about numbers without either
 * silently skipping the other's work. `creates` is REQUIRED on every entry and
 * must list every object `up` makes, spelled as `sqlite_master.name` spells it:
 * it is what lets a ledger row be tested against the schema it claims.
 *
 * Schema conventions (ADR-0019): timestamps are epoch-millisecond INTEGERs
 * (matching the `shared/ipc` wire types), booleans are 0/1 INTEGERs — except
 * the Thread flags, which are 0/1/NULL so "explicitly false" and "never set"
 * round-trip distinctly (the legacy store's normalize-on-load semantics).
 */
export const STATE_MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'metadata-tables',
    creates: ['workspaces', 'threads', 'idx_threads_workspace_active', 'idx_threads_session'],
    up: (db) => {
      db.exec(`
        CREATE TABLE workspaces (
          id             TEXT PRIMARY KEY,
          dir            TEXT NOT NULL UNIQUE,
          display_name   TEXT NOT NULL,
          last_opened_at INTEGER NOT NULL
        );

        CREATE TABLE threads (
          id             TEXT PRIMARY KEY,
          workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          session_id     TEXT,
          title          TEXT,
          created_at     INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          pinned         INTEGER,
          archived       INTEGER
        );

        CREATE INDEX idx_threads_workspace_active ON threads(workspace_id, last_active_at DESC);
        CREATE INDEX idx_threads_session ON threads(session_id);
      `)
    },
  },
  {
    id: 2,
    name: 'transcript-entries',
    creates: ['transcript_entries', 'idx_transcript_entries_thread'],
    up: (db) => {
      // The transcript event log (ADR-0019): the source of truth the projections
      // derive from. `seq` is the global total order (replacing per-file append
      // order); `payload` holds the WHOLE TranscriptEntry as JSON, so the wire
      // type in shared/ipc is unchanged. Cascades with its Thread.
      db.exec(`
        CREATE TABLE transcript_entries (
          seq        INTEGER PRIMARY KEY AUTOINCREMENT,
          thread_id  TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          kind       TEXT NOT NULL,
          payload    TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        CREATE INDEX idx_transcript_entries_thread ON transcript_entries(thread_id, seq);
      `)
    },
  },
  {
    id: 3,
    name: 'prose-fts',
    creates: [
      'prose_items',
      'idx_prose_items_thread_item',
      'idx_prose_items_thread',
      'prose_fts',
      'prose_items_ai',
      'prose_items_ad',
      'prose_items_au',
    ],
    up: (db) => {
      // The search projection (ADR-0019, #296): one prose row per conversation
      // item (see prose-projection.ts) + an FTS5 external-content index kept in
      // sync by triggers. `item_id` is NULL for un-jumpable chunks, so the
      // one-row-per-item uniqueness is a partial index. Cascade deletes fire
      // the delete trigger (spike-verified), so FTS never holds ghost rows.
      db.exec(`
        CREATE TABLE prose_items (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          item_id   TEXT,
          first_seq INTEGER NOT NULL,
          text      TEXT NOT NULL
        );

        CREATE UNIQUE INDEX idx_prose_items_thread_item
          ON prose_items(thread_id, item_id) WHERE item_id IS NOT NULL;
        CREATE INDEX idx_prose_items_thread ON prose_items(thread_id, first_seq);

        CREATE VIRTUAL TABLE prose_fts USING fts5(
          text, content='prose_items', content_rowid='rowid',
          tokenize='unicode61 remove_diacritics 2'
        );

        CREATE TRIGGER prose_items_ai AFTER INSERT ON prose_items BEGIN
          INSERT INTO prose_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
        CREATE TRIGGER prose_items_ad AFTER DELETE ON prose_items BEGIN
          INSERT INTO prose_fts(prose_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
        END;
        CREATE TRIGGER prose_items_au AFTER UPDATE ON prose_items BEGIN
          INSERT INTO prose_fts(prose_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
          INSERT INTO prose_fts(rowid, text) VALUES (new.rowid, new.text);
        END;
      `)

      // Backfill from the event log: databases migrated before this slice
      // (or mid-import crashes) already hold entries — re-fold them through
      // the same projection the live append uses. Projections are derived, so
      // this is a re-fold, not a data migration; the runner's transaction makes
      // it atomic and the user_version gate makes it once-only.
      const rows = db
        .prepare('SELECT thread_id, seq, payload FROM transcript_entries ORDER BY seq')
        .all() as unknown as { thread_id: string; seq: number; payload: string }[]
      for (const row of rows) {
        let parsed: unknown
        try {
          parsed = JSON.parse(row.payload)
        } catch {
          continue // a garbled payload row carries no searchable prose
        }
        if (isTranscriptEntry(parsed)) projectEntryProse(db, row.thread_id, row.seq, parsed)
      }
    },
  },
  {
    id: 4,
    name: 'thread-snapshots',
    creates: ['thread_snapshots'],
    up: (db) => {
      // The fold-snapshot projection (ADR-0019, #297): the renderer's folded
      // ConversationState as an OPAQUE blob (main never parses it — ADR-0001),
      // versioned by the renderer's reducer schema constant and anchored to the
      // log horizon (`last_seq`) it folds up to. Disposable and rebuildable —
      // NOT backfilled here: snapshots populate lazily on each Thread's first
      // open (one last full fold each), because only the renderer can fold.
      db.exec(`
        CREATE TABLE thread_snapshots (
          thread_id       TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          reducer_version INTEGER NOT NULL,
          last_seq        INTEGER NOT NULL,
          state           TEXT NOT NULL,
          updated_at      INTEGER NOT NULL
        );
      `)
    },
  },
  {
    id: 5,
    name: 'bots',
    creates: ['bots', 'idx_bots_workspace'],
    up: (db) => {
      // The Mistro Bot record (#445, ADR-0027): a Bot IS one continuing Thread,
      // so `thread_id` is BOTH the primary key and the identity — there is no
      // second id. Cascades with its Thread, which itself cascades with its
      // Workspace, so removing a Project takes its Bots' rows down with it (the
      // profile FILES are cleaned separately — read the rows BEFORE removal).
      //
      // `profile_id` is the durable half of the persona (`mistro-bot-<uuid>`):
      // Mode does not survive `session/load` and the re-assert cache is
      // in-memory by design, so without this column a Bot reopened after a
      // restart is a nameless Thread. UNIQUE because it names two files on disk.
      db.exec(`
        CREATE TABLE bots (
          thread_id    TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          profile_id   TEXT NOT NULL UNIQUE,
          name         TEXT NOT NULL,
          colour       TEXT NOT NULL,
          description  TEXT NOT NULL,
          instructions TEXT NOT NULL,
          created_at   INTEGER NOT NULL,
          updated_at   INTEGER NOT NULL
        );

        CREATE INDEX idx_bots_workspace ON bots(workspace_id);
      `)
    },
  },
  {
    id: 6,
    name: 'routines',
    creates: ['routines', 'idx_routines_thread'],
    up: (db) => {
      // A Routine (#467, ADR-0028): a named schedule attached to a Mistro Bot.
      //
      // `thread_id` references `bots`, NOT `threads`, and that is the load-bearing
      // choice here: a Routine belongs to a BOT (ADR-0028 part 1), so the row must
      // go when the Bot does — and `bots:delete` keeps the Thread (it archives the
      // conversation), so a `threads` reference would leave Routines behind for a
      // teammate that no longer exists. The cascade still reaches all the way out,
      // because `bots` itself cascades from `threads` and from `workspaces`.
      //
      // `schedule` and `allowed_commands` are JSON: the schedule is a structured
      // value whose `kind` discriminator must admit a future `cron` variant with
      // NO migration (ADR-0028 part 2), and the allowed commands are a list. Both
      // are read and written whole, never queried into, so a column each would buy
      // nothing and cost a migration per variant.
      //
      // There is NO `next_run_at` column, deliberately: a stored next-fire is a
      // value somebody must remember to rewrite, which is the exact failure mode
      // the derivation in `shared/schedule` exists to remove (ADR-0028 part 6).
      db.exec(`
        CREATE TABLE routines (
          id               TEXT PRIMARY KEY,
          thread_id        TEXT NOT NULL REFERENCES bots(thread_id) ON DELETE CASCADE,
          name             TEXT NOT NULL,
          prompt           TEXT NOT NULL,
          schedule         TEXT NOT NULL,
          allowed_commands TEXT NOT NULL,
          active           INTEGER NOT NULL,
          last_run_at      INTEGER,
          last_outcome     TEXT,
          last_error       TEXT,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL
        );

        CREATE INDEX idx_routines_thread ON routines(thread_id, created_at);
      `)
    },
  },
]
