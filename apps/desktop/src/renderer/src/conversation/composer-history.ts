import { extractPromptContexts } from './pending-contexts'

export type ComposerHistoryDirection = 'previous' | 'next'
export type ComposerCaretLine = 'only' | 'first' | 'middle' | 'last'

export interface ComposerHistoryState {
  /** Chronological entry index, or null while editing the current scratch draft. */
  cursor: number | null
  /** The unsent value captured when history navigation begins. */
  scratch: string
}

export interface ComposerHistoryNavigation {
  state: ComposerHistoryState
  value: string
}

export interface ComposerHistoryEditState {
  state: ComposerHistoryState
  appliedValue: string | null
}

const TERMINAL_CONTEXT_OPEN = '<terminal_context>'
const TERMINAL_CONTEXT_CLOSE = '</terminal_context>'

/** A fresh per-Thread history cursor. Callers own the state; this module has no singleton. */
export function createComposerHistoryState(): ComposerHistoryState {
  return { cursor: null, scratch: '' }
}

/** Leave recall mode after a send, restoring the same fresh state used on Thread mount. */
export function resetComposerHistoryState(): ComposerHistoryState {
  return createComposerHistoryState()
}

/**
 * Keep the cursor through controlled-editor echoes of a recalled value, but leave recall mode as
 * soon as the user actually edits it. The caller stores the returned applied-value marker.
 */
export function reconcileComposerHistoryEdit(
  state: ComposerHistoryState,
  appliedValue: string | null,
  nextValue: string,
): ComposerHistoryEditState {
  if (appliedValue !== null && appliedValue === nextValue) return { state, appliedValue }
  return { state: resetComposerHistoryState(), appliedValue: null }
}

/** Strip the supporting Terminal context appended after the visible prompt at send time. */
function stripTrailingTerminalContext(text: string): string {
  const trimmed = text.trimEnd()
  if (!trimmed.endsWith(TERMINAL_CONTEXT_CLOSE)) return text
  const open = trimmed.lastIndexOf(TERMINAL_CONTEXT_OPEN)
  if (open === -1) return text
  return trimmed.slice(0, open).replace(/\n+$/, '')
}

/**
 * Convert chronological wire prompts into recallable visible text. Context attachments are
 * deliberately NOT recalled: old images, terminal output, browser picks, and review comments may
 * be stale or expensive to resend. Consecutive duplicate visible prompts collapse shell-style.
 */
export function buildComposerHistoryEntries(wirePrompts: readonly string[]): string[] {
  const entries: string[] = []
  for (const wirePrompt of wirePrompts) {
    const withoutTerminal = stripTrailingTerminalContext(wirePrompt)
    const visible = extractPromptContexts(withoutTerminal).cleanText.trim()
    if (visible.length === 0 || entries.at(-1) === visible) continue
    entries.push(visible)
  }
  return entries
}

/**
 * Move through chronological sent prompts. The first Previous captures the current unsent scratch;
 * Next past the newest entry restores it. Null means the requested direction has no history action.
 */
export function navigateComposerHistory(
  entries: readonly string[],
  state: ComposerHistoryState,
  currentValue: string,
  direction: ComposerHistoryDirection,
): ComposerHistoryNavigation | null {
  if (direction === 'next' && state.cursor === null) return null
  if (entries.length === 0) return null

  if (direction === 'previous') {
    const nextCursor = state.cursor === null
      ? entries.length - 1
      : Math.max(0, Math.min(state.cursor - 1, entries.length - 1))
    return {
      state: {
        cursor: nextCursor,
        scratch: state.cursor === null ? currentValue : state.scratch,
      },
      value: entries[nextCursor],
    }
  }

  const currentCursor = Math.min(state.cursor as number, entries.length - 1)
  if (currentCursor === entries.length - 1) {
    return { state: createComposerHistoryState(), value: state.scratch }
  }
  const nextCursor = currentCursor + 1
  return {
    state: { cursor: nextCursor, scratch: state.scratch },
    value: entries[nextCursor],
  }
}

/** Autocomplete owns arrows first; history only owns a collapsed caret at the outer visual line. */
export function shouldNavigateComposerHistory({
  direction,
  autocompleteOpen,
  selectionCollapsed,
  caretLine,
}: {
  direction: ComposerHistoryDirection
  autocompleteOpen: boolean
  selectionCollapsed: boolean
  caretLine: ComposerCaretLine | null
}): boolean {
  if (autocompleteOpen || !selectionCollapsed || caretLine === null || caretLine === 'middle') {
    return false
  }
  if (caretLine === 'only') return true
  return direction === 'previous' ? caretLine === 'first' : caretLine === 'last'
}
