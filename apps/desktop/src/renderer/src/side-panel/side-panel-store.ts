/**
 * The right side panel's Surface-descriptor store (#193, ADR-0013 decision 1;
 * CONTEXT.md "Surface" / "Side panel"). Reshapes the panel onto t3code's Sheet/tab
 * model (`apps/web/src/rightPanelStore.ts`): per-Workspace, the panel owns an ORDERED
 * list of open Surface descriptors + an active id + an open flag. Open Surfaces render
 * as a tab strip; with zero open the panel shows the launcher cards (its empty state).
 *
 * Two layers, split like `follow-up-queue.ts` and the app's other renderer logic:
 *  - PURE immutable ops over a single `WorkspacePanelState` (and the per-Workspace map),
 *    plus coercion/serialization — all unit-tested here, DOM-free.
 *  - A MODULE-LEVEL singleton wiring those ops to a `useSyncExternalStore` subscription
 *    and localStorage persistence through an injected-storage seam (throw-tolerant, the
 *    established pattern). The singleton is shared so the window-header icon (App) and a
 *    Workspace's `SurfacePanel` drive the SAME state.
 *
 * The op SEMANTICS mirror t3code's `rightPanelStore` (read its implementations): a
 * singleton kind opened twice ACTIVATES rather than duplicating; closing the active tab
 * activates the neighbour at `min(index, len-1)`; `toggle` hides the panel when its kind
 * is already the active tab, else opens/activates it (the ⌘P / ⌃⇧G semantics, including
 * opening a CLOSED panel). The old `surface-state:v1` / `side-panel-open:v1` keys are
 * SUPERSEDED — not migrated; a fresh `:v2` key holds the new shape.
 */
import { useSyncExternalStore } from 'react'
import type { ListMetadataResult } from '../../../shared/ipc'

/** Every Surface kind the descriptor union accommodates (#189 files, reserved terminal/
 *  browser). Only the SINGLETON kinds have ops this slice. */
export const SURFACE_KINDS = ['review', 'files', 'file', 'terminal', 'browser', 'thread'] as const
export type SurfaceKind = (typeof SURFACE_KINDS)[number]

/** The kinds with a singleton descriptor + ops NOW (`review`, `files`). ⌘P/⌃⇧G target these. */
export type SingletonKind = 'review' | 'files'

/**
 * A Surface descriptor. `review`/`files` are singletons (fixed id === kind); the union is
 * shaped like t3code's to accommodate a per-file `file:<relativePath>` Surface (#189) and
 * reserved `terminal`/`browser` kinds, but only the singletons are constructed here.
 */
export type Surface =
  | { id: 'review'; kind: 'review' }
  | { id: 'files'; kind: 'files' }
  | { id: `file:${string}`; kind: 'file'; relativePath: string }
  | { id: `terminal:${string}`; kind: 'terminal'; resourceId: string }
  | { id: `browser:${string}`; kind: 'browser'; resourceId: string; url?: string }
  | {
      id: `thread:${string}`
      kind: 'thread'
      threadId: string
      lifecycle: 'draft' | 'durable'
    }

export type SideThreadLifecycle = Extract<Surface, { kind: 'thread' }>['lifecycle']

/** One Workspace's panel state: open flag + ordered Surfaces + which is active. */
export interface WorkspacePanelState {
  isOpen: boolean
  activeSurfaceId: string | null
  surfaces: Surface[]
}

/** The whole persisted map, keyed by workspaceId. */
export type PanelStateMap = Record<string, WorkspacePanelState>

/** The versioned localStorage key holding the per-Workspace panel map (supersedes v1). */
export const SIDE_PANEL_STORAGE_KEY = 'vibe-mistro:side-panel:v2'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface PanelStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * The default (absent-Workspace) state: closed, nothing open. A single FROZEN shared
 * instance so an unknown Workspace's `useSyncExternalStore` snapshot has a STABLE
 * reference (a fresh object per read would loop the subscription).
 */
export const EMPTY_PANEL_STATE: WorkspacePanelState = Object.freeze({
  isOpen: false,
  activeSurfaceId: null,
  surfaces: Object.freeze([]) as unknown as Surface[],
})

// --- Descriptor constructors (only the singleton kinds this slice) ---

/** The singleton descriptor for a kind (fixed id === kind). */
function singletonSurface(kind: SingletonKind): Surface {
  return kind === 'review' ? { id: 'review', kind: 'review' } : { id: 'files', kind: 'files' }
}

// --- Pure immutable ops over ONE WorkspacePanelState (never mutate inputs) ---

/**
 * Add `surface` (if absent) and activate it, opening the panel. A singleton already
 * present is only re-activated, never duplicated (t3code `upsertSurface`).
 */
function upsertSurface(state: WorkspacePanelState, surface: Surface): WorkspacePanelState {
  return {
    isOpen: true,
    surfaces: state.surfaces.some((entry) => entry.id === surface.id)
      ? state.surfaces
      : [...state.surfaces, surface],
    activeSurfaceId: surface.id,
  }
}

/** Open (or re-activate) a singleton Surface, opening the panel. */
export function openSurface(state: WorkspacePanelState, kind: SingletonKind): WorkspacePanelState {
  return upsertSurface(state, singletonSurface(kind))
}

/** A per-file Surface descriptor, its id keyed by the relative path so it dedupes (#189). */
function fileSurface(relativePath: string): Surface {
  return { id: `file:${relativePath}`, kind: 'file', relativePath }
}

/**
 * Open a `file:<relativePath>` preview Surface and activate it (#189). Keyed by the path, so
 * opening an already-open file just RE-ACTIVATES its tab rather than duplicating it — the same
 * `upsertSurface` dedupe the singletons use. The content re-reads on activate (`FilePreview`),
 * so this holds only the path, never the file's bytes.
 */
export function openFileSurface(state: WorkspacePanelState, relativePath: string): WorkspacePanelState {
  return upsertSurface(state, fileSurface(relativePath))
}

/** A renderer-only Draft Side Thread Surface, keyed by its already-minted Thread id. */
function draftSideThreadSurface(threadId: string): Surface {
  return { id: `thread:${threadId}`, kind: 'thread', threadId, lifecycle: 'draft' }
}

/** Open or re-activate one Draft Side Thread Surface without involving main or ACP. */
export function openSideThreadSurface(state: WorkspacePanelState, threadId: string): WorkspacePanelState {
  return upsertSurface(state, draftSideThreadSurface(threadId))
}

/** Mark a bound Side Thread durable so its Surface may survive renderer restart. */
export function promoteSideThreadSurface(
  state: WorkspacePanelState,
  threadId: string,
): WorkspacePanelState {
  let changed = false
  const surfaces = state.surfaces.map((surface) => {
    if (
      surface.kind !== 'thread' ||
      surface.threadId !== threadId ||
      surface.lifecycle === 'durable'
    ) {
      return surface
    }
    changed = true
    return { ...surface, lifecycle: 'durable' as const }
  })
  return changed ? { ...state, surfaces } : state
}

/** Max concurrent terminals per Workspace (ADR-0014; t3code's per-group cap). */
export const MAX_TERMINALS_PER_WORKSPACE = 4

/** A terminal descriptor for a client-minted `term-N` resource id (ADR-0014). */
function terminalSurface(resourceId: string): Surface {
  return { id: `terminal:${resourceId}`, kind: 'terminal', resourceId }
}

/** The `N` of a `term-N` resource id, or 0 if it doesn't match (defensive). */
function terminalNumberOf(resourceId: string): number {
  const match = /^term-(\d+)$/.exec(resourceId)
  return match ? Number(match[1]) : 0
}

/**
 * Mint the LOWEST-free `term-N` id for the Workspace: reuse a gap left by a closed
 * terminal (so ids stay small + stable) rather than always incrementing. `term-1`
 * for the first, `term-2` next, etc.
 */
function nextTerminalResourceId(state: WorkspacePanelState): string {
  const used = new Set(
    state.surfaces.filter((s) => s.kind === 'terminal').map((s) => terminalNumberOf(s.resourceId)),
  )
  let n = 1
  while (used.has(n)) n += 1
  return `term-${n}`
}

/**
 * Open a NEW terminal Surface for the Workspace (ADR-0014, slice 3) and activate it —
 * up to {@link MAX_TERMINALS_PER_WORKSPACE}, past which it's a no-op (returns the same
 * state; the UI disables the affordance). Unlike the singletons, each call adds a
 * distinct `term-N` tab, so the launcher card / "+"-menu spawn additional shells.
 */
export function openTerminalSurface(state: WorkspacePanelState): WorkspacePanelState {
  const count = state.surfaces.filter((s) => s.kind === 'terminal').length
  if (count >= MAX_TERMINALS_PER_WORKSPACE) return state
  return upsertSurface(state, terminalSurface(nextTerminalResourceId(state)))
}

/** How many terminal Surfaces the Workspace has open (drives the at-cap affordance). */
export function terminalSurfaceCount(state: WorkspacePanelState): number {
  return state.surfaces.filter((s) => s.kind === 'terminal').length
}

/**
 * The header Terminal button / ⌘J semantics: hide the panel when a terminal is the
 * active tab; otherwise REVEAL a terminal — re-activate the first existing terminal
 * tab if any, else spawn a fresh one ({@link openTerminalSurface}). Unlike the
 * launcher card (always-spawn), the toggle never adds a second terminal.
 */
export function toggleTerminalSurface(state: WorkspacePanelState): WorkspacePanelState {
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId)
  if (state.isOpen && active?.kind === 'terminal') return { ...state, isOpen: false }
  const existing = state.surfaces.find((surface) => surface.kind === 'terminal')
  if (existing) return { ...state, isOpen: true, activeSurfaceId: existing.id }
  return openTerminalSurface(state)
}

/**
 * The Browser Surface's fixed resource id (#216): a per-Workspace SINGLETON this slice,
 * so the descriptor is constant — the reserved `browser:${resourceId}` id shape stays
 * ready for a future multi-tab browser without a coercion break.
 */
const BROWSER_SURFACE: Surface = { id: 'browser:main', kind: 'browser', resourceId: 'main' }

/**
 * Open (or re-activate) the Workspace's singleton Browser Surface (#216, ADR-0015),
 * opening the panel — the singleton semantics of `openSurface`, under the browser's
 * own resource-id'd descriptor shape.
 */
export function openBrowserSurface(state: WorkspacePanelState): WorkspacePanelState {
  // upsertSurface keeps the EXISTING descriptor when present, so a stored url survives a
  // re-open — only a first open inserts the bare BROWSER_SURFACE (no url yet).
  return upsertSurface(state, BROWSER_SURFACE)
}

/**
 * Record the browser's last-visited url on its descriptor (#217), so a reopen /
 * app-restart reloads the preview where it left off. A no-op (same ref) when no browser
 * surface is open. The url is validated on the way BACK IN by `coerceSurface`; here we
 * trust the component (which only feeds committed guest URLs).
 */
export function setBrowserSurfaceUrl(state: WorkspacePanelState, url: string): WorkspacePanelState {
  let changed = false
  const surfaces = state.surfaces.map((surface) => {
    if (surface.kind !== 'browser' || surface.url === url) return surface
    changed = true
    return { ...surface, url }
  })
  return changed ? { ...state, surfaces } : state
}

/** Open/activate the singleton Browser Surface, or hide the panel if it's already active (⌘T). */
export function toggleBrowserSurface(state: WorkspacePanelState): WorkspacePanelState {
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId)
  if (state.isOpen && active?.kind === 'browser') return { ...state, isOpen: false }
  return openBrowserSurface(state)
}

/**
 * The ⌘P / ⌃⇧G semantics (t3code `toggle`): if the panel is open AND this kind is the
 * ACTIVE tab, hide the panel (keep the tabs + active id). Otherwise open/activate the
 * singleton — which also OPENS a closed panel. So one chord opens, a second (while it's
 * the active tab) closes; from another tab it switches.
 */
export function toggleSurface(state: WorkspacePanelState, kind: SingletonKind): WorkspacePanelState {
  const active = state.surfaces.find((surface) => surface.id === state.activeSurfaceId)
  if (state.isOpen && active?.kind === kind) return { ...state, isOpen: false }
  return openSurface(state, kind)
}

/** Activate an already-open Surface by id, opening the panel; a no-op if absent. */
export function activateSurface(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  if (!state.surfaces.some((surface) => surface.id === surfaceId)) return state
  return { ...state, isOpen: true, activeSurfaceId: surfaceId }
}

/**
 * Close ONE Surface. When it was the active tab, activate the neighbour at
 * `min(index, len-1)` — the tab that slides into its slot, or the new last tab
 * (t3code `closeSurface`'s fallback). Closing the FINAL tab returns
 * `activeSurfaceId: null` with the panel STILL OPEN — the launcher-cards empty state
 * (brief decision 3; a deliberate deviation from t3code, which hides the panel on the
 * last close). `closePanel` / `closeAllSurfaces` are the ways to hide the panel.
 */
export function closeSurface(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === surfaceId)
  if (index < 0) return state
  const surfaces = state.surfaces.filter((surface) => surface.id !== surfaceId)
  if (state.activeSurfaceId !== surfaceId) return { ...state, surfaces }
  const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null
  return { ...state, surfaces, activeSurfaceId: fallback?.id ?? null }
}

/** Close every OTHER Surface, keeping + activating `surfaceId` (t3code `closeOtherSurfaces`). */
export function closeOtherSurfaces(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  const surface = state.surfaces.find((entry) => entry.id === surfaceId)
  if (!surface || state.surfaces.length === 1) return state
  return { ...state, isOpen: true, surfaces: [surface], activeSurfaceId: surface.id }
}

/**
 * Close every Surface to the RIGHT of `surfaceId` (t3code `closeSurfacesToRight`). The
 * active tab is retained when it survives, else it falls to `surfaceId`.
 */
export function closeSurfacesToRight(state: WorkspacePanelState, surfaceId: string): WorkspacePanelState {
  const index = state.surfaces.findIndex((surface) => surface.id === surfaceId)
  if (index < 0 || index === state.surfaces.length - 1) return state
  const surfaces = state.surfaces.slice(0, index + 1)
  const activeStillExists = surfaces.some((surface) => surface.id === state.activeSurfaceId)
  return { ...state, surfaces, activeSurfaceId: activeStillExists ? state.activeSurfaceId : surfaceId }
}

/** Close ALL Surfaces and the panel (t3code `closeAllSurfaces`). */
export function closeAllSurfaces(state: WorkspacePanelState): WorkspacePanelState {
  if (state.surfaces.length === 0) return state
  return { ...state, isOpen: false, surfaces: [], activeSurfaceId: null }
}

/** Show the panel (header icon / a Surface open) — keeps tabs + active id (t3code `show`). */
export function showPanel(state: WorkspacePanelState): WorkspacePanelState {
  return state.isOpen ? state : { ...state, isOpen: true }
}

/** Hide the panel — keeps tabs + active id, so re-showing lands where you left off. */
export function closePanel(state: WorkspacePanelState): WorkspacePanelState {
  return state.isOpen ? { ...state, isOpen: false } : state
}

/** Flip the panel's visibility (the window-header PanelRight icon; t3code `toggleVisibility`). */
export function togglePanelVisibility(state: WorkspacePanelState): WorkspacePanelState {
  return { ...state, isOpen: !state.isOpen }
}

// --- Pure map wrapper (prunes fully-empty Workspaces, t3code `updateThread`) ---

/**
 * Apply `updater` to one Workspace's state within the map, returning a NEW map (inputs
 * untouched) — or the SAME map reference when nothing changed, so an unrelated Workspace's
 * snapshot ref stays stable. A Workspace that lands fully-empty (closed, no active, no
 * surfaces) is PRUNED so it leaves no residue.
 */
export function updateWorkspace(
  map: PanelStateMap,
  workspaceId: string,
  updater: (current: WorkspacePanelState) => WorkspacePanelState,
): PanelStateMap {
  const current = map[workspaceId] ?? EMPTY_PANEL_STATE
  const next = updater(current)
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(workspaceId in map)) return map
    const rest = { ...map }
    delete rest[workspaceId]
    return rest
  }
  if (next === current) return map
  return { ...map, [workspaceId]: next }
}

// --- Coercion + (de)serialization (defensive against corrupt / legacy blobs) ---

/**
 * A persisted browser url is trusted ONLY if it's a string that parses to an http/https
 * URL — mirrors the renderer URL policy so a tampered blob can't seed the webview with a
 * `file:`/`javascript:` src. Returns the normalized href, or null to drop it.
 */
function coerceBrowserUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  try {
    const url = new URL(raw)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Coerce an untrusted descriptor into a valid `Surface`, or `null` to drop it. Every
 * implemented kind validates its full shape (id/resource conventions) — anything
 * unknown or malformed is dropped rather than trusted.
 */
export function coerceSurface(raw: unknown): Surface | null {
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  if (kind === 'review') return { id: 'review', kind: 'review' }
  if (kind === 'files') return { id: 'files', kind: 'files' }
  if (kind === 'file') {
    // A persisted file tab names a path — harmless to restore (the content re-reads on activate;
    // a since-deleted file just shows the preview's error). Validate the shape defensively: a
    // non-empty `relativePath` string whose `id` matches the `file:<path>` convention, else drop.
    const relativePath = (raw as { relativePath?: unknown }).relativePath
    const id = (raw as { id?: unknown }).id
    if (typeof relativePath === 'string' && relativePath.length > 0 && id === `file:${relativePath}`) {
      return { id: `file:${relativePath}`, kind: 'file', relativePath }
    }
    return null
  }
  if (kind === 'terminal') {
    // A persisted terminal tab restores its `term-N` slot (a fresh shell spawns on
    // activate — the session itself never persists). Accept a well-formed `term-<n>`
    // whose `id` matches the convention; drop anything malformed.
    const resourceId = (raw as { resourceId?: unknown }).resourceId
    const id = (raw as { id?: unknown }).id
    if (typeof resourceId === 'string' && /^term-\d+$/.test(resourceId) && id === `terminal:${resourceId}`) {
      return { id: `terminal:${resourceId}`, kind: 'terminal', resourceId }
    }
    return null
  }
  if (kind === 'browser') {
    // A persisted browser tab restores its slot AND its last url (#217) — the page
    // reloads there on reopen. Only the singleton shape exists this slice; drop anything
    // else. A stored url is restored ONLY if it's a safe http/https URL (an untrusted
    // blob could carry `file:`/`javascript:`); a bad url is dropped but the tab survives.
    const resourceId = (raw as { resourceId?: unknown }).resourceId
    const id = (raw as { id?: unknown }).id
    if (resourceId === 'main' && id === 'browser:main') {
      const url = coerceBrowserUrl((raw as { url?: unknown }).url)
      return url
        ? { id: 'browser:main', kind: 'browser', resourceId: 'main', url }
        : { id: 'browser:main', kind: 'browser', resourceId: 'main' }
    }
    return null
  }
  if (kind === 'thread') {
    // Draft Side Threads are deliberately session-only: even a well-formed injected
    // descriptor must disappear on restart. TB2 promotes a sent Thread to `durable`;
    // accepting only that lifecycle here keeps the persistence boundary explicit.
    const threadId = (raw as { threadId?: unknown }).threadId
    const id = (raw as { id?: unknown }).id
    const lifecycle = (raw as { lifecycle?: unknown }).lifecycle
    if (
      typeof threadId === 'string' &&
      threadId.length > 0 &&
      id === `thread:${threadId}` &&
      lifecycle === 'durable'
    ) {
      return { id: `thread:${threadId}`, kind: 'thread', threadId, lifecycle: 'durable' }
    }
    return null
  }
  return null
}

/**
 * Coerce an untrusted per-Workspace blob into a valid `WorkspacePanelState`. Surfaces are
 * coerced + de-duplicated by id; `activeSurfaceId` survives only if it names a surviving
 * Surface; `isOpen` is honoured as a boolean (an open-with-zero-surfaces state — the cards
 * empty state — is legitimate). Anything malformed degrades to `EMPTY_PANEL_STATE`.
 */
export function coercePanelState(raw: unknown): WorkspacePanelState {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return EMPTY_PANEL_STATE
  const obj = raw as { isOpen?: unknown; activeSurfaceId?: unknown; surfaces?: unknown }
  const surfaces: Surface[] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.surfaces)) {
    for (const entry of obj.surfaces) {
      const surface = coerceSurface(entry)
      if (surface && !seen.has(surface.id)) {
        seen.add(surface.id)
        surfaces.push(surface)
      }
    }
  }
  const activeSurfaceId =
    typeof obj.activeSurfaceId === 'string' && seen.has(obj.activeSurfaceId)
      ? obj.activeSurfaceId
      : null
  const isOpen = typeof obj.isOpen === 'boolean' ? obj.isOpen : false
  return { isOpen, activeSurfaceId, surfaces }
}

/**
 * Read the whole persisted map, coercing each entry and pruning any that lands fully-empty.
 * MAY THROW if `getItem` / `JSON.parse` throws — callers wrap and fall back to `{}`.
 */
export function readPanelMap(storage: PanelStorage): PanelStateMap {
  const raw = storage.getItem(SIDE_PANEL_STORAGE_KEY)
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const out: PanelStateMap = {}
  for (const [workspaceId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const state = coercePanelState(value)
    if (state.isOpen || state.activeSurfaceId !== null || state.surfaces.length > 0) {
      out[workspaceId] = state
    }
  }
  return out
}

/** Persist the map best-effort; a quota/security exception is swallowed (never traps a toggle). */
export function writePanelMap(storage: PanelStorage, map: PanelStateMap): void {
  try {
    const persisted: PanelStateMap = {}
    for (const [workspaceId, state] of Object.entries(map)) {
      // An unprompted Side Thread is renderer-only session state. Keep it in the live
      // panel map, but never leak its Thread id or descriptor into localStorage. TB2 can
      // promote the same descriptor to `durable`, at which point it becomes persistable.
      const isPersistable = (surface: Surface): boolean =>
        surface.kind !== 'thread' || surface.lifecycle === 'durable'
      const surfaces = state.surfaces.filter(isPersistable)
      let activeSurfaceId = surfaces.some((surface) => surface.id === state.activeSurfaceId)
        ? state.activeSurfaceId
        : null
      if (activeSurfaceId === null && state.activeSurfaceId !== null) {
        const removedActiveIndex = state.surfaces.findIndex(
          (surface) => surface.id === state.activeSurfaceId,
        )
        if (removedActiveIndex >= 0) {
          // Match closeSurface's neighbour preference after filtering every Draft:
          // choose the nearest surviving tab to the right, then the nearest to the left.
          const fallback =
            state.surfaces.slice(removedActiveIndex + 1).find(isPersistable) ??
            state.surfaces.slice(0, removedActiveIndex).findLast(isPersistable)
          activeSurfaceId = fallback?.id ?? null
        }
      }
      if (state.isOpen || activeSurfaceId !== null || surfaces.length > 0) {
        persisted[workspaceId] = { isOpen: state.isOpen, activeSurfaceId, surfaces }
      }
    }
    storage.setItem(SIDE_PANEL_STORAGE_KEY, JSON.stringify(persisted))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a panel op.
  }
}

/** The currently primary-presented Thread for each Workspace, if any. */
export type PrimaryThreadIds = Readonly<Record<string, string | null | undefined>>

function surfaceMatchesCanonical(surface: Surface, canonical: Surface): boolean {
  if (surface.id !== canonical.id || surface.kind !== canonical.kind) return false
  switch (canonical.kind) {
    case 'review':
    case 'files':
      return true
    case 'file':
      return surface.kind === 'file' && surface.relativePath === canonical.relativePath
    case 'terminal':
      return surface.kind === 'terminal' && surface.resourceId === canonical.resourceId
    case 'browser':
      return (
        surface.kind === 'browser' &&
        surface.resourceId === canonical.resourceId &&
        surface.url === canonical.url
      )
    case 'thread':
      return (
        surface.kind === 'thread' &&
        surface.threadId === canonical.threadId &&
        surface.lifecycle === canonical.lifecycle
      )
  }
}

/**
 * Reconcile restored panel descriptors with the authoritative metadata list. Structural
 * coercion alone cannot tell whether a durable Side Thread still belongs to this
 * Workspace, was deleted, or is now presented in the primary pane. This second-stage
 * filter resolves those facts while preserving surviving descriptor references/order.
 *
 * When the active descriptor is removed, selection falls to the nearest surviving tab
 * on its right, then its left — the same neighbour rule used by close/persistence.
 */
export function reconcilePanelMapWithMetadata(
  map: PanelStateMap,
  metadata: ListMetadataResult,
  primaryThreadIds: PrimaryThreadIds,
): PanelStateMap {
  const workspaces = new Map(metadata.map((workspace) => [workspace.id, workspace]))
  let mapChanged = false
  const reconciled: PanelStateMap = {}

  for (const [workspaceId, state] of Object.entries(map)) {
    const workspace = workspaces.get(workspaceId)
    if (!workspace) {
      mapChanged = true
      continue
    }

    const validThreadIds = new Set(
      workspace.threads
        .filter((thread) => thread.workspaceId === workspaceId)
        .map((thread) => thread.id),
    )
    const primaryThreadId = primaryThreadIds[workspaceId]
    const seen = new Set<string>()
    const retainedIndexes = new Set<number>()
    const surfaces: Surface[] = []
    let stateChanged = false

    for (const [index, original] of state.surfaces.entries()) {
      const canonical = coerceSurface(original)
      const keepThread =
        canonical?.kind !== 'thread' ||
        (validThreadIds.has(canonical.threadId) && canonical.threadId !== primaryThreadId)
      if (!canonical || !keepThread || seen.has(canonical.id)) {
        stateChanged = true
        continue
      }
      seen.add(canonical.id)
      retainedIndexes.add(index)
      if (surfaceMatchesCanonical(original, canonical)) {
        surfaces.push(original)
      } else {
        surfaces.push(canonical)
        stateChanged = true
      }
    }

    let activeSurfaceId = seen.has(state.activeSurfaceId ?? '') ? state.activeSurfaceId : null
    if (activeSurfaceId === null && state.activeSurfaceId !== null) {
      const removedActiveIndex = state.surfaces.findIndex(
        (surface) => surface.id === state.activeSurfaceId,
      )
      if (removedActiveIndex >= 0) {
        const nearest =
          state.surfaces
            .slice(removedActiveIndex + 1)
            .find((_, offset) => retainedIndexes.has(removedActiveIndex + 1 + offset)) ??
          state.surfaces
            .slice(0, removedActiveIndex)
            .findLast((_, index) => retainedIndexes.has(index))
        activeSurfaceId = nearest?.id ?? null
      }
      stateChanged = true
    }

    if (!stateChanged && surfaces.length === state.surfaces.length) {
      reconciled[workspaceId] = state
      continue
    }

    const next = { ...state, activeSurfaceId, surfaces }
    if (next.isOpen || next.activeSurfaceId !== null || next.surfaces.length > 0) {
      reconciled[workspaceId] = next
    }
    mapChanged = true
  }

  return mapChanged ? reconciled : map
}

// --- The module singleton (shared reactive state + localStorage persistence) ---

/** Resolve the live storage, tolerating a missing/throwing `window` (node tests, SSR). */
function resolveStorage(): PanelStorage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null
  }
}

/** Read the map from a storage, tolerating any throw (blocked/corrupt) → `{}`. */
function safeReadMap(storage: PanelStorage | null): PanelStateMap {
  if (!storage) return {}
  try {
    return readPanelMap(storage)
  } catch {
    return {}
  }
}

let storage: PanelStorage | null = resolveStorage()
let byWorkspace: PanelStateMap = safeReadMap(storage)
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** Subscribe to any panel-state change; returns an unsubscribe (for `useSyncExternalStore`). */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * A Workspace's panel state as a STABLE reference: the same object until THAT Workspace
 * changes (the pure ops only replace the mutated Workspace's value), and the shared frozen
 * empty otherwise. Safe as a `useSyncExternalStore` snapshot.
 */
export function getWorkspacePanel(workspaceId: string): WorkspacePanelState {
  return byWorkspace[workspaceId] ?? EMPTY_PANEL_STATE
}

/** Apply a pure op to one Workspace, persisting + notifying only on a real change. */
function apply(workspaceId: string, updater: (current: WorkspacePanelState) => WorkspacePanelState): void {
  const next = updateWorkspace(byWorkspace, workspaceId, updater)
  if (next === byWorkspace) return
  byWorkspace = next
  if (storage) writePanelMap(storage, byWorkspace)
  notify()
}

/**
 * Lift a pure `WorkspacePanelState` op into a Workspace-addressed action: the returned
 * fn takes `(workspaceId, ...opArgs)` and runs the op through {@link apply} (which
 * persists + notifies only on a real change). Collapses the per-op boilerplate while
 * keeping each exported action's exact signature — the op's trailing args flow through.
 */
function bindWorkspaceOp<A extends unknown[]>(
  op: (state: WorkspacePanelState, ...args: A) => WorkspacePanelState,
): (workspaceId: string, ...args: A) => void {
  return (workspaceId, ...args) => apply(workspaceId, (state) => op(state, ...args))
}

export const openWorkspaceSurface = bindWorkspaceOp(openSurface)
export const openWorkspaceFileSurface = bindWorkspaceOp(openFileSurface)
export const openWorkspaceSideThreadSurface = bindWorkspaceOp(openSideThreadSurface)
export const promoteWorkspaceSideThreadSurface = bindWorkspaceOp(promoteSideThreadSurface)
export const openWorkspaceTerminalSurface = bindWorkspaceOp(openTerminalSurface)
export const toggleWorkspaceTerminalSurface = bindWorkspaceOp(toggleTerminalSurface)
export const openWorkspaceBrowserSurface = bindWorkspaceOp(openBrowserSurface)
export const toggleWorkspaceBrowserSurface = bindWorkspaceOp(toggleBrowserSurface)
export const setWorkspaceBrowserSurfaceUrl = bindWorkspaceOp(setBrowserSurfaceUrl)
export const toggleWorkspaceSurface = bindWorkspaceOp(toggleSurface)
export const activateWorkspaceSurface = bindWorkspaceOp(activateSurface)
export const closeWorkspaceSurface = bindWorkspaceOp(closeSurface)
export const closeOtherWorkspaceSurfaces = bindWorkspaceOp(closeOtherSurfaces)
export const closeWorkspaceSurfacesToRight = bindWorkspaceOp(closeSurfacesToRight)
export const closeAllWorkspaceSurfaces = bindWorkspaceOp(closeAllSurfaces)
export const showWorkspacePanel = bindWorkspaceOp(showPanel)
export const closeWorkspacePanel = bindWorkspaceOp(closePanel)
export const toggleWorkspacePanelVisibility = bindWorkspaceOp(togglePanelVisibility)
/**
 * Delete-cascade for a REMOVED Workspace (#193 review; t3code `removeThread`): drop its
 * panel entry entirely so `side-panel:v2` accumulates no unreachable blobs — workspaceIds
 * are fresh UUIDs, so a removed Workspace's entry could never be read again. Called from
 * App's remove-Workspace flow beside its other localStorage cascades.
 */
export function removeWorkspacePanel(workspaceId: string): void {
  apply(workspaceId, () => EMPTY_PANEL_STATE)
}

/** Reconcile the live/persisted singleton once authoritative metadata is available. */
export function reconcileWorkspacePanels(
  metadata: ListMetadataResult,
  primaryThreadIds: PrimaryThreadIds,
): void {
  const next = reconcilePanelMapWithMetadata(byWorkspace, metadata, primaryThreadIds)
  if (next === byWorkspace) return
  byWorkspace = next
  if (storage) writePanelMap(storage, byWorkspace)
  notify()
}

/**
 * Bind the module store to one Workspace: a live, stable-reference `WorkspacePanelState`
 * via `useSyncExternalStore`. Its identity is stable across unrelated Workspaces' changes,
 * so the subscription doesn't loop.
 */
export function useWorkspacePanel(workspaceId: string): WorkspacePanelState {
  return useSyncExternalStore(
    subscribe,
    () => getWorkspacePanel(workspaceId),
    () => getWorkspacePanel(workspaceId),
  )
}

/**
 * Test-only reset so the module singleton doesn't leak state across tests. Pass a fake
 * storage to exercise persistence round-trips; pass `null` for a no-storage store; omit
 * to re-resolve `window.localStorage`.
 */
export function _resetSidePanelStore(fakeStorage?: PanelStorage | null): void {
  storage = fakeStorage === undefined ? resolveStorage() : fakeStorage
  byWorkspace = safeReadMap(storage)
  listeners.clear()
}
