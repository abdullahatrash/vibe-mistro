import { describe, it, expect } from 'vitest'
import type { BotRecord } from '../../../shared/ipc'
import {
  BOT_COLOURS,
  botCreateArgs,
  botUpdateArgs,
  canSubmitBotForm,
  DEFAULT_BOT_COLOUR,
  initialBotFormValues,
  isBotFormDirty,
  nextBotColour,
  validateBotForm,
  type BotFormValues,
} from './bot-form'
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
} from '../../../shared/bot-limits'

function bot(overrides: Partial<BotRecord> = {}): BotRecord {
  return {
    threadId: 'thread-rex',
    workspaceId: 'ws-1',
    profileId: 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    name: 'Rex',
    colour: '#e8734a',
    description: 'Reviews my diffs',
    instructions: 'Be blunt about correctness.',
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  }
}

function values(overrides: Partial<BotFormValues> = {}): BotFormValues {
  return {
    name: 'Rex',
    colour: DEFAULT_BOT_COLOUR,
    workspaceId: 'ws-1',
    description: '',
    instructions: '',
    ...overrides,
  }
}

describe('initialBotFormValues', () => {
  it('seeds a create from the selected Project', () => {
    const v = initialBotFormValues({ target: { mode: 'create', workspaceId: 'ws-7' }, bots: [] })
    expect(v).toMatchObject({ name: '', workspaceId: 'ws-7', instructions: '' })
  })

  it('seeds a create with no Project selected as an unpicked Project, not a guess', () => {
    const v = initialBotFormValues({ target: { mode: 'create', workspaceId: null }, bots: [] })
    expect(v.workspaceId).toBe('')
    expect(canSubmitBotForm(v)).toBe(false)
  })

  it('seeds an edit from the record, Project included', () => {
    const v = initialBotFormValues({ target: { mode: 'edit', threadId: 'thread-rex' }, bots: [bot()] })
    expect(v).toEqual({
      name: 'Rex',
      colour: '#e8734a',
      workspaceId: 'ws-1',
      description: 'Reviews my diffs',
      instructions: 'Be blunt about correctness.',
    })
  })

  it('falls back to an empty form when the record has vanished under it', () => {
    const v = initialBotFormValues({ target: { mode: 'edit', threadId: 'gone' }, bots: [bot()] })
    expect(v.name).toBe('')
  })
})

describe('nextBotColour', () => {
  it('picks the first unused palette colour so two new Bots never look alike', () => {
    expect(nextBotColour([])).toBe(BOT_COLOURS[0])
    expect(nextBotColour([bot({ colour: BOT_COLOURS[0] })])).toBe(BOT_COLOURS[1])
  })

  it('falls back to the default once every colour is taken', () => {
    const all = BOT_COLOURS.map((colour, i) => bot({ threadId: `t-${i}`, colour }))
    expect(nextBotColour(all)).toBe(DEFAULT_BOT_COLOUR)
  })
})

describe('validateBotForm', () => {
  it('accepts a name and a Project with nothing else', () => {
    expect(validateBotForm(values())).toEqual({})
    expect(canSubmitBotForm(values())).toBe(true)
  })

  it('requires a name', () => {
    expect(validateBotForm(values({ name: '   ' })).name).toBeDefined()
  })

  it('requires a Project — a Bot cannot exist without one', () => {
    expect(validateBotForm(values({ workspaceId: '' })).workspaceId).toBeDefined()
  })

  it('applies the SAME bounds main enforces', () => {
    expect(validateBotForm(values({ name: 'x'.repeat(BOT_NAME_MAX_LENGTH + 1) })).name).toBeDefined()
    expect(validateBotForm(values({ name: 'x'.repeat(BOT_NAME_MAX_LENGTH) })).name).toBeUndefined()
    expect(
      validateBotForm(values({ description: 'x'.repeat(BOT_DESCRIPTION_MAX_LENGTH + 1) })).description,
    ).toBeDefined()
    expect(
      validateBotForm(values({ instructions: 'x'.repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 1) })).instructions,
    ).toBeDefined()
  })

  it('refuses a line break in the name or the description — both are one-liners on the wire', () => {
    expect(validateBotForm(values({ name: 'Rex\nthe reviewer' })).name).toBeDefined()
    expect(validateBotForm(values({ description: 'one\ntwo' })).description).toBeDefined()
  })

  it('allows multi-line instructions — the persona is prose', () => {
    expect(validateBotForm(values({ instructions: 'line one\n\nline two' }))).toEqual({})
  })
})

describe('the payloads', () => {
  it('trims the one-line fields but never the instructions', () => {
    const v = values({ name: '  Rex  ', description: '  Reviews  ', instructions: '  keep\n  me  ' })
    expect(botCreateArgs(v)).toEqual({
      workspaceId: 'ws-1',
      name: 'Rex',
      colour: DEFAULT_BOT_COLOUR,
      description: 'Reviews',
      instructions: '  keep\n  me  ',
    })
  })

  it('never sends a Project or a profile id on an update', () => {
    const args = botUpdateArgs('thread-rex', values())
    expect(Object.keys(args).sort()).toEqual([
      'colour',
      'description',
      'instructions',
      'name',
      'threadId',
    ])
  })
})

describe('isBotFormDirty', () => {
  it('is false for an untouched edit', () => {
    const b = bot()
    expect(isBotFormDirty(initialBotFormValues({ target: { mode: 'edit', threadId: b.threadId }, bots: [b] }), b)).toBe(
      false,
    )
  })

  it('sees a rename, a recolour, and an instructions edit', () => {
    const b = bot()
    const from = initialBotFormValues({ target: { mode: 'edit', threadId: b.threadId }, bots: [b] })
    expect(isBotFormDirty({ ...from, name: 'Rexi' }, b)).toBe(true)
    expect(isBotFormDirty({ ...from, colour: '#4a90d9' }, b)).toBe(true)
    expect(isBotFormDirty({ ...from, instructions: 'Be kind.' }, b)).toBe(true)
  })

  it('ignores whitespace-only changes to the one-line fields', () => {
    const b = bot()
    const from = initialBotFormValues({ target: { mode: 'edit', threadId: b.threadId }, bots: [b] })
    expect(isBotFormDirty({ ...from, name: '  Rex  ' }, b)).toBe(false)
  })
})
