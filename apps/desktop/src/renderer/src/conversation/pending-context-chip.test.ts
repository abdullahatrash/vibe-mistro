import { describe, expect, it } from 'vitest'
import {
  pendingContextChipLabel,
  pendingContextChipRemoveLabel,
  pendingContextChipTitle,
} from './pending-context-chip'
import type { MessageSelectionContext } from './pending-contexts'

const selection: MessageSelectionContext = {
  kind: 'message-selection',
  id: 'selection:1',
  text: 'The exact selected excerpt',
  source: {
    messageId: 'message-4',
    role: 'agent',
    threadId: 'thread-source',
    threadTitle: 'Reducer investigation',
  },
}

describe('Message-selection composer chip presentation', () => {
  it('uses the compact selection count and an unambiguous remove label', () => {
    expect(pendingContextChipLabel(selection)).toBe('1 selection')
    expect(pendingContextChipRemoveLabel(selection)).toBe('Remove selection')
  })

  it('makes the source Thread, source role, and selected excerpt inspectable', () => {
    expect(pendingContextChipTitle(selection)).toBe(
      'Source Thread: Reducer investigation\nSource role: Agent\n\nThe exact selected excerpt',
    )
  })
})
