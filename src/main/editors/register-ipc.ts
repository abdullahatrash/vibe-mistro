import { ipcMain } from 'electron'
import {
  IPC,
  type EditorsListResult,
  type EditorsOpenArgs,
  type EditorsOpenResult,
} from '../../shared/ipc'
import type { AgentPool } from '../agent-pool'
import { getShellEnv } from '../shell-env'
import { detectAvailableEditors } from './detect'
import { launchEditor } from './launch'

/**
 * The Open-in-IDE IPC handlers (#252, epic #178), registered beside the modules
 * they pass through to. Launching a user-chosen local app on the Workspace dir is
 * user-trusted (parity with reveal-in-Finder); commands come ONLY from the curated
 * `EDITORS` table — no user-supplied command strings. The open target is the warm
 * agent's OWN `workspaceDir` (`pool.get`, the `filesList`/`revealPath` model), never
 * a renderer-supplied path. NEITHER handler is agent activity: no `pool.touch`, so
 * listing or opening an editor never keeps a warm agent alive past its idle window.
 */
export function registerEditorsIpc(deps: { pool: AgentPool }): void {
  // Session-lifetime detection cache: the installed-editor set doesn't change
  // mid-run, so the first probe's promise is shared by every later call (also
  // coalescing concurrent invokes). A probe FAILURE is not cached — the slot
  // resets so a transient fs hiccup doesn't blank the menu for the whole session.
  let detected: Promise<EditorsListResult> | null = null

  ipcMain.handle(IPC.editorsList, (): Promise<EditorsListResult> => {
    detected ??= detectAvailableEditors(getShellEnv(), process.platform).then(
      (editors) => ({ editors }),
      (err) => {
        console.error(`[vibe-mistro:editors] detection failed: ${String(err)}`)
        detected = null
        return { editors: [] }
      },
    )
    return detected
  })

  ipcMain.handle(
    IPC.editorsOpen,
    async (_event, args: EditorsOpenArgs): Promise<EditorsOpenResult> => {
      const agent = deps.pool.get(args.agentId)
      if (!agent) {
        console.error(`[vibe-mistro:editors] open ${args.editorId}: unknown agent ${args.agentId}`)
        return { ok: false, reason: 'unknown-agent' }
      }
      const result = await launchEditor({
        workspaceDir: agent.workspaceDir,
        editorId: args.editorId,
        env: getShellEnv(),
        platform: process.platform,
      })
      if (!result.ok) {
        console.error(`[vibe-mistro:editors] open ${args.editorId} failed: ${result.reason}`)
      }
      return result
    },
  )
}
