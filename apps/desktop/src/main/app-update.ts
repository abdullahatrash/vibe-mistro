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
 * end-to-end run drive (a static feed claiming a higher version).
 *
 * Linux exception: only the AppImage can self-update (electron-updater consumes
 * `latest-linux.yml`); a `.deb`/`.rpm` install defers to the system package
 * manager, and arming the updater there just yields a spurious "cannot update"
 * error every check. So on packaged Linux the updater runs ONLY for an AppImage
 * (electron-updater sets `process.env.APPIMAGE`, surfaced here as `isAppImage`).
 * The mock-feed override still forces it on for local end-to-end runs.
 */
export function resolveUpdaterMode(input: {
  isPackaged: boolean
  feedUrlOverride: string | undefined
  platform: NodeJS.Platform
  isAppImage: boolean
}): UpdaterMode {
  const feedUrl = input.feedUrlOverride?.trim() ? input.feedUrlOverride.trim() : null
  if (feedUrl !== null) return { enabled: true, feedUrl }
  if (input.isPackaged && input.platform === 'linux' && !input.isAppImage) {
    return { enabled: false, feedUrl: null }
  }
  return { enabled: input.isPackaged, feedUrl: null }
}

/** Background re-check cadence after the launch check (passive; no UI ticker). */
export const APP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** What the menu-bar "Check for Updates…" dialog should say (pure; tested). */
export interface UpdateDialogCopy {
  message: string
  detail: string
  /** Show "Restart Now" as the primary button (a download is already staged). */
  offerRestart: boolean
}

/**
 * Map the post-check status to the dialog. The menu item is the ACTIVE
 * counterpart of the passive chip: it runs a check on demand and reports where
 * the cycle stands — up to date, downloading (the chip will follow), ready
 * (offer the restart right here), or the check failed.
 */
export function describeUpdateCheck(
  status: AppUpdateStatusEvent,
  appVersion: string,
  displayName: string,
): UpdateDialogCopy {
  switch (status.phase) {
    case 'ready':
      return {
        message: `${displayName} ${status.version ?? ''} is ready to install`.replace('  ', ' '),
        detail:
          'It was downloaded in the background. Restart now to apply it — or keep working, and it installs when you quit.',
        offerRestart: true,
      }
    case 'downloading':
      return {
        message: `${displayName} ${status.version ?? ''} is on its way`.replace('  ', ' '),
        detail:
          'Downloading in the background. The "Update ready — Restart" chip appears at the bottom of the sidebar when it\'s done.',
        offerRestart: false,
      }
    case 'error':
      return {
        message: 'Could not check for updates',
        detail: `${status.error ?? 'Unknown error'}. The app retries automatically in the background.`,
        offerRestart: false,
      }
    default:
      return {
        message: `${displayName} ${appVersion}`,
        detail: "You're on the latest version.",
        offerRestart: false,
      }
  }
}

/** The dialog for a run where the updater is off (dev / unpackaged). */
export function describeUpdaterDisabled(appVersion: string, displayName: string): UpdateDialogCopy {
  return {
    message: `${displayName} ${appVersion}`,
    detail:
      'Automatic App updates run only in the packaged app. Download a Release from GitHub — dev builds update by pulling main and rebuilding.',
    offerRestart: false,
  }
}
