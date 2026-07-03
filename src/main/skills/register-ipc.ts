import { ipcMain, shell } from 'electron'
import { homedir } from 'node:os'
import {
  IPC,
  type SkillsListArgs,
  type SkillsListResult,
  type SkillsRevealArgs,
} from '../../shared/ipc'
import { getShellEnv } from '../shell-env'
import { isListableSkillPath, listSkills } from './list-skills'
import { skillSearchDirs } from './skill-dirs'

/**
 * The Skills-browser IPC handlers (#259), registered beside their modules
 * (the git/files registrar pattern). No agent involved — skills are Vibe-owned
 * on-disk config main scans itself, so the browser works with zero warm agents.
 * The shell env supplies `VIBE_HOME` (same resolution the spawned agent sees).
 * NOT agent activity: no pool, no touch — listing skills never keeps anything alive.
 */
export function registerSkillsIpc(): void {
  ipcMain.handle(IPC.skillsList, (_event, args: SkillsListArgs): Promise<SkillsListResult> => {
    return listSkills(skillSearchDirs(args.workspaceDir, getShellEnv(), homedir()))
  })

  ipcMain.handle(IPC.skillsReveal, (_event, args: SkillsRevealArgs): void => {
    // Reveal-only (never open/execute — no Launch Services), and gated: the path
    // must be a SKILL.md directly under a CURRENT search dir, i.e. something a
    // scan could have listed. An out-of-tree path is refused + logged.
    const dirs = skillSearchDirs(args.workspaceDir, getShellEnv(), homedir())
    if (!isListableSkillPath(args.path, dirs)) {
      console.error(`[vibe-mistro:skills] reveal refused (outside skill dirs): ${args.path}`)
      return
    }
    shell.showItemInFolder(args.path)
  })
}
