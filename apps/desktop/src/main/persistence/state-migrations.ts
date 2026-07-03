import type { Migration } from './sqlite-db'
import { projectEntryProse } from './prose-projection'
import { isTranscriptEntry } from './transcript'

/**
 * The state database's forward-only migration history (ADR-0019). Statically
 * registered — append new migrations to the END with the next id; never edit or
 * reorder an applied one. `user_version` tracks the last applied id; a database
 * ahead of this list fails closed in `openStateDb`.
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
]
