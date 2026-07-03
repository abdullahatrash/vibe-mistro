/**
 * Pure App-update logic (#270, ADR-0018): the status reducer electron-updater's
 * events feed, and the mode resolution that decides whether the updater runs at
 * all. The electron-updater wiring itself is a thin adapter in `index.ts` (the
 * established pure-module/thin-handler split); everything decision-shaped lives
 * here with tests.
 */
import type { AppUpdateStatusEvent } from '../shared/ipc'

/** electron-updater's event stream, retagged as a plain union the reducer can consume. */
export type UpdaterEvent =
  | { kind: 'checking' }
  | { kind: 'update-available'; version: string }
  | { kind: 'update-not-available' }
  | { kind: 'update-downloaded'; version: string }
  | { kind: 'error'; message: string }

export const APP_UPDATE_INITIAL: AppUpdateStatusEvent = {
  phase: 'idle',
  version: null,
  error: null,
}

/**
 * Fold one updater event into the current status. `ready` is ABSORBING: once an
 * update is downloaded, a later periodic check (checking / not-available / a
 * transient network error) must not hide the restart affordance — the downloaded
 * Release installs on quit regardless, so the truthful state stays `ready`.
 * Errors otherwise reset the cycle (autoDownload retries on the next check).
 */
export function reduceUpdaterEvent(
  prev: AppUpdateStatusEvent,
  event: UpdaterEvent,
): AppUpdateStatusEvent {
  if (prev.phase === 'ready') return prev
  switch (event.kind) {
    case 'checking':
      return { phase: 'checking', version: null, error: null }
    case 'update-available':
      return { phase: 'downloading', version: event.version, error: null }
    case 'update-not-available':
      return { phase: 'idle', version: null, error: null }
    case 'update-downloaded':
      return { phase: 'ready', version: event.version, error: null }
    case 'error':
      return { phase: 'error', version: null, error: event.message }
  }
}

/** Two statuses carry the same information (used to suppress no-op pushes). */
export function sameStatus(a: AppUpdateStatusEvent, b: AppUpdateStatusEvent): boolean {
  return a.phase === b.phase && a.version === b.version && a.error === b.error
}

export interface UpdaterMode {
  /** Whether the updater should run at all this launch. */
  enabled: boolean
  /**
   * Generic-provider feed URL override (the mock-feed seam), or null to use the
   * app-update.yml electron-builder embedded in the bundle (the GitHub Releases
   * stable channel).
   */
  feedUrl: string | null
}

/**
 * Decide the updater's mode for this launch. Packaged builds update from the
 * embedded feed; a dev/unpackaged run is updater-OFF unless the mock-feed env
 * (`VIBE_MISTRO_UPDATE_URL`) forces it — the seam the #270 demo and any local
 * end-to-end run drive (t3code's mock-update-server pattern).
 */
export function resolveUpdaterMode(input: {
  isPackaged: boolean
  feedUrlOverride: string | undefined
}): UpdaterMode {
  const feedUrl = input.feedUrlOverride?.trim() ? input.feedUrlOverride.trim() : null
  return { enabled: input.isPackaged || feedUrl !== null, feedUrl }
}

/** Background re-check cadence after the launch check (passive; no UI ticker). */
export const APP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000
