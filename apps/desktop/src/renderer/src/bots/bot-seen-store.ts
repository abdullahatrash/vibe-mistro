import type { BotSeenMap } from './bot-rows'

/**
 * When each Mistro Bot was last OPENED (#446) — the only input the sidebar's
 * unread dot needs that the app does not already have.
 *
 * Renderer-only UI state, so it lives in localStorage alone (like the sidebar's
 * fold state #138 and composer drafts #60): no IPC, no main, no persistence store.
 * Losing it costs one stale dot, which is the right price for not adding read
 * receipts to a durable store.
 *
 * The storage seam is INJECTED so tests pass a fake and render code passes
 * `window.localStorage`; every path tolerates an unavailable/throwing/corrupt
 * store and falls back to "nothing seen", so a blocked store never breaks the
 * sidebar's render.
 */

/** The single localStorage key holding `{ [threadId]: epochMs }`. */
export const BOTS_SEEN_STORAGE_KEY = 'vibe-mistro:bots-seen:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface BotSeenStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The persisted last-opened times, or `{}` when absent/corrupt/unavailable.
 * Non-numeric entries are dropped rather than trusted — a stale string would make
 * `lastActiveAt > seenAt` compare against a string and mark a Bot read forever.
 */
export function getBotsSeen(storage: BotSeenStorage | null | undefined): BotSeenMap {
  if (!storage) return {}
  try {
    const raw = storage.getItem(BOTS_SEEN_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const seen: Record<string, number> = {}
    for (const [threadId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value)) seen[threadId] = value
    }
    return seen
  } catch {
    return {}
  }
}

/**
 * Record that a Bot was just opened, returning the NEW map (pure at the value
 * level — the caller re-renders from what comes back). A recorded time never goes
 * backwards, so a stale write can't resurrect a dot.
 */
export function markBotSeen(
  storage: BotSeenStorage | null | undefined,
  threadId: string,
  atMs: number,
): BotSeenMap {
  const current = getBotsSeen(storage)
  if ((current[threadId] ?? 0) >= atMs) return current
  const next = { ...current, [threadId]: atMs }
  if (storage) {
    try {
      storage.setItem(BOTS_SEEN_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Best-effort: a full/blocked storage must never throw from opening a Bot.
    }
  }
  return next
}
