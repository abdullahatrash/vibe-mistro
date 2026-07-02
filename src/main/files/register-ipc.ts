import { ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import {
  IPC,
  type FilesListArgs,
  type FilesListResult,
  type FilesReadArgs,
  type FilesReadResult,
  type RevealPathArgs,
} from '../../shared/ipc'
import type { AgentPool } from '../agent-pool'
import { listFiles } from './list-files'
import { readWorkspaceFile } from './read-file'
import { confineExistingFile } from './confine'
import type { FilesListCache } from './cache'

/**
 * The Workspace-file IPC handlers (#116 reveal, #188 list, #189 read — ADR-0013),
 * registered next to the modules they pass through to. The root of every operation is
 * the warm agent's OWN workspaceDir — resolved via `pool.get`, NOT a renderer-supplied
 * path (review F3) — so the renderer can only touch a CONNECTED Workspace's tree.
 * NONE are agent activity: no `pool.touch`, so a file read never keeps a warm agent
 * alive past its idle window (TB5 #50). Everything is best-effort — an unknown agent
 * or fs failure degrades to an empty/error result or a logged no-op, never a throw.
 */
export function registerFilesIpc(deps: { pool: AgentPool; cache: FilesListCache }): void {
  ipcMain.handle(IPC.revealPath, async (_event, args: RevealPathArgs): Promise<void> => {
    // REVEAL a file behind a clickable file-path chip (#116). The href is AGENT-AUTHORED
    // (untrusted), so a click must never OPEN/execute it — `shell.showItemInFolder` only
    // highlights the file in the OS file manager (no Launch Services, no code execution,
    // no matter the file type). Confinement is the SHARED `confineExistingFile`
    // (files/confine.ts) — the same machinery `files:read` uses: resolve against the
    // agent's Workspace cwd, require a regular FILE (blocks dirs / missing paths),
    // symlink-resolve, and refuse a target outside the realpath'd Workspace
    // (`/etc/passwd`, `~/.ssh/*`) so a click can't disclose an out-of-tree file's
    // location. No file-TYPE gate is needed: reveal never runs anything.
    const agent = deps.pool.get(args.agentId)
    if (!agent) return
    try {
      const confined = await confineExistingFile(agent.workspaceDir, args.path, homedir())
      if (!confined.ok) {
        if (confined.reason === 'outside-workspace') {
          console.error(`[vibe-mistro:reveal-path] refused (outside Workspace): ${confined.realTarget}`)
        }
        return // a dir or out-of-tree target — refuse
      }
      shell.showItemInFolder(confined.realTarget) // reveal only — never opens/executes
    } catch (err) {
      // Missing path / stat / realpath failure — swallow (best-effort, never throws).
      console.error(`[vibe-mistro:reveal-path] ${args.path}: ${String(err)}`)
    }
  })

  ipcMain.handle(IPC.filesList, async (_event, args: FilesListArgs): Promise<FilesListResult> => {
    // LIST the active Workspace's files for the Files Surface tree (#188, ADR-0013). The
    // walk's confinement (never follows a symlink) is inside `listFiles`. Cache-served
    // (keyed by the resolved dir) unless `refresh` forces a rebuild; the git status-stream
    // watcher invalidates that cache (the `emit` hook in index.ts), so an agent-created
    // file appears on the next read with NO new fs watcher.
    const agent = deps.pool.get(args.agentId)
    if (!agent) return { entries: [], truncated: false }
    const workspaceDir = agent.workspaceDir
    if (!args.refresh) {
      const cached = deps.cache.get(workspaceDir)
      if (cached) return cached
    }
    const result = await listFiles(workspaceDir)
    deps.cache.set(workspaceDir, result)
    return result
  })

  ipcMain.handle(IPC.filesRead, async (_event, args: FilesReadArgs): Promise<FilesReadResult> => {
    // READ one Workspace file for the read-only preview (#189, ADR-0013). `readWorkspaceFile`
    // runs the SAME shared confinement as `revealPath` above, caps at ~1MB (bounded read,
    // closing the stat→read TOCTOU), sniffs a NUL byte for binary, and is STRICTLY read-only.
    const agent = deps.pool.get(args.agentId)
    if (!agent) return { kind: 'error' }
    return readWorkspaceFile(agent.workspaceDir, args.relativePath)
  })
}
