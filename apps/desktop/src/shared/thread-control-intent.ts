import type { ThreadAgentControls } from './ipc/core'
import type { ThreadConfigAxis, ThreadControlIntent } from './ipc/thread'

export interface ThreadControlChange {
  axis: ThreadConfigAxis
  value: string
}

/** Whether a session explicitly advertises one Agent-control id/value. */
export function isAdvertisedThreadControlValue(
  controls: ThreadAgentControls,
  axis: ThreadConfigAxis,
  value: string,
): boolean {
  if (axis === 'mode') return controls.modes?.availableModes.some((mode) => mode.id === value) ?? false
  if (axis === 'model') {
    return controls.models?.availableModels.some((model) => model.modelId === value) ?? false
  }
  return controls.reasoningEffort?.options.some((option) => option.value === value) ?? false
}

function currentValue(controls: ThreadAgentControls, axis: ThreadConfigAxis): string | null {
  if (axis === 'mode') return controls.modes?.currentModeId ?? null
  if (axis === 'model') return controls.models?.currentModelId ?? null
  return controls.reasoningEffort?.current ?? null
}

/** Advertised, changed intent in deterministic ACP setter order. */
export function validatedThreadControlChanges(
  intent: ThreadControlIntent,
  controls: ThreadAgentControls,
): ThreadControlChange[] {
  const axes: ThreadConfigAxis[] = ['mode', 'model', 'reasoningEffort']
  return axes.flatMap((axis) => {
    const value = intent[axis]
    return value !== undefined &&
      value !== currentValue(controls, axis) &&
      isAdvertisedThreadControlValue(controls, axis, value)
      ? [{ axis, value }]
      : []
  })
}

/** Reflect one confirmed setter result while preserving every advertised option list. */
export function controlsWithCurrentValue(
  controls: ThreadAgentControls,
  axis: ThreadConfigAxis,
  value: string,
): ThreadAgentControls {
  if (axis === 'mode' && controls.modes) {
    return { ...controls, modes: { ...controls.modes, currentModeId: value } }
  }
  if (axis === 'model' && controls.models) {
    return { ...controls, models: { ...controls.models, currentModelId: value } }
  }
  if (axis === 'reasoningEffort' && controls.reasoningEffort) {
    return { ...controls, reasoningEffort: { ...controls.reasoningEffort, current: value } }
  }
  return controls
}
