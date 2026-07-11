/** A Message role in the user-facing conversation (ACP calls agent output "assistant"). */
export type MessageSelectionRole = 'user' | 'agent'

/** Identity stamped on one eligible user/agent Message content boundary. */
export interface MessageSelectionBoundary {
  messageId: string
  role: MessageSelectionRole
}

/** Provenance retained when a selected excerpt becomes context for another Thread. */
export interface MessageSelectionSource extends MessageSelectionBoundary {
  threadId: string
  threadTitle: string
}

/** A verbatim, non-empty excerpt selected within exactly one eligible Message. */
export interface MessageSelection {
  text: string
  source: MessageSelectionSource
}

/** The browser Selection capability dismissal needs, kept structural for node tests. */
export interface ClearableMessageSelection {
  removeAllRanges(): void
}

/**
 * Public, DOM-free Message-selection seam. Browser selection handling only has to
 * locate its two endpoint boundaries; eligibility and provenance are decided here.
 */
export function deriveMessageSelection({
  text,
  anchor,
  focus,
  thread,
}: {
  text: string
  anchor: MessageSelectionBoundary | null
  focus: MessageSelectionBoundary | null
  thread: { id: string; title: string }
}): MessageSelection | null {
  if (text.trim().length === 0 || !anchor || !focus) return null
  if (anchor.messageId !== focus.messageId || anchor.role !== focus.role) return null

  return {
    text,
    source: {
      messageId: anchor.messageId,
      role: anchor.role,
      threadId: thread.id,
      threadTitle: thread.title,
    },
  }
}

/**
 * Dismiss the browser's source selection itself, not just its floating UI. A later
 * keyup/pointerup refresh therefore cannot resurrect the action for the same range.
 */
export function clearMessageSelection(selection: ClearableMessageSelection | null): void {
  selection?.removeAllRanges()
}
