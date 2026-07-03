import { EDITORS, type EditorId } from '../../../shared/editors'
import type { EditorsOpenResult } from '../../../shared/ipc'

/**
 * Pure logic behind the header's Open-in-editor affordance (#252): choose which
 * detected editor the button opens, and word a launch failure for the header's
 * transient status text. Slice 2 (#253) replaces `firstAvailableEditor` with the
 * stored-preference resolution (stored-if-still-available, else this same
 * table-order fallback) — keep the fallback semantics here when it lands.
 */

export interface EditorChoice {
  id: EditorId
  label: string
}

/**
 * The editor slice 1's button opens: the FIRST available one in `EDITORS` table
 * (= preference) order. Re-derived against the table rather than trusting the
 * wire's ordering, so a reordered or hand-crafted list can't change the pick.
 */
export function firstAvailableEditor(available: readonly EditorId[]): EditorChoice | null {
  const set = new Set(available)
  const editor = EDITORS.find((e) => set.has(e.id))
  return editor ? { id: editor.id, label: editor.label } : null
}

type OpenFailureReason = Extract<EditorsOpenResult, { ok: false }>['reason']

/** A short human line for each typed `editorsOpen` failure (never a silent no-op). */
export function openFailureMessage(reason: OpenFailureReason, editorLabel: string): string {
  switch (reason) {
    case 'command-not-found':
      return `${editorLabel} CLI not found on PATH`
    case 'spawn-failed':
      return `Couldn't launch ${editorLabel}`
    case 'unknown-workspace':
      return 'Project not found'
    case 'unknown-editor':
      return 'Unknown editor'
  }
}
