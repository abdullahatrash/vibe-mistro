import type { ListMetadataResult } from '../../../shared/ipc'
import { reconcileWorkspacePanels, type PrimaryThreadIds } from '../side-panel/side-panel-store'

type ReconcilePanels = (
  metadata: ListMetadataResult,
  primaryThreadIds: PrimaryThreadIds,
) => void

/**
 * App-level restoration seam. `null` means metadata is still loading, which is
 * intentionally distinct from an authoritative empty result. The only effect behind
 * this seam is renderer placement reconciliation; it has no ACP/IPC dependency.
 */
export function reconcileRestoredSideThreadPlacement(
  metadata: ListMetadataResult | null,
  reconcile: ReconcilePanels = reconcileWorkspacePanels,
): void {
  if (metadata === null) return
  // This runs once during cold restoration, before any Workspace can host a live
  // Thread. Later primary transitions close conflicts synchronously at their source.
  reconcile(metadata, {})
}
