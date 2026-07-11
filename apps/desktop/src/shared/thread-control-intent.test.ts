import { describe, expect, it } from 'vitest'
import type { ThreadAgentControls } from './ipc'
import {
  controlsWithCurrentValue,
  validatedThreadControlChanges,
} from './thread-control-intent'

const BOUND: ThreadAgentControls = {
  modes: {
    currentModeId: 'default',
    availableModes: [
      { id: 'default', name: 'Default' },
      { id: 'chat', name: 'Chat' },
    ],
  },
  models: {
    currentModelId: 'medium',
    availableModels: [
      { modelId: 'medium', name: 'Medium' },
      { modelId: 'small', name: 'Small' },
    ],
  },
  reasoningEffort: {
    current: 'high',
    options: [{ value: 'low' }, { value: 'high' }],
  },
}

describe('validatedThreadControlChanges', () => {
  it('emits advertised changed ids in stable setter order', () => {
    expect(
      validatedThreadControlChanges(
        { mode: 'chat', model: 'small', reasoningEffort: 'low' },
        BOUND,
      ),
    ).toEqual([
      { axis: 'mode', value: 'chat' },
      { axis: 'model', value: 'small' },
      { axis: 'reasoningEffort', value: 'low' },
    ])
  })

  it('skips no-longer-advertised, unadvertised-axis, and already-current values', () => {
    expect(
      validatedThreadControlChanges(
        { mode: 'removed', model: 'medium', reasoningEffort: 'removed' },
        BOUND,
      ),
    ).toEqual([])
    expect(
      validatedThreadControlChanges(
        { mode: 'chat', model: 'small', reasoningEffort: 'low' },
        { modes: null, models: null, reasoningEffort: null },
      ),
    ).toEqual([])
  })
})

describe('controlsWithCurrentValue', () => {
  it('projects a successful setter without changing advertised option lists or siblings', () => {
    const next = controlsWithCurrentValue(BOUND, 'model', 'small')
    expect(next.models?.currentModelId).toBe('small')
    expect(next.models?.availableModels).toBe(BOUND.models?.availableModels)
    expect(next.modes).toBe(BOUND.modes)
    expect(next.reasoningEffort).toBe(BOUND.reasoningEffort)
  })
})
