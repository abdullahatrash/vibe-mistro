import type { ThreadMeta, WorkspaceMeta, WorkspaceThreads } from '../../shared/ipc'

/**
 * The metadata RECORD VOCABULARY + legacy-JSON parsing (ADR-0005/0019). The
 * live store is `SqliteMetadataStore` (the `workspaces`/`threads` tables);
 * what remains here is engine-independent: the record/input types both engines
 * of history shared, `groupThreadsByWorkspace` (the cold launch list shape),
 * and `parseLegacyMetadata` — the tolerant envelope reader the ONE-TIME
 * importer (`import-legacy-metadata`) still needs for pre-SQLite
 * `metadata.json` files.
 *
 * The legacy JSON `MetadataStore` engine was removed in #298 after the
 * migration soak; `metadata.json.bak` remains on disk as the rollback path.
 */

export type WorkspaceRecord = WorkspaceMeta
export type ThreadRecord = ThreadMeta

/** The full persisted index (flat). Grouped for the renderer by the helper below. */
export interface MetadataSnapshot {
  workspaces: WorkspaceRecord[]
  threads: ThreadRecord[]
}

/**
 * The on-disk schema version of the LEGACY metadata envelope (the live schema
 * version is the database's `PRAGMA user_version`, ADR-0019). A legacy file
 * with a HIGHER version than this fails closed in `parseLegacyMetadata` — the
 * importer leaves it untouched rather than importing a shape it can't trust.
 */
export const METADATA_SCHEMA_VERSION = 1

/** The persisted legacy envelope, tolerated as arbitrary/corrupt shapes. */
interface PersistedIndex {
  schemaVersion?: number
  workspaces?: unknown
  threads?: unknown
}

/** Upsert a Workspace by its `dir` (the natural key); mints `id` when new. */
export interface WorkspaceInput {
  dir: string
  displayName?: string
  /** Override the open timestamp (testing). Defaults to `now()`. */
  lastOpenedAt?: number
}

/** Add/update a Thread; `id` re-targets an existing Thread, else one is minted. */
export interface ThreadInput {
  id?: string
  workspaceId: string
  sessionId?: string | null
  title?: string | null
  createdAt?: number
  lastActiveAt?: number
  /** Pin flag (#132) — may be seeded here, but the primary toggle is `setThreadFlags`. */
  pinned?: boolean
  /** Archive flag (#133) — may be seeded here, but the primary toggle is `setThreadFlags`. */
  archived?: boolean
}

/**
 * Parse a legacy `metadata.json`'s raw contents (extracted verbatim from the
 * removed JSON engine's `load()`, so the importer keeps its exact tolerance):
 * unparseable JSON degrades to an EMPTY snapshot (a torn write or hand-edit has
 * no trustworthy version — never a lock); a parseable file with a NEWER
 * `schemaVersion` fails closed (`locked: true`, empty snapshot) so the importer
 * preserves it untouched; per-record shape guards drop malformed entries so one
 * bad record can't poison the import; flags normalize to strict booleans.
 */
export function parseLegacyMetadata(raw: string): { snapshot: MetadataSnapshot; locked: boolean } {
  let parsed: PersistedIndex
  try {
    parsed = JSON.parse(raw) as PersistedIndex
  } catch {
    return { snapshot: { workspaces: [], threads: [] }, locked: false }
  }

  const version =
    typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : METADATA_SCHEMA_VERSION
  if (version > METADATA_SCHEMA_VERSION) {
    return { snapshot: { workspaces: [], threads: [] }, locked: true }
  }

  return {
    locked: false,
    snapshot: {
      workspaces: (Array.isArray(parsed.workspaces) ? parsed.workspaces : []).filter(
        isWorkspaceRecord,
      ),
      threads: (Array.isArray(parsed.threads) ? parsed.threads : [])
        .filter(isThreadRecord)
        .map(normalizeThreadFlags),
    },
  }
}

/** Well-formed-Workspace guard for `parseLegacyMetadata` — drops malformed persisted entries. */
function isWorkspaceRecord(value: unknown): value is WorkspaceRecord {
  const w = value as Record<string, unknown> | null
  return (
    !!w &&
    typeof w.id === 'string' &&
    typeof w.dir === 'string' &&
    typeof w.displayName === 'string' &&
    typeof w.lastOpenedAt === 'number'
  )
}

/** Well-formed-Thread guard for `parseLegacyMetadata` — drops malformed persisted entries. */
function isThreadRecord(value: unknown): value is ThreadRecord {
  const t = value as Record<string, unknown> | null
  return (
    !!t &&
    typeof t.id === 'string' &&
    typeof t.workspaceId === 'string' &&
    typeof t.createdAt === 'number' &&
    typeof t.lastActiveAt === 'number'
  )
}

/**
 * Coerce a loaded Thread's optional flags (#132/#133) to strict booleans: a stored
 * `pinned`/`archived` that isn't literally `true` (a stale non-boolean, or absent)
 * normalizes to `undefined` (= false). Keeps the in-memory shape honest so the
 * renderer's `orderByPin`/`partitionArchived` never see a truthy non-boolean.
 */
function normalizeThreadFlags(t: ThreadRecord): ThreadRecord {
  return {
    ...t,
    pinned: t.pinned === true ? true : undefined,
    archived: t.archived === true ? true : undefined,
  }
}

/**
 * Nest each Workspace's Threads under it for the renderer's cold launch list,
 * both ordered most-recent-first. Pure (no I/O) so it's unit-tested directly.
 * Threads whose Workspace is absent (an orphan after a Workspace was dropped)
 * are skipped rather than surfaced loose.
 */
export function groupThreadsByWorkspace(snapshot: MetadataSnapshot): WorkspaceThreads[] {
  const workspaces = [...snapshot.workspaces].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
  const threads = [...snapshot.threads].sort((a, b) => b.lastActiveAt - a.lastActiveAt)
  return workspaces.map((w) => ({
    ...w,
    threads: threads.filter((t) => t.workspaceId === w.id),
  }))
}
