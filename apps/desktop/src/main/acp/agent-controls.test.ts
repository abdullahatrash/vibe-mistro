import { describe, expect, it } from 'vitest'
import {
  extractConfigSelect,
  extractThreadControls,
  hasConfigOption,
  missingControlAxes,
} from './agent-controls'

/** The verbatim 2.24.1 `session/new` shape (acp-capture §14.0) — no `models` block. */
const CONFIG_OPTIONS_2_24 = [
  {
    id: 'mode',
    name: 'Session Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'ask',
    options: [
      { value: 'ask', name: 'Ask', description: 'Requires approval for tool executions' },
      { value: 'plan', name: 'Plan', description: 'Read-only agent for exploration and planning' },
    ],
  },
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'mistral-medium-3.5',
    options: [
      { value: 'mistral-medium-3.5', name: 'mistral-medium-3.5', description: 'mistral-vibe-cli-latest' },
      { value: 'devstral-small', name: 'devstral-small', description: 'devstral-small-latest' },
    ],
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thinking',
    type: 'select',
    currentValue: 'medium',
    options: [{ value: 'off', name: 'Off' }, { value: 'medium', name: 'Medium' }],
  },
]

const MODES_2_24 = {
  currentModeId: 'ask',
  availableModes: [
    { id: 'ask', name: 'Ask', description: 'Requires approval for tool executions' },
    { id: 'plan', name: 'Plan', description: 'Read-only agent for exploration and planning' },
  ],
}

describe('extractConfigSelect', () => {
  it('normalises a select into current + options', () => {
    expect(extractConfigSelect(CONFIG_OPTIONS_2_24, 'thinking')).toEqual({
      current: 'medium',
      options: [
        { value: 'off', name: 'Off', description: undefined },
        { value: 'medium', name: 'Medium', description: undefined },
      ],
    })
  })

  it('returns null for an absent id, a non-array, or a non-string currentValue', () => {
    expect(extractConfigSelect(CONFIG_OPTIONS_2_24, 'nope')).toBeNull()
    expect(extractConfigSelect('not-an-array', 'model')).toBeNull()
    expect(extractConfigSelect([{ id: 'model', currentValue: 7 }], 'model')).toBeNull()
  })

  it('drops malformed options rather than the whole axis', () => {
    const select = extractConfigSelect(
      [{ id: 'model', currentValue: 'a', options: [{ value: 'a' }, null, { name: 'no value' }] }],
      'model',
    )
    expect(select?.options).toEqual([{ value: 'a', name: undefined, description: undefined }])
  })
})

describe('hasConfigOption', () => {
  it('reports whether the axis can go through session/set_config_option', () => {
    expect(hasConfigOption(CONFIG_OPTIONS_2_24, 'model')).toBe(true)
    expect(hasConfigOption(CONFIG_OPTIONS_2_24, 'mode')).toBe(true)
    expect(hasConfigOption([{ id: 'thinking' }], 'model')).toBe(false)
    expect(hasConfigOption(undefined, 'model')).toBe(false)
  })
})

describe('extractThreadControls', () => {
  it('reads Model from the model configOption when 2.24.1 sends no models block (#427)', () => {
    const controls = extractThreadControls({ modes: MODES_2_24, configOptions: CONFIG_OPTIONS_2_24 })
    expect(controls.models).toEqual({
      currentModelId: 'mistral-medium-3.5',
      availableModels: [
        { modelId: 'mistral-medium-3.5', name: 'mistral-medium-3.5' },
        { modelId: 'devstral-small', name: 'devstral-small' },
      ],
    })
    expect(controls.modes).toEqual(MODES_2_24)
    expect(controls.reasoningEffort).toEqual({
      current: 'medium',
      options: [{ value: 'off', name: 'Off' }, { value: 'medium', name: 'Medium' }],
    })
  })

  it('still prefers a legacy top-level models block (2.18.0 binaries)', () => {
    const models = {
      currentModelId: 'devstral-small',
      availableModels: [{ modelId: 'devstral-small', name: 'devstral-small' }],
    }
    expect(extractThreadControls({ models, configOptions: CONFIG_OPTIONS_2_24 }).models).toBe(models)
  })

  it('derives Modes from the mode configOption when no modes block is sent', () => {
    expect(extractThreadControls({ configOptions: CONFIG_OPTIONS_2_24 }).modes).toEqual(MODES_2_24)
  })

  it('leaves every axis null when the agent advertises none', () => {
    expect(extractThreadControls({})).toEqual({ modes: null, models: null, reasoningEffort: null })
  })
})

describe('missingControlAxes', () => {
  it('names the axes the agent advertises nothing for', () => {
    expect(missingControlAxes(extractThreadControls({ configOptions: CONFIG_OPTIONS_2_24 }))).toEqual([])
    // The exact 2.24.1 drift: modes still sent, Model nowhere to be found.
    expect(
      missingControlAxes(extractThreadControls({ modes: MODES_2_24, configOptions: [{ id: 'thinking' }] })),
    ).toEqual(['model', 'reasoningEffort'])
    expect(missingControlAxes(extractThreadControls({}))).toEqual(['mode', 'model', 'reasoningEffort'])
  })
})
