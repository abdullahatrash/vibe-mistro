import { useCallback, useSyncExternalStore } from 'react'
import { coerceInlineTokens, type ComposerInlineToken } from './composer-inline-tokens'
import { parseDataUrl } from './image-attach'
import { addContext, coercePendingContexts, type PendingContext } from './pending-contexts'
import type { MessageSelection } from './message-selection'

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
export const COMPOSER_DRAFT_IMAGE_MAX_COUNT = 4
export const COMPOSER_DRAFT_IMAGE_MAX_DATA_URL_CHARS = 1_500_000

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export const COMPOSER_DRAFT_PERSIST_DEBOUNCE_MS = 300

export interface ComposerDraft {
  prompt: string
  inlineTokens: ComposerInlineToken[]
  contextAttachments: PendingContext[]
  images: ComposerDraftImage[]
  nonPersistedImageIds: string[]
}

export interface ComposerDraftImage {
  id: string
  data: string
  mimeType: string
  name: string
  previewUrl: string
}

interface PersistedComposerDraftImage {
  id: string
  name: string
  previewUrl: string
}

/** The persisted shape: a thread id -> structured draft map. */
type DraftMap = Record<string, ComposerDraft>

interface PersistedComposerDrafts {
  schemaVersion: typeof COMPOSER_DRAFT_SCHEMA_VERSION
  drafts: DraftMap
}

const EMPTY_COMPOSER_DRAFT: ComposerDraft = Object.freeze({
  prompt: '',
  inlineTokens: Object.freeze([]) as unknown as ComposerInlineToken[],
  contextAttachments: Object.freeze([]) as unknown as PendingContext[],
  images: Object.freeze([]) as unknown as ComposerDraftImage[],
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

function coerceImages(values: unknown[]): ComposerDraftImage[] {
  const images: ComposerDraftImage[] = []
  for (const value of values) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const image = value as Partial<ComposerDraftImage>
    const parsedPreview = typeof image.previewUrl === 'string' ? parseDataUrl(image.previewUrl) : null
    if (
      typeof image.id !== 'string' ||
      typeof image.name !== 'string' ||
      typeof image.previewUrl !== 'string' ||
      !parsedPreview
    ) {
      continue
    }
    images.push({
      id: image.id,
      data: parsedPreview.data,
      mimeType: parsedPreview.mimeType,
      name: image.name,
      previewUrl: image.previewUrl,
    })
  }
  return images
}

function persistedImageRecords(draft: ComposerDraft): {
  images: PersistedComposerDraftImage[]
  nonPersistedImageIds: string[]
} {
  const images: PersistedComposerDraftImage[] = []
  const nonPersistedImageIds: string[] = []
  for (const image of draft.images) {
    if (
      images.length < COMPOSER_DRAFT_IMAGE_MAX_COUNT &&
      image.previewUrl.length <= COMPOSER_DRAFT_IMAGE_MAX_DATA_URL_CHARS
    ) {
      images.push({
        id: image.id,
        name: image.name,
        previewUrl: image.previewUrl,
      })
    } else {
      nonPersistedImageIds.push(image.id)
    }
  }
  return { images, nonPersistedImageIds }
}

function sessionDraft(draft: ComposerDraft): ComposerDraft {
  return {
    ...draft,
    nonPersistedImageIds: persistedImageRecords(draft).nonPersistedImageIds,
  }
}

function persistedDraft(draft: ComposerDraft): ComposerDraft {
  const persisted = persistedImageRecords(draft)
  return {
    ...draft,
    images: persisted.images as unknown as ComposerDraftImage[],
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
    inlineTokens: Array.isArray(draft.inlineTokens) ? coerceInlineTokens(draft.inlineTokens) : [],
    contextAttachments: Array.isArray(draft.contextAttachments)
      ? coercePendingContexts(draft.contextAttachments)
      : [],
    images: Array.isArray(draft.images) ? coerceImages(draft.images) : [],
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
function writeMap(
  storage: DraftStorage,
  map: DraftMap,
  onError?: (error: unknown) => void,
): boolean {
  try {
    if (Object.keys(map).length === 0) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY)
      return true
    }
    const persistedMap: DraftMap = {}
    for (const [threadId, draft] of Object.entries(map)) {
      const next = persistedDraft(draft)
      if (!isEmptyDraft(next)) persistedMap[threadId] = next
    }
    if (Object.keys(persistedMap).length === 0) {
      storage.removeItem(COMPOSER_DRAFT_STORAGE_KEY)
      return true
    }
    storage.setItem(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({ schemaVersion: COMPOSER_DRAFT_SCHEMA_VERSION, drafts: persistedMap }),
    )
    return true
  } catch (error) {
    // Best-effort: a full/blocked storage must never throw from a keystroke.
    onError?.(error)
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
  const current = getComposerDraft(storage, threadId)
  setComposerDraft(storage, threadId, {
    ...current,
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
  getPersistenceError(): boolean
  /** Keep this Thread's live draft out of the localStorage projection. */
  markSessionOnly(threadId: string): void
  /** Remove a live draft and its session-only classification (Surface close/delete). */
  discard(threadId: string): void
  /** Allow this Thread's current and future drafts into the persistence projection. */
  promoteToPersistent(threadId: string): void
  setDraft(threadId: string, draft: ComposerDraft): void
  setText(threadId: string, text: string): void
  clear(threadId: string): void
  flush(): void
}

export interface ComposerDraftStoreOptions {
  /** Zero keeps the pure/test store synchronous; the renderer coalesces writes. */
  persistDelayMs?: number
  onPersistenceError?: (error: unknown) => void
}

export function createComposerDraftStore(
  storage: DraftStorage | null | undefined,
  options: ComposerDraftStoreOptions = {},
): ComposerDraftStore {
  const listeners = new Set<() => void>()
  let drafts = readMap(storage)
  if (storage && Object.keys(drafts).length === 0) drafts = migrateLegacyMap(storage)
  const sessionOnlyThreadIds = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  let persistenceError = false
  const persistDelayMs = options.persistDelayMs ?? 0

  function notify(): void {
    for (const listener of listeners) listener()
  }

  function setPersistenceError(next: boolean): void {
    if (persistenceError === next) return
    persistenceError = next
    notify()
  }

  function persistNow(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (!storage || !dirty) return
    const persistedDrafts = Object.fromEntries(
      Object.entries(drafts).filter(([threadId]) => !sessionOnlyThreadIds.has(threadId)),
    )
    const succeeded = writeMap(storage, persistedDrafts, (error) => {
      options.onPersistenceError?.(error)
      setPersistenceError(true)
    })
    if (!succeeded) return
    dirty = false
    setPersistenceError(false)
  }

  function schedulePersistence(): void {
    dirty = true
    if (persistDelayMs <= 0) {
      persistNow()
      return
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(persistNow, persistDelayMs)
  }

  function updateDraft(threadId: string, draft: ComposerDraft): void {
    if (isEmptyDraft(draft)) {
      if (!(threadId in drafts)) return
      const next = { ...drafts }
      delete next[threadId]
      drafts = next
    } else {
      drafts = { ...drafts, [threadId]: draft }
    }
    schedulePersistence()
    notify()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(threadId) {
      return drafts[threadId] ?? EMPTY_COMPOSER_DRAFT
    },
    getTextSnapshot(threadId) {
      return drafts[threadId]?.prompt ?? ''
    },
    getPersistenceError() {
      return persistenceError
    },
    markSessionOnly(threadId) {
      if (sessionOnlyThreadIds.has(threadId)) return
      sessionOnlyThreadIds.add(threadId)
      // Purge an older persisted projection, if one exists. No notification: the
      // live Composer snapshot itself has not changed.
      schedulePersistence()
    },
    discard(threadId) {
      const wasSessionOnly = sessionOnlyThreadIds.delete(threadId)
      const hadDraft = threadId in drafts
      updateDraft(threadId, EMPTY_COMPOSER_DRAFT)
      if (wasSessionOnly && !hadDraft) schedulePersistence()
    },
    promoteToPersistent(threadId) {
      if (!sessionOnlyThreadIds.delete(threadId)) return
      schedulePersistence()
    },
    setDraft(threadId, draft) {
      updateDraft(threadId, sessionDraft(draft))
    },
    setText(threadId, text) {
      const next = {
        ...(drafts[threadId] ?? EMPTY_COMPOSER_DRAFT),
        prompt: text,
      }
      updateDraft(threadId, sessionDraft(next))
    },
    clear(threadId) {
      updateDraft(threadId, EMPTY_COMPOSER_DRAFT)
    },
    flush: persistNow,
  }
}

function resolveWindowStorage(): DraftStorage | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

function createRendererComposerDraftStore(
  storage: DraftStorage | null,
  persistDelayMs = COMPOSER_DRAFT_PERSIST_DEBOUNCE_MS,
): ComposerDraftStore {
  return createComposerDraftStore(storage, {
    persistDelayMs,
    onPersistenceError(error) {
      console.warn('[composer-drafts] Failed to persist draft changes', error)
    },
  })
}

let composerDraftStore = createRendererComposerDraftStore(resolveWindowStorage())
let messageSelectionSeq = 0

/**
 * Stage a source-Message excerpt for a renderer-minted Thread before its Composer is
 * mounted. Updating the shared external store (rather than localStorage directly) gives
 * the first Composer render the staged chip and notifies any already-mounted subscriber.
 */
export function stageMessageSelectionContext(
  threadId: string,
  selection: MessageSelection,
): void {
  composerDraftStore.markSessionOnly(threadId)
  const current = composerDraftStore.getSnapshot(threadId)
  composerDraftStore.setDraft(threadId, {
    ...current,
    contextAttachments: addContext(current.contextAttachments, {
      kind: 'message-selection',
      id: `message-selection:${messageSelectionSeq++}`,
      text: selection.text,
      source: { ...selection.source },
    }),
  })
}

/** Clear a Thread's live composer draft through the shared external store. */
export function clearComposerDraft(threadId: string): void {
  composerDraftStore.discard(threadId)
}

/** Promote a bound Side Thread so its future composer drafts survive app restart. */
export function promoteComposerDraftToPersistent(threadId: string): void {
  composerDraftStore.promoteToPersistent(threadId)
}

/** Test-only reset for focused module-singleton tests. */
export function _resetComposerDraftStore(
  storage: DraftStorage | null = null,
  persistDelayMs = 0,
): ComposerDraftStore {
  composerDraftStore.flush()
  composerDraftStore = createRendererComposerDraftStore(storage, persistDelayMs)
  messageSelectionSeq = 0
  return composerDraftStore
}

/*
 * Keep the renderer store's pending writes safe across window teardown. The closure
 * intentionally reads the mutable module binding so test resets cannot leave a stale
 * instance behind.
 */
/* c8 ignore start -- Electron window lifecycle, not exercised in node tests. */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => composerDraftStore.flush())
}
/* c8 ignore stop */

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

export function useComposerDraft(
  threadId: string,
): [
  ComposerDraft,
  (draft: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) => void,
  () => void,
  boolean,
] {
  const draft = useSyncExternalStore(composerDraftStore.subscribe, () =>
    composerDraftStore.getSnapshot(threadId),
  )
  const persistenceError = useSyncExternalStore(
    composerDraftStore.subscribe,
    composerDraftStore.getPersistenceError,
  )
  const setStructuredDraft = useCallback(
    (nextDraft: ComposerDraft | ((current: ComposerDraft) => ComposerDraft)) => {
      const next =
        typeof nextDraft === 'function'
          ? nextDraft(composerDraftStore.getSnapshot(threadId))
          : nextDraft
      composerDraftStore.setDraft(threadId, next)
    },
    [threadId],
  )
  const clear = useCallback(() => composerDraftStore.clear(threadId), [threadId])
  return [draft, setStructuredDraft, clear, persistenceError]
}
