import { ipcMain, shell } from 'electron'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import {
  IPC,
  type SkillsListArgs,
  type SkillsListResult,
  type SkillsReadArgs,
  type SkillsReadResult,
  type SkillsRevealArgs,
} from '../../shared/ipc'
import { getShellEnv } from '../shell-env'
import { isListableSkillPath, listSkills } from './list-skills'
import { skillBody } from './parse-skill'
import { skillSearchDirs } from './skill-dirs'

/** Preview cap — a SKILL.md is prose; anything past this is truncated, not an error. */
const PREVIEW_MAX_CHARS = 512 * 1024

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

  ipcMain.handle(IPC.skillsRead, async (_event, args: SkillsReadArgs): Promise<SkillsReadResult> => {
    // The in-app preview (#259 slice 2): SAME gate as reveal — only a SKILL.md a
    // scan could have listed is readable, so this can't become a generic file-read
    // channel. Returns the body only (frontmatter already rendered on the row).
    const dirs = skillSearchDirs(args.workspaceDir, getShellEnv(), homedir())
    if (!isListableSkillPath(args.path, dirs)) {
      console.error(`[vibe-mistro:skills] read refused (outside skill dirs): ${args.path}`)
      return { ok: false }
    }
    try {
      const content = await readFile(args.path, 'utf8')
      return { ok: true, markdown: skillBody(content).slice(0, PREVIEW_MAX_CHARS) }
    } catch (err) {
      console.error(`[vibe-mistro:skills] read failed (${args.path}): ${String(err)}`)
      return { ok: false }
    }
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
