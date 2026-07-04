export interface ComposerEditorHandle {
  getSelectionStart(): number | null
  focus(): void
  setSelectionRange(start: number, end: number): void
}
