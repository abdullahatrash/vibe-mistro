import { spawn } from 'node:child_process'
import {
  fileManagerCommandForPlatform,
  findEditor,
  resolveEditorArgs,
} from '../../shared/editors'
import type { EditorsOpenResult } from '../../shared/ipc'
import { resolveAvailableCommand } from './detect'

/**
 * Launch a Workspace directory in a curated external editor (#252) — the t3code
 * model: resolve the editor's first available CLI alias on the shell-env PATH,
 * then spawn it DETACHED (stdio ignored, unref'd) so the editor outlives us and
 * never blocks or chatters at the main process. The file-manager entry opens the
 * directory via the platform opener (`open` / `explorer` / `xdg-open`) instead.
 * Every failure is a typed result (the handler logs it) — never a throw, never
 * a silent no-op.
 */
export async function launchEditor(opts: {
  workspaceDir: string
  editorId: string
  env: NodeJS.ProcessEnv
  platform: string
}): Promise<EditorsOpenResult> {
  const editor = findEditor(opts.editorId)
  if (!editor) return { ok: false, reason: 'unknown-editor' }

  const aliases = editor.commands ?? [fileManagerCommandForPlatform(opts.platform)]
  const command = await resolveAvailableCommand(aliases, opts.env, opts.platform)
  if (command === null) return { ok: false, reason: 'command-not-found' }

  // The file manager takes the bare dir; a real editor goes through the
  // launchStyle mapping (a no-op for a bare directory in slice 1, load-bearing
  // once #254 passes file:line targets through this same path).
  const args = editor.commands === null ? [opts.workspaceDir] : resolveEditorArgs(editor, opts.workspaceDir)
  return spawnDetached(command, args, opts.env)
}

function spawnDetached(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<EditorsOpenResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env })
      child.once('error', () => resolve({ ok: false, reason: 'spawn-failed' }))
      child.once('spawn', () => {
        child.unref()
        resolve({ ok: true })
      })
    } catch {
      resolve({ ok: false, reason: 'spawn-failed' })
    }
  })
}
