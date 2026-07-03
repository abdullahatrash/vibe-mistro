import type {
  MetadataSnapshot,
  ThreadInput,
  ThreadRecord,
  WorkspaceInput,
  WorkspaceRecord,
} from './metadata-store'

/**
 * The public surface of the Workspace/Thread metadata store — the SEAM CONTRACT
 * boundary from ADR-0005, now shared by two implementations: the legacy JSON
 * `MetadataStore` (kept for one release behind the construction seam, ADR-0019)
 * and the SQLite `SqliteMetadataStore`. Everything in main types against THIS,
 * so the engine swap never touches orchestration code.
 */
export interface MetadataStoreApi {
  /** Prepare the store for reads. JSON: parse the index file. SQLite: no-op. */
  load(): Promise<void>
  /**
   * Whether the on-disk data was written by a NEWER build (fail-closed): the
   * store presents empty and refuses every write so a rollback can't clobber it.
   */
  isLocked(): boolean
  upsertWorkspace(input: WorkspaceInput): Promise<WorkspaceRecord>
  upsertThread(input: ThreadInput): Promise<ThreadRecord>
  touchThread(id: string): Promise<void>
  setThreadFlags(id: string, flags: { pinned?: boolean; archived?: boolean }): Promise<void>
  setThreadTitle(id: string, title: string | null): Promise<boolean>
  deleteThread(id: string): Promise<void>
  removeWorkspace(id: string): Promise<string[]>
  findThreadIdBySessionId(sessionId: string | null | undefined): string | null
  snapshot(): MetadataSnapshot
}
