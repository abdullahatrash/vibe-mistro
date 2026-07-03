/**
 * ToolRow detail derivation (#115) — the PURE bridge from a reducer `ToolItem` to the
 * strings the row renders: the expandable `<pre>` body and the dimmed inline preview. Kept
 * DOM-free so it unit-tests as data (`tool-detail.test.ts`), following the tool-status.ts /
 * tool-icon.ts pattern; the tsx just renders the returned strings.
 */

import type { ToolItem } from './reducer'

/** Stringify a raw tool field for the expanded `<pre>` detail (strings verbatim, else JSON). */
export function stringifyToolDetail(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

/** The expandable detail body: rawInput / rawOutput / content joined, or null if none. */
export function toolDetail(item: ToolItem): string | null {
  const parts: string[] = []
  if (item.rawInput !== undefined && item.rawInput !== null) parts.push(stringifyToolDetail(item.rawInput))
  if (item.rawOutput !== undefined && item.rawOutput !== null) parts.push(stringifyToolDetail(item.rawOutput))
  if (Array.isArray(item.content) && item.content.length > 0) parts.push(stringifyToolDetail(item.content))
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** The dimmed inline preview (a touched path, else a short string rawInput),
 *  suppressed when it merely duplicates the heading. */
export function toolPreview(item: ToolItem, heading: string): string | null {
  const raw = item.locations.find((l) => l.path)?.path ?? (typeof item.rawInput === 'string' ? item.rawInput : null)
  if (!raw) return null
  return raw.trim().toLowerCase() === heading.trim().toLowerCase() ? null : raw
}
