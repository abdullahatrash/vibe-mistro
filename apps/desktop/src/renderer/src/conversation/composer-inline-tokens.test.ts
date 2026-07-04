import { describe, expect, it } from 'vitest'
import {
  coerceInlineTokens,
  createTerminalInlineToken,
  insertTerminalInlineTokenAt,
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

  it('keeps valid terminal tokens with their supporting output', () => {
    expect(
      coerceInlineTokens([
        {
          kind: 'terminal',
          id: 'terminal:1',
          source: 'term-1',
          reference: '[terminal:term-1:1]',
          output: 'error: boom',
        },
        { kind: 'terminal', id: 'terminal:bad', source: '', reference: '[terminal]', output: 'x' },
      ]),
    ).toEqual([
      {
        kind: 'terminal',
        id: 'terminal:1',
        source: 'term-1',
        reference: '[terminal:term-1:1]',
        output: 'error: boom',
      },
    ])
  })
})

describe('insertTerminalInlineTokenAt', () => {
  it('inserts the visible terminal reference at the caret', () => {
    const token = createTerminalInlineToken({
      id: 'terminal:7',
      source: 'term-1',
      output: 'Traceback\n  line 1',
    })

    expect(insertTerminalInlineTokenAt('check  please', 6, token)).toEqual({
      value: 'check [terminal:term-1:7] please',
      caret: 25,
    })
  })

  it('adds word-boundary spacing when inserting inside prose', () => {
    const token = createTerminalInlineToken({
      id: 'terminal:2',
      source: 'term-2',
      output: 'error',
    })

    expect(insertTerminalInlineTokenAt('lookhere', 4, token)).toEqual({
      value: 'look [terminal:term-2:2] here',
      caret: 25,
    })
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

  it('appends terminal supporting context for visible terminal references', () => {
    expect(
      serializeInlineTokensForSend('inspect [terminal:term-1:3]', [
        {
          kind: 'terminal',
          id: 'terminal:3',
          source: 'term-1',
          reference: '[terminal:term-1:3]',
          output: 'error: boom\nat app.ts:4',
        },
      ]),
    ).toBe(
      'inspect [terminal:term-1:3]\n\n' +
        '<terminal_context>\n' +
        'Terminal output for [terminal:term-1:3] from term-1:\n' +
        'error: boom\n' +
        'at app.ts:4\n' +
        '</terminal_context>',
    )
  })

  it('does not send terminal supporting context after the visible reference is removed', () => {
    expect(
      serializeInlineTokensForSend('inspect this', [
        {
          kind: 'terminal',
          id: 'terminal:3',
          source: 'term-1',
          reference: '[terminal:term-1:3]',
          output: 'error: boom',
        },
      ]),
    ).toBe('inspect this')
  })
})
