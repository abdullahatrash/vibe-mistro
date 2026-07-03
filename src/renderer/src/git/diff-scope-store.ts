/**
 * The Review Surface's persisted diff scope (#237, PRD #233): Working tree vs Branch
 * changes + the chosen base ref, PER WORKSPACE — which branch you review against is
 * workspace state, unlike the global rendering prefs in `diff-prefs-store`. Same
 * injected-storage seam (throw-tolerant, renderer-only localStorage boundary).
 * `baseRef: null` means Automatic — main resolves the default branch.
 */

export type DiffScope = 'working' | 'branch'

export interface DiffScopeState {
  scope: DiffScope
  baseRef: string | null
}

export const DIFF_SCOPE_STORAGE_KEY = 'vibe-mistro:diff-scope:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface ScopeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const DEFAULT: DiffScopeState = { scope: 'working', baseRef: null }

function coerce(entry: unknown): DiffScopeState {
  if (typeof entry !== 'object' || entry === null) return { ...DEFAULT }
  const e = entry as Record<string, unknown>
  return {
    scope: e.scope === 'branch' ? 'branch' : 'working',
    baseRef: typeof e.baseRef === 'string' && e.baseRef ? e.baseRef : null,
  }
}

function readMap(storage: ScopeStorage): Record<string, unknown> {
  try {
    const raw = storage.getItem(DIFF_SCOPE_STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Read one Workspace's scope; anything unreadable coerces to the working-tree default. */
export function readDiffScope(storage: ScopeStorage, workspaceDir: string): DiffScopeState {
  return coerce(readMap(storage)[workspaceDir])
}

/** Persist one Workspace's scope, best-effort (a throwing storage is silently ignored). */
export function writeDiffScope(storage: ScopeStorage, workspaceDir: string, state: DiffScopeState): void {
  try {
    const map = readMap(storage)
    map[workspaceDir] = state
    storage.setItem(DIFF_SCOPE_STORAGE_KEY, JSON.stringify(map))
  } catch {
    // Best-effort: losing a scope preference is not worth surfacing.
  }
}
