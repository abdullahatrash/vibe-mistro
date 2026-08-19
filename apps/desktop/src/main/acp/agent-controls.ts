import type {
  ThreadAgentControls,
  ThreadConfigAxis,
  ThreadModels,
  ThreadModes,
  ThreadReasoningEffort,
} from '../../shared/ipc'

/**
 * Mapping `session/new` / `session/load` results onto the three agent-control
 * axes (Mode / Model / Reasoning effort), and telling the caller which axes the
 * agent did NOT advertise.
 *
 * The shapes moved under us between vibe-acp 2.18.0 and 2.24.1 (#427,
 * acp-capture §14.0): the top-level `models` block is GONE and Model now lives
 * only in `configOptions[id="model"]`. Every axis therefore reads
 * `configOptions` first-class here, with the legacy top-level blocks kept as a
 * fallback for older binaries. Both drifts failed SILENTLY in the app (a missing
 * `models` block just hid the picker), so `missingControlAxes` exists to make the
 * next such drift loud instead of invisible.
 */

/** `configOptions[].id`s we map onto our axes (acp-capture §2/§10/§14.0). */
export const MODE_CONFIG_ID = 'mode'
export const MODEL_CONFIG_ID = 'model'
export const REASONING_EFFORT_CONFIG_ID = 'thinking'

/** The `session/new` / `session/load` fields the controls are read from. */
export interface SessionControlsSource {
  modes?: unknown
  models?: unknown
  configOptions?: unknown
}

/** One `type: "select"` config option, normalised. */
interface ConfigSelect {
  current: string
  options: { value: string; name?: string; description?: string }[]
}

/**
 * Normalise `configOptions[id=configId]` into `{current, options}`. Returns null
 * on any absent/malformed shape (no array, no such id, non-string `currentValue`)
 * so a caller omits the axis rather than rendering a broken control.
 */
export function extractConfigSelect(configOptions: unknown, configId: string): ConfigSelect | null {
  const option = findConfigOption(configOptions, configId)
  if (!option || typeof option.currentValue !== 'string') return null
  const options = Array.isArray(option.options)
    ? option.options
        .filter(
          (opt): opt is { value: string; name?: unknown; description?: unknown } =>
            !!opt && typeof opt === 'object' && typeof (opt as { value?: unknown }).value === 'string',
        )
        .map((opt) => ({
          value: opt.value,
          name: typeof opt.name === 'string' ? opt.name : undefined,
          description: typeof opt.description === 'string' ? opt.description : undefined,
        }))
    : []
  return { current: option.currentValue, options }
}

/**
 * Whether the agent advertises `configId` as a config option — i.e. whether the
 * axis can be changed through the VALIDATING `session/set_config_option` setter
 * rather than a legacy dedicated method (`session/set_mode` / `session/set_model`).
 */
export function hasConfigOption(configOptions: unknown, configId: string): boolean {
  return findConfigOption(configOptions, configId) !== null
}

/**
 * Map a session result onto the full controls bundle. Each axis prefers the
 * agent's own top-level block (2.18.0 shape, still sent for `modes` at 2.24.1)
 * and falls back to the matching config option — which is the ONLY place Model
 * lives at 2.24.1. An axis the agent advertises nowhere stays null.
 */
export function extractThreadControls(source: SessionControlsSource): ThreadAgentControls {
  return {
    modes: extractModes(source),
    models: extractModels(source),
    reasoningEffort: extractReasoningEffort(source.configOptions),
  }
}

/** Modes from the top-level block, else from the `mode` config option. */
function extractModes(source: SessionControlsSource): ThreadModes | null {
  if (source.modes && typeof source.modes === 'object') return source.modes as ThreadModes
  const select = extractConfigSelect(source.configOptions, MODE_CONFIG_ID)
  if (!select) return null
  return {
    currentModeId: select.current,
    availableModes: select.options.map((opt) => ({
      id: opt.value,
      name: opt.name ?? opt.value,
      description: opt.description,
    })),
  }
}

/**
 * Models from the legacy top-level block, else from the `model` config option —
 * the 2.24.1 source of truth (#427). The option's `name` is the display label
 * and its `value` is the id we send back through `set_config_option`.
 */
function extractModels(source: SessionControlsSource): ThreadModels | null {
  if (source.models && typeof source.models === 'object') return source.models as ThreadModels
  const select = extractConfigSelect(source.configOptions, MODEL_CONFIG_ID)
  if (!select) return null
  return {
    currentModelId: select.current,
    availableModels: select.options.map((opt) => ({ modelId: opt.value, name: opt.name ?? opt.value })),
  }
}

/** The reasoning-effort axis (#66) — the `thinking` select. */
function extractReasoningEffort(configOptions: unknown): ThreadReasoningEffort | null {
  const select = extractConfigSelect(configOptions, REASONING_EFFORT_CONFIG_ID)
  if (!select) return null
  return {
    current: select.current,
    options: select.options.map((opt) => ({ value: opt.value, name: opt.name })),
  }
}

/**
 * The axes this session advertises NOTHING for — our drift tripwire (#427). Every
 * agent we support offers all three, so a non-empty result means the agent stopped
 * advertising what we expect (a renamed field, a removed block) and the matching
 * picker will silently vanish. Callers log it; nothing here throws, because a
 * missing axis must still degrade to "no picker", never to a broken Workspace.
 */
export function missingControlAxes(controls: ThreadAgentControls): ThreadConfigAxis[] {
  const missing: ThreadConfigAxis[] = []
  if (!controls.modes) missing.push('mode')
  if (!controls.models) missing.push('model')
  if (!controls.reasoningEffort) missing.push('reasoningEffort')
  return missing
}

/** The raw `configOptions` entry for an id, or null when absent/malformed. */
function findConfigOption(
  configOptions: unknown,
  configId: string,
): { id: string; currentValue?: unknown; options?: unknown } | null {
  if (!Array.isArray(configOptions)) return null
  const found = configOptions.find(
    (o): o is { id: string; currentValue?: unknown; options?: unknown } =>
      !!o && typeof o === 'object' && (o as { id?: unknown }).id === configId,
  )
  return found ?? null
}
