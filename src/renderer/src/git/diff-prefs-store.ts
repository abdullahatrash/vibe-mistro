/**
 * Persisted toggles for the all-files diff view (#235, PRD #233): Stacked/Split, word
 * wrap, ignore-whitespace. Renderer-only UI state → localStorage (the established
 * boundary), through the same injected-storage seam as `side-panel-store` so tests run
 * DOM-free and a throwing storage (private mode, quota) degrades to defaults. Global,
 * not per-Workspace — how you read diffs is a user preference, not workspace state
 * (matching t3code's client-settings defaults). Collapsed SECTIONS deliberately don't
 * persist: the changed-file set churns constantly, so stored per-path flags would be
 * stale residue by the next open.
 */

export interface DiffPrefs {
  diffStyle: 'unified' | 'split'
  wrap: boolean
  ignoreWhitespace: boolean
}

export const DIFF_PREFS_STORAGE_KEY = 'vibe-mistro:diff-prefs:v1'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface PrefsStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const DEFAULTS: DiffPrefs = { diffStyle: 'unified', wrap: false, ignoreWhitespace: false }

/** Read the persisted prefs; anything unreadable / wrong-shaped coerces to the defaults. */
export function readDiffPrefs(storage: PrefsStorage): DiffPrefs {
  try {
    const raw = storage.getItem(DIFF_PREFS_STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULTS }
    const p = parsed as Record<string, unknown>
    return {
      diffStyle: p.diffStyle === 'split' ? 'split' : 'unified',
      wrap: p.wrap === true,
      ignoreWhitespace: p.ignoreWhitespace === true,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

/** Persist the prefs, best-effort (a throwing storage is silently ignored). */
export function writeDiffPrefs(storage: PrefsStorage, prefs: DiffPrefs): void {
  try {
    storage.setItem(DIFF_PREFS_STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Best-effort: losing a toggle preference is not worth surfacing.
  }
}
