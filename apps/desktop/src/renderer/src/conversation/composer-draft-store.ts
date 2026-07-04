import { useCallback, useSyncExternalStore } from 'react'

/**
 * Per-Thread composer drafts (#60): the unsent text in a Thread's composer, kept
 * so it survives any unmount — a cold↔live transition, an agent eviction/re-warm
 * (TB5 #56), an app restart, or switching to a non-mounted cold Thread. The draft
 * is EPHEMERAL UI state, so it lives in localStorage ONLY: no IPC, no main, no
 * JSONL (those persist the transcript, not the half-typed prompt). Keyed by the
 * durable renderer-minted Thread id (#58 hands us one up front), so a single key
 * space covers both unsent-draft Threads and persisted ones.
 *
 * A pure module over an INJECTED storage seam (like `thread-status.ts` /
 * `workspace-threads.ts`): every function takes the storage, so tests pass a fake
 * and render code passes `window.localStorage`. Reading must never throw into a
 * render and writing must never throw from a keystroke, so both paths swallow a
 * malformed blob, an absent key, and a quota/security exception.
 */

/** The legacy localStorage key holding the `threadId -> text` map. */
export const LEGACY_COMPOSER_DRAFT_STORAGE_KEY = 'vibe-mistro:composer-drafts:v1'

/** The versioned localStorage key holding the structured `threadId -> draft` map. */
export const COMPOSER_DRAFT_STORAGE_KEY = 'vibe-mistro:composer-drafts:v2'
export const COMPOSER_DRAFT_SCHEMA_VERSION = 1

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface ComposerDraft {
  prompt: string
  inlineTokens: unknown[]
  contextAttachments: unknown[]
  images: unknown[]
  nonPersistedImageIds: string[]
}

/** The persisted shape: a thread id -> structured draft map. */
type DraftMap = Record<string, ComposerDraft>

interface PersistedComposerDrafts {
  schemaVersion: typeof COMPOSER_DRAFT_SCHEMA_VERSION
  drafts: DraftMap
}

const EMPTY_COMPOSER_DRAFT: ComposerDraft = Object.freeze({
  prompt: '',
  inlineTokens: Object.freeze([]) as unknown as unknown[],
  contextAttachments: Object.freeze([]) as unknown as unknown[],
  images: Object.freeze([]) as unknown as unknown[],
  nonPersistedImageIds: Object.freeze([]) as unknown as string[],
})

function emptyComposerDraft(): ComposerDraft {
  return {
    prompt: '',
    inlineTokens: [],
    contextAttachments: [],
    images: [],
    nonPersistedImageIds: [],
  }
}

function isEmptyDraft(draft: ComposerDraft): boolean {
  return (
    draft.prompt.trim().length === 0 &&
    draft.inlineTokens.length === 0 &&
    draft.contextAttachments.length === 0 &&
    draft.images.length === 0 &&
    draft.nonPersistedImageIds.length === 0
  )
}

function coerceDraft(value: unknown): ComposerDraft | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const draft = value as Partial<ComposerDraft>
  return {
    prompt: typeof draft.prompt === 'string' ? draft.prompt : '',
    inlineTokens: Array.isArray(draft.inlineTokens) ? draft.inlineTokens : [],
    contextAttachments: Array.isArray(draft.contextAttachments) ? draft.contextAttachments : [],
    images: Array.isArray(draft.images) ? draft.images : [],
    nonPersistedImageIds: Array.isArray(draft.nonPersistedImageIds)
      ? draft.nonPersistedImageIds.filter((id): id is string => typeof id === 'string')
      : [],
  }
}

function readLegacyMap(storage: DraftStorage): DraftMap {
  let raw: string | null
  try {
    raw = storage.getItem(LEGACY_COMPOSER_DRAFT_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const map: DraftMap = {}
    for (const [threadId, value] of Object.entries(parsed)) {
      if (typeof value !== 'string') continue
      map[threadId] = {
        ...emptyComposerDraft(),
        prompt: value,
      }
    }
    return map
  } catch {
    return {}
  }
}

/**
 * Read + parse the draft map, tolerating everything: an unavailable storage, an
 * absent key, a parse error, or a non-object blob all yield an empty map. Never
 * throws — a corrupt entry must not break the composer's render.
 */
function readMap(storage: DraftStorage | null | undefined): DraftMap {
  if (!storage) return {}
  let raw: string | null
  try {
    raw = storage.getItem(COMPOSER_DRAFT_STORAGE_KEY)
  } catch {
    return {}
  }
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const envelope = parsed as Partial<PersistedComposerDrafts>
    if (envelope.schemaVersion !== COMPOSER_DRAFT_SCHEMA_VERSION) return {}
    if (typeof envelope.drafts !== 'object' || envelope.drafts === null || Array.isArray(envelope.drafts)) {
      return {}
    }
    const map: DraftMap = {}
    for (const [threadId, value] of Object.entries(envelope.drafts)) {
      const draft = coerceDraft(value)
      if (draft) map[threadId] = draft
    }
    return map
  } catch {
    return {}
  }
}

/**
 * Persist the draft map best-effort: a quota/security exception is swallowed. When
 * the last draft is pruned the whole key is REMOVED (not stored as `'{}'`), so an
 * emptied store leaves no dangling blob behind.
 */
function writeMap(storage: DraftStorage, map: DraftMap): boolean {
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY)
      return true
    }
    storage.setItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({ schemaVersion: COMPOSER_DRAFT_SCHEMA_VERSION, drafts: map }),
    )
    return true
  } catch {
    // Best-effort: a full/blocked storage must never throw from a keystroke.
    return false
  }
}

function migrateLegacyMap(storage: DraftStorage): DraftMap {
  const legacy = readLegacyMap(storage)
  if (Object.keys(legacy).length === 0) return {}
  if (!writeMap(storage, legacy)) return legacy
  try {
    storage.removeItem(LEGACY_COMPOSER_DRAFT_STORAGE_KEY)
  } catch {
    // Best-effort: failing to delete the old key must not break render.
  }
  return legacy
}

/** The stored draft for a Thread, or '' when absent/malformed. Never throws. */
export function getComposerDraft(
  storage: DraftStorage | null | undefined,
  threadId: string,
): ComposerDraft {
  const map = readMap(storage)
  if (threadId in map) return map[threadId]
  if (!storage) return EMPTY_COMPOSER_DRAFT
  return migrateLegacyMap(storage)[threadId] ?? EMPTY_COMPOSER_DRAFT
}

export function getDraft(storage: DraftStorage | null | undefined, threadId: string): string {
  return getComposerDraft(storage, threadId).prompt
}

/**
 * Write a Thread's unsent text. The RAW text is stored verbatim (a trailing space
 * the user is mid-typing is preserved), but an effectively-empty draft is PRUNED
 * rather than stored as '' so blank entries never accumulate — the prune DECISION
 * is the only place we trim. A no-op (already-stored value, or pruning an absent
 * entry) skips the write.
 */
export function setComposerDraft(
  storage: DraftStorage | null | undefined,
  threadId: string,
  draft: ComposerDraft,
): void {
  if (!storage) return
  const map = readMap(storage)
  if (isEmptyDraft(draft)) {
    if (!(threadId in map)) return
    delete map[threadId]
    writeMap(storage, map)
    return
  }
  map[threadId] = draft
  writeMap(storage, map)
}

export function setDraft(
  storage: DraftStorage | null | undefined,
  threadId: string,
  text: string,
): void {
  setComposerDraft(storage, threadId, {
    ...emptyComposerDraft(),
    prompt: text,
  })
}

/**
 * Drop a Thread's draft entry — used on send (the text is now in the transcript)
 * and on delete (no orphaned composer text). Skips the write when absent.
 */
export function clearDraft(storage: DraftStorage | null | undefined, threadId: string): void {
  if (!storage) return
  const map = readMap(storage)
  if (!(threadId in map)) return
  delete map[threadId]
  writeMap(storage, map)
}

export interface ComposerDraftStore {
  subscribe(listener: () => void): () => void
  getSnapshot(threadId: string): ComposerDraft
  getTextSnapshot(threadId: string): string
  setDraft(threadId: string, draft: ComposerDraft): void
  setText(threadId: string, text: string): void
  clear(threadId: string): void
}

export function createComposerDraftStore(storage: DraftStorage | null | undefined): ComposerDraftStore {
  const listeners = new Set<() => void>()
  function notify(): void {
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(threadId) {
      return getComposerDraft(storage, threadId)
    },
    getTextSnapshot(threadId) {
      return getDraft(storage, threadId)
    },
    setDraft(threadId, draft) {
      setComposerDraft(storage, threadId, draft)
      notify()
    },
    setText(threadId, text) {
      setDraft(storage, threadId, text)
      notify()
    },
    clear(threadId) {
      clearDraft(storage, threadId)
      notify()
    },
  }
}

function resolveWindowStorage(): DraftStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

const composerDraftStore = createComposerDraftStore(resolveWindowStorage())

export function useComposerDraftText(
  threadId: string,
): [string, (text: string | ((current: string) => string)) => void, () => void] {
  const prompt = useSyncExternalStore(composerDraftStore.subscribe, () =>
    composerDraftStore.getTextSnapshot(threadId),
  )
  const setText = useCallback(
    (text: string | ((current: string) => string)) => {
      const next = typeof text === 'function' ? text(composerDraftStore.getTextSnapshot(threadId)) : text
      composerDraftStore.setText(threadId, next)
    },
    [threadId],
  )
  const clear = useCallback(() => composerDraftStore.clear(threadId), [threadId])
  return [prompt, setText, clear]
}
