/**
 * App-update domain of the shared IPC contract (#270, ADR-0018): vibe-mistro
 * updating ITSELF from the GitHub Releases stable feed via electron-updater.
 * Distinct from a Vibe update (the CLI's PyPI check, `vibe:check-update` in
 * ./core) — see CONTEXT.md. Passive by design: main checks and downloads in the
 * background and streams coarse status; the renderer shows a quiet "restart to
 * apply" affordance once a download is ready; the install happens on the user's
 * explicit restart or on normal quit — never by force-restarting mid-turn.
 */

/** The app-update channel entries, merged into the single `IPC` const in `./index`. */
export const appUpdateChannels = {
  /** Renderer -> main: current status snapshot (re-seeds a window that mounts mid-cycle). */
  appUpdateGetStatus: 'app-update:get-status',
  /** Renderer -> main: quit and install the downloaded update now (the user clicked restart). */
  appUpdateRestart: 'app-update:restart',
  /** Main -> renderer: streamed status change — see {@link AppUpdateStatusEvent}. */
  appUpdateStatus: 'app-update:status',
} as const

/**
 * Coarse lifecycle of one update cycle. Deliberately no download-progress
 * granularity: the flow is passive, so the renderer only needs to know when
 * `ready` flips the affordance on (and `error` is log/diagnostic detail).
 */
export type AppUpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error'

export interface AppUpdateStatusEvent {
  phase: AppUpdatePhase
  /** The Release being downloaded / ready to install (e.g. `0.2.0`); null otherwise. */
  version: string | null
  /** Best-effort message when `phase` is `error`; null otherwise. */
  error: string | null
}
