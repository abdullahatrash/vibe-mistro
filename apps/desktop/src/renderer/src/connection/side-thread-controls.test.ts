import { describe, expect, it } from 'vitest'
import type { ThreadAgentControls } from '../../../shared/ipc'
import { snapshotSideDraftControls } from './side-thread-controls'

function advertisedControls(modeIds: string[]): ThreadAgentControls {
  return {
    modes: {
      currentModeId: 'plan',
      availableModes: modeIds.map((id) => ({ id, name: id })),
    },
    models: {
      currentModelId: 'devstral-small',
      availableModels: [
        { modelId: 'mistral-medium-3.5', name: 'Medium' },
        { modelId: 'devstral-small', name: 'Small' },
      ],
    },
    reasoningEffort: {
      current: 'high',
      options: [{ value: 'low' }, { value: 'high' }],
    },
  }
}

describe('snapshotSideDraftControls', () => {
  it('prefers advertised Chat Mode and snapshots source Model and Reasoning effort', () => {
    const source = advertisedControls(['default', 'plan', 'chat'])
    const snapshot = snapshotSideDraftControls(source)
    expect(snapshot).toEqual({
      mode: 'chat',
      model: 'devstral-small',
      reasoningEffort: 'high',
    })
    if (source.models) source.models.currentModelId = 'mistral-medium-3.5'
    if (source.reasoningEffort) source.reasoningEffort.current = 'low'
    expect(snapshot).toEqual({
      mode: 'chat',
      model: 'devstral-small',
      reasoningEffort: 'high',
    })
  })

  it('stages advertised default Mode when Chat is unavailable', () => {
    expect(snapshotSideDraftControls(advertisedControls(['default', 'plan']))).toEqual({
      mode: 'default',
      model: 'devstral-small',
      reasoningEffort: 'high',
    })
  })

  it('omits Mode rather than inventing default when neither Chat nor default is advertised', () => {
    expect(snapshotSideDraftControls(advertisedControls(['plan']))).toEqual({
      model: 'devstral-small',
      reasoningEffort: 'high',
    })
  })

  it('never snapshots current values missing from their advertised option lists', () => {
    const controls = advertisedControls(['default', 'chat'])
    if (controls.models) controls.models.currentModelId = 'removed-model'
    if (controls.reasoningEffort) controls.reasoningEffort.current = 'removed-effort'

    expect(snapshotSideDraftControls(controls)).toEqual({ mode: 'chat' })
  })
})
