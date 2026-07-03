/**
 * Search domain of the shared IPC contract (#174): the Search palette's one query
 * channel + payload types. Search is main-owned from slice 1 (even though titles
 * alone could be filtered renderer-side) so the seam never migrates when transcript
 * prose search lands — the renderer sends a query, main returns ranked hits.
 * Keep this file free of Node/DOM imports so both sides can consume it.
 */

/** The search channel entries, merged into the single `IPC` const in `./index`. */
export const searchChannels = {
  /** Rank Threads against a query; an EMPTY query returns the resting recents. */
  searchQuery: 'search:query',
} as const

/** A Search query. `limit` caps the ranked hits (default `DEFAULT_SEARCH_LIMIT`). */
export interface SearchQueryArgs {
  query: string
  limit?: number
}

/**
 * One ranked Search hit. A hit is a THREAD, never an individual message
 * (CONTEXT.md "Search") — slice 2 enriches rows with `snippet`/`hitCount`/
 * `entryIndex` additively; slice 1 carries the metadata-only fields.
 */
export interface SearchHit {
  threadId: string
  workspaceId: string
  /** The Workspace's display name — shown on every row (flat list, no grouping). */
  workspaceName: string
  /** The Thread title (`null` = never titled; the renderer shows "Untitled"). */
  title: string | null
  /** Archived Threads are searchable but badged (and hidden from resting recents). */
  archived: boolean
  /** Epoch-ms recency — the ranking tiebreak and the row's relative timestamp. */
  lastActiveAt: number
}

/** The `search:query` reply: ranked hits, best first, capped at the limit. */
export type SearchQueryResult = SearchHit[]
