import { readdir, readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { SkillInfo } from '../../shared/ipc'
import { parseSkillFrontmatter } from './parse-skill'
import { RESERVED_SKILL_NAMES, type SkillDir } from './skill-dirs'

/**
 * Scan the skill search dirs and parse each skill (#259) — mirroring Vibe's
 * `_discover_skills`: IMMEDIATE subdirectories only (no recursion), one
 * `SKILL.md` per skill dir, first NAME wins across the precedence order,
 * reserved names dropped. Everything is best-effort: a missing search dir is
 * the normal fresh-install case, an unreadable/unparseable `SKILL.md` skips
 * that one skill — a scan never throws.
 */
export async function listSkills(dirs: SkillDir[]): Promise<SkillInfo[]> {
  const byName = new Map<string, SkillInfo>()
  for (const { dir, scope } of dirs) {
    let children: Array<{ name: string; isDirectory(): boolean }>
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      continue // absent dir — a fresh install has none of them
    }
    for (const child of children) {
      if (!child.isDirectory()) continue
      const skillFile = join(dir, child.name, 'SKILL.md')
      let content: string
      try {
        content = await readFile(skillFile, 'utf8')
      } catch {
        continue // a dir without SKILL.md isn't a skill
      }
      const parsed = parseSkillFrontmatter(content)
      if (!parsed) continue
      if (RESERVED_SKILL_NAMES.has(parsed.name)) continue
      if (byName.has(parsed.name)) continue // first occurrence wins (Vibe parity)
      byName.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        scope,
        path: skillFile,
        userInvocable: parsed.userInvocable,
      })
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Whether `path` points at a `SKILL.md` directly under one of the search dirs —
 * the reveal gate: the renderer can only reveal what a scan could have listed.
 * Pure string containment on RESOLVED paths (reveal itself never opens/executes).
 */
export function isListableSkillPath(path: string, dirs: SkillDir[]): boolean {
  const resolved = resolve(path)
  return dirs.some(({ dir }) => {
    const root = resolve(dir) + sep
    if (!resolved.startsWith(root)) return false
    const rest = resolved.slice(root.length).split(sep)
    return rest.length === 2 && rest[1] === 'SKILL.md'
  })
}
