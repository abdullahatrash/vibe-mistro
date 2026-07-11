import type { ComposerCaretLine } from './composer-history'

export interface ComposerEditorSelection {
  collapsed: boolean
  caretLine: ComposerCaretLine | null
}

export interface ComposerEditorHandle {
  getSelectionStart(): number | null
  getSelection(): ComposerEditorSelection | null
  focus(): void
  setSelectionRange(start: number, end: number): void
}
