import type { VibeUpdateResult } from '../../../shared/ipc'

/**
 * The Environment card's "latest" row copy for a PyPI update-check result.
 * Null means render no row (not checked yet, or nothing meaningful to say).
 */
export function describeUpdateStatus(update: VibeUpdateResult | null): string | null {
  if (!update) return null
  if (update.error) return 'update check failed'
  if (!update.latestVersion) return null
  if (update.updateAvailable) return `${update.latestVersion} — update available`
  // Also covers an installed dev build ahead of PyPI: still "nothing to do".
  return `${update.latestVersion} — up to date`
}
