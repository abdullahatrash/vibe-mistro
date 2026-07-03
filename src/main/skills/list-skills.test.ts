import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isListableSkillPath, listSkills } from './list-skills'
import { skillSearchDirs } from './skill-dirs'

async function writeSkill(root: string, dirName: string, frontmatter: string): Promise<string> {
  const dir = join(root, dirName)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'SKILL.md')
  await writeFile(file, `---\n${frontmatter}\n---\n\nBody.\n`)
  return file
}

describe('skillSearchDirs', () => {
  it('orders project .vibe → project .agents → $VIBE_HOME → ~/.agents, honoring VIBE_HOME', () => {
    const dirs = skillSearchDirs('/ws', { VIBE_HOME: '/custom-vibe' }, '/home/u')
    expect(dirs).toEqual([
      { dir: join('/ws', '.vibe', 'skills'), scope: 'project' },
      { dir: join('/ws', '.agents', 'skills'), scope: 'project' },
      { dir: join('/custom-vibe', 'skills'), scope: 'global' },
      { dir: join('/home/u', '.agents', 'skills'), scope: 'global' },
    ])
    // no Workspace → global only; VIBE_HOME default = ~/.vibe
    expect(skillSearchDirs(null, {}, '/home/u')).toEqual([
      { dir: join('/home/u', '.vibe', 'skills'), scope: 'global' },
      { dir: join('/home/u', '.agents', 'skills'), scope: 'global' },
    ])
  })
})

describe('listSkills', () => {
  it('scans immediate subdirs, derives scope, applies first-name-wins, sorts by name', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-test-'))
    const project = join(root, 'ws', '.vibe', 'skills')
    const globalVibe = join(root, 'home', '.vibe', 'skills')
    await writeSkill(project, 'deploy', 'name: deploy\ndescription: Project deploy')
    await writeSkill(globalVibe, 'deploy', 'name: deploy\ndescription: Global deploy (shadowed)')
    await writeSkill(globalVibe, 'audit', 'name: audit\ndescription: Audit things')

    const skills = await listSkills([
      { dir: project, scope: 'project' },
      { dir: globalVibe, scope: 'global' },
    ])
    expect(skills.map((s) => s.name)).toEqual(['audit', 'deploy']) // sorted
    expect(skills.find((s) => s.name === 'deploy')).toMatchObject({
      scope: 'project',
      description: 'Project deploy', // project shadows global (first wins)
      userInvocable: true,
    })
    expect(skills.find((s) => s.name === 'deploy')?.path).toBe(join(project, 'deploy', 'SKILL.md'))
  })

  it('skips reserved names, non-parsing skills, bare files, and missing dirs — never throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'skills-test-'))
    const dir = join(root, 'skills')
    await writeSkill(dir, 'vibe', 'name: vibe\ndescription: reserved built-in')
    await writeSkill(dir, 'help', 'name: help\ndescription: reserved command')
    await writeSkill(dir, 'broken', 'no-frontmatter-fields: true')
    await mkdir(join(dir, 'empty-dir'))
    await writeFile(join(dir, 'stray-file.md'), 'not a skill dir')
    await writeSkill(dir, 'keeper', 'name: keeper\ndescription: The one that loads\nuser-invocable: false')

    const skills = await listSkills([
      { dir, scope: 'global' },
      { dir: join(root, 'does-not-exist'), scope: 'global' },
    ])
    expect(skills).toEqual([
      {
        name: 'keeper',
        description: 'The one that loads',
        scope: 'global',
        path: join(dir, 'keeper', 'SKILL.md'),
        userInvocable: false,
      },
    ])
  })
})

describe('isListableSkillPath (the reveal gate)', () => {
  const dirs = [{ dir: '/home/u/.vibe/skills', scope: 'global' as const }]

  it('accepts only <search-dir>/<skill>/SKILL.md', () => {
    expect(isListableSkillPath('/home/u/.vibe/skills/deploy/SKILL.md', dirs)).toBe(true)
    expect(isListableSkillPath('/home/u/.vibe/skills/deploy/notes.md', dirs)).toBe(false)
    expect(isListableSkillPath('/home/u/.vibe/skills/deploy/nested/SKILL.md', dirs)).toBe(false)
    expect(isListableSkillPath('/home/u/.ssh/id_rsa', dirs)).toBe(false)
  })

  it('refuses traversal out of the search dirs', () => {
    expect(isListableSkillPath('/home/u/.vibe/skills/../../.ssh/SKILL.md', dirs)).toBe(false)
    expect(isListableSkillPath('/home/u/.vibe/skills-evil/x/SKILL.md', dirs)).toBe(false)
  })
})
