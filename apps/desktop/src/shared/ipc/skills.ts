/**
 * Skills domain of the shared IPC contract (#259): the Skills browser's channels
 * + payload types. Skills are Vibe-owned ON-DISK config (`SKILL.md` directories);
 * main scans and parses them itself — no agent involved, so the browser works
 * with zero warm agents (process-free, like the cold Thread list). Keep this
 * file free of Node/DOM imports so both sides can consume it.
 */

/** The skills channel entries, merged into the single `IPC` const in `./index`. */
export const skillsChannels = {
  /** Scan + parse the installed skills for a Workspace (project + global dirs). */
  skillsList: 'skills:list',
  /** Reveal a LISTED skill's SKILL.md in the OS file manager (validated in main). */
  skillsReveal: 'skills:reveal',
  /** Read a LISTED skill's SKILL.md body for the in-app preview (same gate as reveal). */
  skillsRead: 'skills:read',
} as const

/** List installed skills. `workspaceDir` = the selected Workspace (null = global only). */
export interface SkillsListArgs {
  workspaceDir: string | null
}

/**
 * One installed skill, as parsed from its `SKILL.md`. `scope` is derived from
 * WHICH directory the skill was found in (Vibe itself doesn't record it):
 * `project` = `<workspace>/.vibe/skills` or `<workspace>/.agents/skills`,
 * `global` = `$VIBE_HOME/skills` or `~/.agents/skills`.
 */
export interface SkillInfo {
  name: string
  description: string
  scope: 'project' | 'global'
  /** Absolute path to the skill's `SKILL.md` (the reveal/open target). */
  path: string
  /** Vibe's `user-invocable` frontmatter (default true) — false = never in the `/` menu. */
  userInvocable: boolean
}

/** The `skills:list` reply: merged first-name-wins, sorted by name. */
export type SkillsListResult = SkillInfo[]

/**
 * Reveal a skill's `SKILL.md`. Main re-derives the search dirs from
 * `workspaceDir` and refuses a `path` outside them — the renderer can only
 * reveal what a scan could have listed, never an arbitrary path.
 */
export interface SkillsRevealArgs {
  workspaceDir: string | null
  path: string
}

/** Read a skill's `SKILL.md` for the preview — same path gate as reveal. */
export interface SkillsReadArgs {
  workspaceDir: string | null
  path: string
}

/**
 * The preview content: the Markdown BODY after the frontmatter (the skill's
 * instructions — name/description already live on the row). `ok: false` covers
 * a refused path or a read failure; the renderer degrades to a hint.
 */
export type SkillsReadResult = { ok: true; markdown: string } | { ok: false }
