/**
 * Wide mode: a renderer-only UI preference that lifts the conversation column's
 * max-width cap so the transcript + composer use more of the available outlet
 * width. Pure UI chrome — like the sidebar/side-panel width stores — so it lives
 * in localStorage alone: no IPC, no main, no persistence store. Per-window.
 *
 * The store drives the `--conv-measure-max` CSS custom property on
 * `document.documentElement`; `.conv-measure` in styles.css reads it with an
 * 830px fallback, so the default (wide mode OFF) is pixel-identical to the
 * pre-feature behaviour.
 *
 * The storage seam is INJECTED so tests pass a fake and render code passes
 * `window.localStorage`; every path tolerates an unavailable/throwing/corrupt
 * store and falls back to the default (wide mode OFF).
 */

import { useLayoutEffect, useSyncExternalStore } from 'react'

/** The default state — the original 830px reading measure. */
export const DEFAULT_WIDE_MODE = false

/** The single localStorage key holding the wide-mode preference. */
export const WIDE_MODE_STORAGE_KEY = 'vibe-mistro:wide-mode:v1'

/** The value applied to --conv-measure-max when wide mode is ON. */
export const CONV_MEASURE_MAX_WIDE = 'calc(100% - 6rem)'

/** The value applied to --conv-measure-max when wide mode is OFF. */
export const CONV_MEASURE_MAX_DEFAULT = '830px'

/** The CSS custom property name set on document.documentElement. */
export const CONV_MEASURE_MAX_PROPERTY = '--conv-measure-max'

/** The slice of the Web Storage API we depend on — `window.localStorage` satisfies it. */
export interface WideModeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// --- Module singleton (shared reactive state + localStorage persistence) ---

let currentState: boolean = DEFAULT_WIDE_MODE
const listeners = new Set<() => void>()

/**
 * Read the persisted preference from storage. Never throws — a blocked/throwing/
 * corrupt store falls back to {@link DEFAULT_WIDE_MODE}.
 */
export function readWideMode(
  storage: WideModeStorage | null | undefined,
): boolean {
  if (!storage) return DEFAULT_WIDE_MODE
  try {
    const raw = storage.getItem(WIDE_MODE_STORAGE_KEY)
    if (raw === null) return DEFAULT_WIDE_MODE
    return raw === 'true'
  } catch {
    return DEFAULT_WIDE_MODE
  }
}

/** Persist the preference best-effort; a quota/security exception is swallowed. */
function writeWideMode(
  storage: WideModeStorage | null | undefined,
  enabled: boolean,
): void {
  if (!storage) return
  try {
    storage.setItem(WIDE_MODE_STORAGE_KEY, String(enabled))
  } catch {
    // Best-effort: a full/blocked storage must never throw from a toggle.
  }
}

/**
 * Initialize from localStorage at module load (call once from a renderer entry
 * point before first paint). Idempotent: a no-op if the stored value already
 * matches the in-memory state. Safe to call with null/undefined storage.
 */
export function initWideMode(
  storage: WideModeStorage | null | undefined,
): void {
  const stored = readWideMode(storage)
  if (stored === currentState) return
  currentState = stored
  for (const listener of listeners) listener()
}

export function getWideMode(): boolean {
  return currentState
}

export function subscribeWideMode(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Toggle wide mode and persist to localStorage. Repeated values do not
 * rerender subscribers.
 */
export function setWideMode(
  storage: WideModeStorage | null | undefined,
  enabled: boolean,
): void {
  if (enabled === currentState) return
  currentState = enabled
  writeWideMode(storage, enabled)
  for (const listener of listeners) listener()
}

/**
 * Apply the current wide-mode state to `document.documentElement` as the
 * `--conv-measure-max` CSS custom property. Call from a `useLayoutEffect` so
 * the property is set before paint, avoiding a flash of the default width.
 */
export function applyWideModeToDocument(enabled: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty(
    CONV_MEASURE_MAX_PROPERTY,
    enabled ? CONV_MEASURE_MAX_WIDE : CONV_MEASURE_MAX_DEFAULT,
  )
}

// --- React hook ---

/**
 * Subscribe to the wide-mode preference. Returns `[enabled, setEnabled]`.
 * A `useLayoutEffect` applies the CSS custom property before paint so toggling
 * is reflected without a flash. Call this from any always-mounted component
 * (e.g. Shell) to keep `--conv-measure-max` in sync; the effect is idempotent.
 */
export function useWideMode(): [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeWideMode, getWideMode)

  useLayoutEffect(() => {
    applyWideModeToDocument(enabled)
  }, [enabled])

  const set = (next: boolean): void => {
    setWideMode(typeof window !== 'undefined' ? window.localStorage : null, next)
  }
  return [enabled, set]
}
