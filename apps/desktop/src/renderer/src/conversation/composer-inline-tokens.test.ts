import { describe, expect, it } from 'vitest'
import {
  coerceInlineTokens,
  serializeInlineTokensForSend,
  setSlashCommandInlineToken,
} from './composer-inline-tokens'

describe('setSlashCommandInlineToken', () => {
  it('adds one start-anchored slash command token', () => {
    expect(setSlashCommandInlineToken([], { name: 'teach', description: 'Teach mode' })).toEqual([
      { kind: 'slashCommand', name: 'teach', description: 'Teach mode' },
    ])
  })

  it('replaces an existing slash command token', () => {
    expect(
      setSlashCommandInlineToken([{ kind: 'slashCommand', name: 'teach' }], {
        name: 'review',
      }),
    ).toEqual([{ kind: 'slashCommand', name: 'review', description: undefined }])
  })
})

describe('coerceInlineTokens', () => {
  it('keeps only the first valid slash command token', () => {
    expect(
      coerceInlineTokens([
        { kind: 'slashCommand', name: 'teach' },
        { kind: 'slashCommand', name: 'review' },
        { kind: 'slashCommand' },
        null,
      ]),
    ).toEqual([{ kind: 'slashCommand', name: 'teach', description: undefined }])
  })
})

describe('serializeInlineTokensForSend', () => {
  it('emits a bare slash command when the prompt body is empty', () => {
    expect(serializeInlineTokensForSend('', [{ kind: 'slashCommand', name: 'teach' }])).toBe(
      '/teach',
    )
  })

  it('prepends the slash command exactly once before prompt body text', () => {
    expect(
      serializeInlineTokensForSend('explain this', [{ kind: 'slashCommand', name: 'teach' }]),
    ).toBe('/teach explain this')
  })

  it('does not duplicate a command already present in prompt text', () => {
    expect(
      serializeInlineTokensForSend('/teach explain this', [
        { kind: 'slashCommand', name: 'teach' },
      ]),
    ).toBe('/teach explain this')
  })
})
