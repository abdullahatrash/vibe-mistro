import type { ThreadAgentControls, ThreadConfigAxis } from '../../../shared/ipc'

export type SideDraftControlSnapshot = Partial<Record<ThreadConfigAxis, string>>

/**
 * Mode ids we stage for a Side Draft, best first. A Side Draft is a throwaway
 * "ask about this selection" Thread, so it wants the most READ-ONLY posture the
 * agent advertises: `chat` (2.18's read-only conversational mode) is gone at
 * vibe-acp 2.24.1 and `plan` ("Read-only agent for exploration and planning") is
 * now the closest thing (#427, acp-capture §14.0). `ask` (2.24.1) / `default`
 * (2.18.0) are the same approval-gated posture under two names and are the last
 * resort — the session default, staged explicitly rather than by omission.
 * Nothing here is ever INVENTED: an id absent from `availableModes` is skipped.
 */
const SIDE_DRAFT_MODE_PREFERENCE = ['chat', 'plan', 'ask', 'default'] as const

/**
 * Snapshot safe Side Draft intent without creating a session. Mode takes the first
 * advertised id from `SIDE_DRAFT_MODE_PREFERENCE`; Model and Reasoning effort
 * inherit the source Thread's advertised current ids. Missing ids are omitted,
 * never invented.
 */
export function snapshotSideDraftControls(
  source: ThreadAgentControls,
): SideDraftControlSnapshot {
  const snapshot: SideDraftControlSnapshot = {}
  const mode = SIDE_DRAFT_MODE_PREFERENCE.find((id) =>
    source.modes?.availableModes.some((advertised) => advertised.id === id),
  )
  if (mode) snapshot.mode = mode
  if (
    source.models?.availableModels.some(
      (model) => model.modelId === source.models?.currentModelId,
    )
  ) {
    snapshot.model = source.models.currentModelId
  }
  if (
    source.reasoningEffort?.options.some(
      (option) => option.value === source.reasoningEffort?.current,
    )
  ) {
    snapshot.reasoningEffort = source.reasoningEffort.current
  }
  return snapshot
}
