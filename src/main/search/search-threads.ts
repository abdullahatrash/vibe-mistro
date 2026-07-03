import type { ListMetadataResult, SearchHit } from '../../shared/ipc'
import { buildSnippet, type ProseEntry } from './transcript-prose'

/**
 * Pure Thread search over the cold metadata snapshot (#174 slice 1) — the module
 * behind the `search:query` IPC. Slice 2 widens the corpus to transcript prose;
 * the contract and this ranking stay put.
 *
 * Semantics (all decided in #174):
 * - Matching is TOKEN-AND: every whitespace-separated query token must appear as
 *   a case-insensitive, accent-insensitive substring of the Thread's searchable
 *   text (title + Workspace name). A single-token query is t3code's normalized
 *   `includes`; no fuzzy (wrong tool for prose).
 * - Ranking mirrors t3code's title tiers — exact > prefix > contains — extended
 *   with a workspace-assisted floor (tokens matched, but not all in the title);
 *   recency breaks ties.
 * - An EMPTY query is the palette's resting state: recent Threads, ARCHIVED
 *   EXCLUDED (a switcher context, not a search). A non-empty query includes
 *   archived Threads — archived is exactly what scrolling can't find.
 */

/** Ranked-hit cap (top-N); the palette never pages. */
export const DEFAULT_SEARCH_LIMIT = 20

/**
 * Fold text for matching: lowercase + strip diacritics (NFD, drop combining
 * marks) so `reviser` matches `réviser`. Applied to query and haystack alike.
 */
export function foldSearchText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Split a query into folded tokens; `[]` means "resting state" (match all). */
export function tokenizeQuery(query: string): string[] {
  return foldSearchText(query).split(/\s+/).filter(Boolean)
}

/**
 * t3code's title tiers (`rankSearchFieldMatch`), on pre-folded inputs: the whole
 * normalized query against the title — exact (3) > prefix (2) > contains (1) >
 * no whole-query title match (0). Tier 0 hits still matched token-wise (scattered
 * tokens and/or Workspace-name assists) and rank below any whole-query title hit.
 */
export function titleTier(foldedTitle: string, foldedQuery: string): number {
  if (!foldedTitle || !foldedQuery) return 0
  if (foldedTitle === foldedQuery) return 3
  if (foldedTitle.startsWith(foldedQuery)) return 2
  if (foldedTitle.includes(foldedQuery)) return 1
  return 0
}

/**
 * Rank Threads against a query. Pure — transcript I/O happens in the handler,
 * which passes each Thread's extracted prose via `proseByThread` (slice 2;
 * absent/missing threads search by title + Workspace name alone, so a transcript
 * read failure degrades a thread's rank, never the query).
 *
 * A prose entry containing ALL tokens is a "strong" message match: it seeds the
 * row's snippet, `entryIndex`, and `hitCount`, and ranks the thread within its
 * title tier. Tokens may also match SCATTERED across the title, Workspace name,
 * and different messages — the thread still hits, just without a snippet.
 */
export function searchThreads(
  workspaces: ListMetadataResult,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  proseByThread?: ReadonlyMap<string, ProseEntry[]>,
): SearchHit[] {
  const tokens = tokenizeQuery(query)
  const resting = tokens.length === 0
  // Collapse inner whitespace so the tier comparison sees one canonical phrase.
  const foldedQuery = tokens.join(' ')

  const scored: Array<{ hit: SearchHit; tier: number; hits: number }> = []
  for (const workspace of workspaces) {
    const foldedWorkspace = foldSearchText(workspace.displayName)
    for (const thread of workspace.threads) {
      const archived = thread.archived === true
      if (resting && archived) continue // switcher context — archived stays out
      const foldedTitle = foldSearchText(thread.title ?? '')
      const prose = proseByThread?.get(thread.id) ?? []
      let strong: { entry: ProseEntry; count: number } | null = null
      if (!resting) {
        const foldedProse = prose.map((entry) => foldSearchText(entry.text))
        for (let i = 0; i < prose.length; i += 1) {
          const folded = foldedProse[i] as string
          if (!tokens.every((token) => folded.includes(token))) continue
          // Count every strong entry; the FIRST one seeds snippet + entryIndex.
          if (strong) strong.count += 1
          else strong = { entry: prose[i] as ProseEntry, count: 1 }
        }
        if (!strong) {
          const haystack = `${foldedTitle}\n${foldedWorkspace}\n${foldedProse.join('\n')}`
          if (!tokens.every((token) => haystack.includes(token))) continue
        }
      }
      scored.push({
        hit: {
          threadId: thread.id,
          workspaceId: workspace.id,
          workspaceName: workspace.displayName,
          title: thread.title,
          archived,
          lastActiveAt: thread.lastActiveAt,
          ...(strong
            ? {
                snippet: buildSnippet(strong.entry.text, tokens),
                hitCount: strong.count,
                entryIndex: strong.entry.index,
                ...(strong.entry.itemId ? { jumpItemId: strong.entry.itemId } : {}),
              }
            : {}),
        },
        tier: resting ? 0 : titleTier(foldedTitle, foldedQuery),
        hits: strong?.count ?? 0,
      })
    }
  }

  scored.sort(
    (a, b) => b.tier - a.tier || b.hits - a.hits || b.hit.lastActiveAt - a.hit.lastActiveAt,
  )
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.hit)
}
