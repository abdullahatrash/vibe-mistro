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

  it('stages read-only Plan Mode on a 2.24.1 agent, which advertises no Chat (#427)', () => {
    expect(snapshotSideDraftControls(advertisedControls(['ask', 'plan', 'accept-edits']))).toEqual({
      mode: 'plan',
      model: 'devstral-small',
      reasoningEffort: 'high',
    })
  })

  it('falls back to the approval-gated Mode under either of its names', () => {
    expect(snapshotSideDraftControls(advertisedControls(['ask', 'accept-edits'])).mode).toBe('ask')
    expect(snapshotSideDraftControls(advertisedControls(['default', 'accept-edits'])).mode).toBe(
      'default',
    )
  })

  it('omits Mode rather than inventing one when no preferred id is advertised', () => {
    expect(snapshotSideDraftControls(advertisedControls(['accept-edits', 'auto-approve']))).toEqual({
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
