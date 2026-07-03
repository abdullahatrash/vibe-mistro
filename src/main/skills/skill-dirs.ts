import { join } from 'node:path'

/**
 * The skill search directories, in Vibe's exact precedence order (#259; verified
 * against mistral-vibe `SkillManager._compute_search_paths` + `find_local_config_dirs`):
 * project `.vibe/skills` → project `.agents/skills` → `$VIBE_HOME/skills`
 * (default `~/.vibe/skills`) → `~/.agents/skills`. First occurrence of a skill
 * NAME wins across this order, so project skills shadow global ones.
 *
 * Out of scope for v1 (issue #259): `config.toml` `skill_paths` extras and the
 * enabled/disabled filters; Vibe's trusted-folder gate on project dirs (we are a
 * read-only browser of what's on disk, not an executor).
 */

export interface SkillDir {
  dir: string
  scope: 'project' | 'global'
}

/** Names Vibe reserves — an on-disk skill with one of these is never loaded.
 * (`vibe` = the code-only built-in skill; the rest are ACP built-in commands.) */
export const RESERVED_SKILL_NAMES: ReadonlySet<string> = new Set([
  'vibe',
  'help',
  'compact',
  'reload',
  'log',
  'mcp',
  'teleport',
  'proxy-setup',
  'leanstall',
  'unleanstall',
  'data-retention',
])

/** Assemble the search dirs for a Workspace. Pure — env + home are injected. */
export function skillSearchDirs(
  workspaceDir: string | null,
  env: NodeJS.ProcessEnv,
  home: string,
): SkillDir[] {
  const vibeHome = env.VIBE_HOME || join(home, '.vibe')
  const dirs: SkillDir[] = []
  if (workspaceDir) {
    dirs.push({ dir: join(workspaceDir, '.vibe', 'skills'), scope: 'project' })
    dirs.push({ dir: join(workspaceDir, '.agents', 'skills'), scope: 'project' })
  }
  dirs.push({ dir: join(vibeHome, 'skills'), scope: 'global' })
  dirs.push({ dir: join(home, '.agents', 'skills'), scope: 'global' })
  return dirs
}
