import { describe, expect, it } from 'vitest'
import type { ThreadAgentControls } from '../shared/ipc'
import { applyPendingThreadControls } from './pending-thread-controls'

const CONTROLS: ThreadAgentControls = {
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

describe('applyPendingThreadControls', () => {
  it('awaits advertised setters in stable order before the caller starts session/prompt', async () => {
    const calls: string[] = []
    const controls = await applyPendingThreadControls(
      {
        async setMode(_sessionId, value) {
          calls.push(`mode:${value}`)
        },
        async setModel(_sessionId, value) {
          calls.push(`model:${value}`)
        },
        async setReasoningEffort(_sessionId, value) {
          calls.push(`reasoning:${value}`)
        },
      },
      'session-1',
      { mode: 'chat', model: 'small', reasoningEffort: 'low' },
      CONTROLS,
    )
    calls.push('prompt')

    expect(calls).toEqual(['mode:chat', 'model:small', 'reasoning:low', 'prompt'])
    expect(controls.modes?.currentModeId).toBe('chat')
    expect(controls.models?.currentModelId).toBe('small')
    expect(controls.reasoningEffort?.current).toBe('low')
  })

  it('never calls a setter for no-longer-advertised values', async () => {
    const calls: string[] = []
    const controls = await applyPendingThreadControls(
      {
        async setMode() {
          calls.push('mode')
        },
        async setModel() {
          calls.push('model')
        },
        async setReasoningEffort() {
          calls.push('reasoning')
        },
      },
      'session-1',
      { mode: 'removed', model: 'removed', reasoningEffort: 'removed' },
      CONTROLS,
    )

    expect(calls).toEqual([])
    expect(controls).toBe(CONTROLS)
  })

  it('keeps the reported value when an advertised setter rejects and continues safely', async () => {
    const errors: string[] = []
    const controls = await applyPendingThreadControls(
      {
        async setMode() {
          throw new Error('mode rejected')
        },
        async setModel() {},
        async setReasoningEffort() {},
      },
      'session-1',
      { mode: 'chat' },
      CONTROLS,
      (error) => errors.push(error instanceof Error ? error.message : String(error)),
    )

    expect(errors).toEqual(['mode rejected'])
    expect(controls.modes?.currentModeId).toBe('default')
  })
})
