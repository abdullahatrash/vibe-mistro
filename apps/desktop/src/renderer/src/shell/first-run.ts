import type { ListMetadataResult, VibeDetectResult } from '../../../shared/ipc'

/**
 * What the main area should foreground when nothing is connected/selected:
 * - `needs-install` — detection finished and `vibe` / `vibe-acp` is missing, so the
 *   user can't do anything until they install it; the environment status is surfaced
 *   prominently in the outlet rather than tucked away in settings.
 * - `no-workspaces` — the toolchain is present but no Workspaces have been opened yet,
 *   so the empty state nudges Open-project.
 * - `idle` — everything's installed and Workspaces exist; the empty state is just a
 *   neutral placeholder and the environment status lives behind the settings affordance.
 */
export type FirstRunState = 'needs-install' | 'no-workspaces' | 'idle'

/**
 * Pure derivation (no React, no IPC) of the first-run / empty-state to show. A
 * still-pending detection (`detect === null`) is NOT treated as missing — we don't
 * flash `needs-install` before the check resolves. `needs-install` wins over
 * `no-workspaces`: a missing toolchain blocks regardless of how many Workspaces exist.
 */
export function firstRunState(
  detect: VibeDetectResult | null,
  recents: ListMetadataResult,
): FirstRunState {
  if (detect !== null && (!detect.vibeFound || !detect.vibeAcpFound)) return 'needs-install'
  if (recents.length === 0) return 'no-workspaces'
  return 'idle'
}
