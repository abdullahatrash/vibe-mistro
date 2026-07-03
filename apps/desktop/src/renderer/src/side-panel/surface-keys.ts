import type { SingletonKind } from './side-panel-store'

/** The subset of a `KeyboardEvent` the shortcut matcher reads (DOM-free for testing). */
export interface KeyChord {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

/**
 * Which Surface a keydown toggles, or `null` when the chord is unbound. Renderer-level
 * shortcuts (NO Electron menu accelerators, ADR-0013 decision 1):
 *   - ⌘P  → Files   (the tree-search focus part lands in slice 2)
 *   - ⌃⇧G → Review
 *   - ⌘T  → Browser (#217)
 *   - ⌘J  → Terminal (the VS Code chord; pairs with the header Terminal button)
 *
 * Every bound chord carries a modifier, so plain typing never matches: a focused text
 * input can be left to type normally EXCEPT these combos (none is a typing combo), which
 * stay live even while a textarea has focus.
 */
export function surfaceForChord(chord: KeyChord): SingletonKind | 'browser' | 'terminal' | null {
  const key = chord.key.toLowerCase()
  // ⌘P → Files. Meta only (no ctrl/alt/shift) so ⌘⇧P and ⌃P stay free.
  if (key === 'p' && chord.metaKey && !chord.ctrlKey && !chord.altKey && !chord.shiftKey) {
    return 'files'
  }
  // ⌘T → Browser. Meta only, so ⌘⇧T (reopen-tab muscle memory) and ⌃T stay free.
  if (key === 't' && chord.metaKey && !chord.ctrlKey && !chord.altKey && !chord.shiftKey) {
    return 'browser'
  }
  // ⌘J → Terminal. Meta only, so ⌘⇧J and ⌃J stay free.
  if (key === 'j' && chord.metaKey && !chord.ctrlKey && !chord.altKey && !chord.shiftKey) {
    return 'terminal'
  }
  // ⌃⇧G → Review. Ctrl+Shift only (no meta/alt).
  if (key === 'g' && chord.ctrlKey && chord.shiftKey && !chord.metaKey && !chord.altKey) {
    return 'review'
  }
  return null
}
