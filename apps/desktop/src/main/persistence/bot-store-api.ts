import type { BotRecord } from '../../shared/ipc'

/**
 * The public surface of the Mistro Bot store (#445, ADR-0027) — the seam every
 * Bot flow in main types against, mirroring `MetadataStoreApi` /
 * `TranscriptStoreApi`. One implementation today (`SqliteBotStore`, on the same
 * `state.sqlite` as everything else); the interface exists so the lifecycle
 * orchestrators and the IPC handlers can be tested without a database.
 *
 * SYNCHRONOUS on purpose, unlike `MetadataStoreApi`: `node:sqlite` is
 * synchronous and there is no legacy JSON engine behind this seam, so wrapping
 * every call in a Promise would only be theatre.
 *
 * Best-effort like every other store here: a write that cannot land LOGS and
 * reports failure (`null` / `false`) rather than throwing into the live flow.
 */

/** A new Bot's row values. Ids are minted by the caller, never by the renderer. */
export interface BotInsert {
  threadId: string
  workspaceId: string
  profileId: string
  name: string
  colour: string
  description: string
  instructions: string
}

/** The editable half of a Bot. `profileId` is deliberately absent — see ADR-0027. */
export interface BotPatch {
  name?: string
  colour?: string
  description?: string
  instructions?: string
}

export interface BotStoreApi {
  /** Every Bot, most-recently-updated first. Empty on a locked database. */
  list(): BotRecord[]
  /** One Project's Bots. Read BEFORE removing a Workspace — the rows cascade away with it. */
  listByWorkspace(workspaceId: string): BotRecord[]
  /** One Bot by its Thread, or null when the Thread is not a Bot. */
  get(threadId: string): BotRecord | null
  /** Insert a Bot row. Returns null when the write could not land (logged). */
  insert(input: BotInsert): BotRecord | null
  /** Patch a Bot in place. Returns null for an unknown Bot or a failed write. */
  update(threadId: string, patch: BotPatch): BotRecord | null
  /** Drop a Bot row (the Thread survives). Idempotent; false = nothing removed. */
  delete(threadId: string): boolean
}
