import { describe, expect, it } from 'vitest'
import {
  clearMessageSelection,
  deriveMessageSelection,
  type MessageSelectionBoundary,
} from './message-selection'

const USER_MESSAGE: MessageSelectionBoundary = {
  messageId: 'user:7',
  role: 'user',
}

const AGENT_MESSAGE: MessageSelectionBoundary = {
  messageId: 'agent:9',
  role: 'agent',
}

const THREAD = {
  id: 'thread-3',
  title: 'Investigate parser failure',
}

describe('deriveMessageSelection', () => {
  it('keeps selected message text verbatim and adds human-readable Thread provenance', () => {
    expect(
      deriveMessageSelection({
        text: '  retain exact spacing\n```ts\nconst answer = 42\n```  ',
        anchor: AGENT_MESSAGE,
        focus: AGENT_MESSAGE,
        thread: THREAD,
      }),
    ).toEqual({
      text: '  retain exact spacing\n```ts\nconst answer = 42\n```  ',
      source: {
        messageId: 'agent:9',
        role: 'agent',
        threadId: 'thread-3',
        threadTitle: 'Investigate parser failure',
      },
    })
  })

  it('accepts a user Message selection', () => {
    expect(
      deriveMessageSelection({
        text: 'Why does this fail?',
        anchor: USER_MESSAGE,
        focus: USER_MESSAGE,
        thread: THREAD,
      }),
    ).toMatchObject({
      text: 'Why does this fail?',
      source: { role: 'user', messageId: 'user:7' },
    })
  })

  it('rejects empty and whitespace-only selections', () => {
    for (const text of ['', '  \n\t ']) {
      expect(
        deriveMessageSelection({
          text,
          anchor: USER_MESSAGE,
          focus: USER_MESSAGE,
          thread: THREAD,
        }),
      ).toBeNull()
    }
  })

  it('rejects selections whose endpoints are in different messages', () => {
    expect(
      deriveMessageSelection({
        text: 'cross-message text',
        anchor: USER_MESSAGE,
        focus: AGENT_MESSAGE,
        thread: THREAD,
      }),
    ).toBeNull()
  })

  it('rejects selections with an endpoint outside eligible Message content', () => {
    expect(
      deriveMessageSelection({
        text: 'tool or status text',
        anchor: USER_MESSAGE,
        focus: null,
        thread: THREAD,
      }),
    ).toBeNull()
  })
})

describe('clearMessageSelection', () => {
  it('makes the dismissed browser selection unavailable to a later refresh', () => {
    let selectedText = 'This selection was dismissed'
    const browserSelection = {
      removeAllRanges() {
        selectedText = ''
      },
    }

    clearMessageSelection(browserSelection)

    expect(
      deriveMessageSelection({
        text: selectedText,
        anchor: AGENT_MESSAGE,
        focus: AGENT_MESSAGE,
        thread: THREAD,
      }),
    ).toBeNull()
  })

  it('is safe when the browser has no Selection', () => {
    expect(() => clearMessageSelection(null)).not.toThrow()
  })
})
