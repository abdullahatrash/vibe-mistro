/**
 * Workspace-level skills/commands cache (#241): the `/` autocomplete's data source for
 * the Threads that have none of their own. `available_commands_update` is session-tagged
 * and the event router rightly rejects session-tagged events for an UNBOUND draft
 * (ADR-0011), so a draft's composer — and a cold, process-free reopen (ADR-0005) — sees
 * an empty list until the first prompt binds. But the list is per-AGENT (per-Workspace),
 * not per-session: every session of one `vibe-acp` process reports the same commands. So
 * any mounted Conversation folds the update in here, keyed by the durable `workspaceId`,
 * BEFORE Thread routing; drafts and cold Threads fall back to this cache.
 *
 * Pure module over an injected storage seam (the `composer-draft-store.ts` pattern):
 * the live Map serves the session; localStorage carries the last-known list across
 * restarts (renderer-only UI affordance data — not transcript, not IPC). Reads and
 * writes swallow malformed blobs and storage exceptions.
 */

import type { AcpCommand } from './reducer'

/** The single localStorage key holding the `workspaceId -> commands` map. */
export const WORKSPACE_COMMANDS_STORAGE_KEY = 'vibe-mistro:workspace-commands:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface CommandsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A stable frozen empty list, so repeat reads snapshot-compare equal (useSyncExternalStore). */
const NO_COMMANDS: AcpCommand[] = []

/** Live per-Workspace cache. Also memoizes storage-seeded reads for reference stability. */
const commandsByWorkspace = new Map<string, AcpCommand[]>()

type CommandsListener = () => void
const listeners = new Set<CommandsListener>()

/** Subscribe to any Workspace's commands changing; returns an unsubscribe. */
export function subscribeWorkspaceCommands(listener: CommandsListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Read + parse the persisted `workspaceId -> commands` map; never throws. */
function readPersisted(storage: CommandsStorage | null | undefined): Record<string, unknown> {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(WORKSPACE_COMMANDS_STORAGE_KEY)
  } catch {
    return {}
  }
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Defensively coerce one persisted workspace entry back into a commands list. */
function coercePersistedCommands(raw: unknown): AcpCommand[] {
  if (!Array.isArray(raw)) return NO_COMMANDS
  const list = raw
    .filter(
      (c): c is { name: string; description?: unknown } =>
        !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string',
    )
    .map((c) => ({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : undefined,
    }))
  return list.length > 0 ? list : NO_COMMANDS
}

/**
 * Fold an `acp:event` payload into the Workspace cache: a no-op for anything but an
 * `available_commands_update`; otherwise store live, persist best-effort, and notify.
 * Call this BEFORE Thread routing — the commands list is not conversation content, so
 * the reject-while-unbound rule's sibling-splicing hazard does not apply to it.
 */
export function foldCommandsEvent(
  storage: CommandsStorage | null | undefined,
  workspaceId: string,
  payload: unknown,
): void {
  const commands = commandsFromEvent(payload)
  if (!commands) return
  commandsByWorkspace.set(workspaceId, commands)
  if (storage) {
    try {
      const map = readPersisted(storage)
      map[workspaceId] = commands
      storage.setItem(WORKSPACE_COMMANDS_STORAGE_KEY, JSON.stringify(map))
    } catch {
      // Best-effort persistence — the live cache still serves this session.
    }
  }
  for (const listener of listeners) listener()
}

/**
 * The Workspace's last-known commands: the live cache when this session has seen an
 * update, else a one-time seed from storage (memoized into the cache so repeat reads
 * return the SAME reference — a `useSyncExternalStore` snapshot requirement). Empty
 * when neither exists (e.g. a never-connected Workspace).
 */
export function getWorkspaceCommands(
  storage: CommandsStorage | null | undefined,
  workspaceId: string,
): AcpCommand[] {
  const live = commandsByWorkspace.get(workspaceId)
  if (live) return live
  const seeded = coercePersistedCommands(readPersisted(storage)[workspaceId])
  commandsByWorkspace.set(workspaceId, seeded)
  return seeded
}

/**
 * Probe an `acp:event` payload for an `available_commands_update` (acp-capture §4) and
 * return its parsed commands list, or null for any other payload. Mirrors the reducer's
 * own defensive parse: entries without a string `name` are dropped.
 */
export function commandsFromEvent(payload: unknown): AcpCommand[] | null {
  if (!payload || typeof payload !== 'object') return null
  const message = payload as { method?: unknown; params?: unknown }
  if (message.method !== 'session/update') return null
  const update = (message.params as { update?: unknown } | undefined)?.update
  if (!update || typeof update !== 'object') return null
  if ((update as { sessionUpdate?: unknown }).sessionUpdate !== 'available_commands_update') {
    return null
  }
  const list = (update as { availableCommands?: unknown }).availableCommands
  if (!Array.isArray(list)) return null
  return list
    .filter(
      (c): c is { name: string; description?: unknown } =>
        !!c && typeof c === 'object' && typeof (c as { name?: unknown }).name === 'string',
    )
    .map((c) => ({
      name: c.name,
      description: typeof c.description === 'string' ? c.description : undefined,
    }))
}
