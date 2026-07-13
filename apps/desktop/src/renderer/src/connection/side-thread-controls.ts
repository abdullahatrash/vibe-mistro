import type { ThreadAgentControls, ThreadConfigAxis } from '../../../shared/ipc'

export type SideDraftControlSnapshot = Partial<Record<ThreadConfigAxis, string>>

/**
 * Snapshot safe Side Draft intent without creating a session. Chat is preferred,
 * advertised `default` is the Mode fallback, and Model/Reasoning effort inherit the
 * source Thread's advertised current ids. Missing ids are omitted, never invented.
 */
export function snapshotSideDraftControls(
  source: ThreadAgentControls,
): SideDraftControlSnapshot {
  const snapshot: SideDraftControlSnapshot = {}
  if (source.modes?.availableModes.some((mode) => mode.id === 'chat')) snapshot.mode = 'chat'
  else if (source.modes?.availableModes.some((mode) => mode.id === 'default')) {
    snapshot.mode = 'default'
  }
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
