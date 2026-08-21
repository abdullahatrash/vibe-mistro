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
 * (CONTEXT.md "Search"). The three optional fields are present iff at least one
 * transcript prose entry contains ALL query tokens (a "strong" message match,
 * slice 2) — a title/Workspace-only match carries just the metadata fields.
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
  /**
   * The **Mistro Bot**'s name when this hit is a Bot's conversation (#446), absent
   * otherwise. Bots are hidden from the sidebar's Thread list but deliberately KEPT
   * here — both in query results (PRD story 11: the longest-running conversations
   * must not be a hole in Search) and in the resting recents (story 12: a switcher
   * should list what you switch to most).
   *
   * The palette shows this INSTEAD of `title` and marks the row, because a Thread
   * title is what Vibe made of the first prompt while the name is who the teammate
   * is — and it is matched on, so searching a Bot by name finds it.
   */
  botName?: string
  /** Epoch-ms recency — the ranking tiebreak and the row's relative timestamp. */
  lastActiveAt: number
  /** One display line from the best-matching message (whitespace-collapsed, windowed). */
  snippet?: string
  /** How many prose entries contain all tokens — the within-tier rank signal. */
  hitCount?: number
  /** Transcript line index of the best match — the slice-3 jump-to-message pointer. */
  entryIndex?: number
  /**
   * The conversation ITEM id the best match replays into (user item id or
   * `assistant:${messageId}`) — the jump-to-message scroll anchor. Absent when
   * the id can't be derived; the row then opens at the bottom like any hit.
   */
  jumpItemId?: string
}

/** The `search:query` reply: ranked hits, best first, capped at the limit. */
export type SearchQueryResult = SearchHit[]
