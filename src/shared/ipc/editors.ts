/**
 * Editors domain of the shared IPC contract (#252, epic #178): detect the external
 * editors installed on this machine and open a Workspace directory in one. The
 * id vocabulary + labels live in the curated `shared/editors` table — this module
 * only owns the wire shapes. Keep free of Node/DOM imports.
 */
import type { EditorId } from '../editors'

/** The editors channel entries, merged into the single `IPC` const in `./index`. */
export const editorsChannels = {
  /** Renderer -> main: LIST the installed editors (which-on-PATH probe) — see {@link EditorsListResult}. */
  editorsList: 'editors:list',
  /** Renderer -> main: OPEN a Workspace dir in an installed editor — see {@link EditorsOpenArgs}. */
  editorsOpen: 'editors:open',
} as const

/**
 * The `editorsList` reply: ids from the curated table whose CLI resolves on the
 * shell-env PATH, in table (= preference) order. Detected ONCE per app session and
 * cached in main — the installed set doesn't change mid-session, and re-probing
 * every alias on every render would be pure waste. Best-effort: a probe failure
 * degrades to an empty list (logged), never a throw.
 */
export interface EditorsListResult {
  editors: EditorId[]
}

/**
 * Args for `editorsOpen`: open the Workspace directory in one detected editor.
 * Addressed by `workspaceId` — main resolves the directory from its OWN
 * `MetadataStore` record, NOT a renderer-supplied path (the `filesList`/
 * `revealPath` model). Workspace-keyed rather than agent-keyed so the affordance
 * works whenever a project is selected — no warm agent required. `editorId` must
 * come from the curated table; launching is a detached spawn of a curated CLI on
 * the Workspace dir — user-trusted (parity with reveal-in-Finder), no
 * user-supplied command strings. NOT agent activity: no `pool.touch`, so opening
 * your editor never keeps a warm agent alive.
 */
export interface EditorsOpenArgs {
  workspaceId: string
  editorId: EditorId
}

/**
 * The `editorsOpen` reply — a typed result, never a silent no-op: `unknown-workspace`
 * (`workspaceId` not in the metadata index), `unknown-editor` (id not in the table),
 * `command-not-found` (no CLI alias resolves on the shell-env PATH anymore),
 * `spawn-failed` (the launch itself errored). Every failure is also logged in main;
 * the renderer surfaces it.
 */
export type EditorsOpenResult =
  | { ok: true }
  | {
      ok: false
      reason: 'unknown-workspace' | 'unknown-editor' | 'command-not-found' | 'spawn-failed'
    }
