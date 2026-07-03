import type { Migration } from './sqlite-db'

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
]
