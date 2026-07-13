import {
  closeSurface,
  type WorkspacePanelState,
} from '../side-panel/side-panel-store'
import { routeThreadSelection, type ThreadView } from './thread-selection'

/** The pure result consumed by the sidebar-selection orchestration in App. */
export interface PrimaryThreadPromotionPlan {
  /** Side-panel state with only the selected Thread's alternate presentation removed. */
  panel: WorkspacePanelState
  /** Whether the selected Thread is already hosted on this Workspace agent. */
  view: ThreadView
}

/**
 * Plan the single-presentation transition before React navigation runs. The standard
 * Surface close operation preserves siblings/activation and returns the original
 * panel reference when no matching Side Surface exists; routing uses the same live-set
 * source of truth as the primary conversation outlet.
 */
export function planPrimaryThreadPromotion(
  panel: WorkspacePanelState,
  threadId: string,
  liveThreadIds: ReadonlySet<string>,
): PrimaryThreadPromotionPlan {
  return {
    panel: closeSurface(panel, `thread:${threadId}`),
    view: routeThreadSelection({ id: threadId }, liveThreadIds),
  }
}
