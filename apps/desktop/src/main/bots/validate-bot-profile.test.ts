import { describe, it, expect } from 'vitest'
import { projectBotProfile, type BotProfileFiles, type BotProfileSource } from './bot-profile'
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  collectProblems,
  describeProblems,
  validateBotProfile,
  validateBotProfileFiles,
  validateBotProfileSource,
} from './validate-bot-profile'

const PROFILE_ID = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function source(overrides: Partial<BotProfileSource> = {}): BotProfileSource {
  return {
    profileId: PROFILE_ID,
    name: 'Rex',
    description: 'Reviews my diffs',
    instructions: 'Read the diff first.',
    ...overrides,
  }
}

/** The fields at fault, for terse assertions. */
function fields(result: ReturnType<typeof validateBotProfileSource>): string[] {
  return collectProblems(result).map((p) => p.field)
}

describe('validateBotProfileSource', () => {
  it('accepts a well-formed record', () => {
    expect(validateBotProfileSource(source())).toEqual({ ok: true })
  })

  it('rejects a profile id that is not ours — we never write over a hand-written profile', () => {
    expect(fields(validateBotProfileSource(source({ profileId: 'my-reviewer' })))).toContain('profileId')
    expect(fields(validateBotProfileSource(source({ profileId: 'ask' })))).toContain('profileId')
  })

  it('rejects a nameless Bot (display_name would be the raw uuid stem)', () => {
    expect(fields(validateBotProfileSource(source({ name: '   ' })))).toContain('name')
  })

  it('rejects a name or description that is too long for the row it renders into', () => {
    expect(fields(validateBotProfileSource(source({ name: 'x'.repeat(BOT_NAME_MAX_LENGTH + 1) })))).toContain('name')
    expect(
      fields(
        validateBotProfileSource(source({ description: 'x'.repeat(BOT_DESCRIPTION_MAX_LENGTH + 1) })),
      ),
    ).toContain('description')
  })

  it('rejects line breaks in a name or description — the mode description is one line', () => {
    expect(fields(validateBotProfileSource(source({ name: 'Rex\nBoss' })))).toContain('name')
    expect(fields(validateBotProfileSource(source({ description: 'a\nb' })))).toContain('description')
    expect(fields(validateBotProfileSource(source({ description: 'a\u0007b' })))).toContain('description')
  })

  it('rejects instructions past the cap', () => {
    const instructions = 'x'.repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 1)
    expect(fields(validateBotProfileSource(source({ instructions })))).toContain('instructions')
  })

  it('ALLOWS empty instructions — the .md is still written, so the profile loads', () => {
    expect(validateBotProfileSource(source({ instructions: '' }))).toEqual({ ok: true })
  })

  it('reports every problem at once so a form can show them together', () => {
    const result = validateBotProfileSource(source({ profileId: 'nope', name: '' }))
    expect(fields(result).sort()).toEqual(['name', 'profileId'])
  })
})

describe('validateBotProfileFiles — the layer that catches a typo in OUR projection', () => {
  it('accepts what projectBotProfile actually renders', () => {
    expect(validateBotProfileFiles(projectBotProfile(source()))).toEqual({ ok: true })
  })

  it('rejects an unknown or misspelled key — Vibe would silently ignore it', () => {
    for (const line of ['systemPromptId = "x"', 'system_prompt = "x"', 'colour = "#fff"']) {
      const files = withToml(projectBotProfile(source()), (toml) => `${toml}${line}\n`)
      const problems = collectProblems(validateBotProfileFiles(files))
      expect(problems.map((p) => p.field)).toContain(line.split(' ')[0])
    }
  })

  it('rejects agent_type = "subagent" — it would vanish from availableModes with no signal', () => {
    const files = withToml(projectBotProfile(source()), (toml) =>
      toml.replace('agent_type = "agent"', 'agent_type = "subagent"'),
    )
    expect(collectProblems(validateBotProfileFiles(files)).map((p) => p.field)).toContain('agent_type')
  })

  it('rejects a safety value Vibe does not define', () => {
    const files = withToml(projectBotProfile(source()), (toml) =>
      toml.replace('safety = "neutral"', 'safety = "gentle"'),
    )
    expect(collectProblems(validateBotProfileFiles(files)).map((p) => p.field)).toContain('safety')
  })

  it('rejects a MISSING system_prompt_id — the Bot would have no persona', () => {
    const files = withToml(projectBotProfile(source()), (toml) =>
      toml
        .split('\n')
        .filter((line) => !line.startsWith('system_prompt_id'))
        .join('\n'),
    )
    expect(collectProblems(validateBotProfileFiles(files)).map((p) => p.field)).toContain(
      'system_prompt_id',
    )
  })

  it('rejects a system_prompt_id that does not name the .md written beside it', () => {
    const files = withToml(projectBotProfile(source()), (toml) =>
      toml.replace(`system_prompt_id = "${PROFILE_ID}"`, 'system_prompt_id = "cli"'),
    )
    const problems = collectProblems(validateBotProfileFiles(files))
    expect(problems.map((p) => p.field)).toContain('system_prompt_id')
    expect(describeProblems(problems).join(' ')).toContain(`${PROFILE_ID}.md`)
  })

  it('rejects a system_prompt_id carrying the extension or a path (Vibe adds the .md)', () => {
    for (const bad of [`${PROFILE_ID}.md`, `prompts/${PROFILE_ID}`]) {
      const files = withToml(projectBotProfile(source()), (toml) =>
        toml.replace(`system_prompt_id = "${PROFILE_ID}"`, `system_prompt_id = "${bad}"`),
      )
      expect(collectProblems(validateBotProfileFiles(files)).map((p) => p.field)).toContain(
        'system_prompt_id',
      )
    }
  })

  it('rejects a foreign profile id or a file name that drifted from it', () => {
    const foreign: BotProfileFiles = { ...projectBotProfile(source()), profileId: 'reviewer' }
    expect(collectProblems(validateBotProfileFiles(foreign)).map((p) => p.field)).toContain('profileId')

    const drifted: BotProfileFiles = { ...projectBotProfile(source()), agentFileName: 'ask.toml' }
    expect(collectProblems(validateBotProfileFiles(drifted)).map((p) => p.field)).toContain(
      'agentFileName',
    )
  })
})

describe('validateBotProfile', () => {
  it('merges both layers', () => {
    const bad = source({ profileId: 'reviewer' })
    const problems = collectProblems(validateBotProfile(bad, projectBotProfile(bad)))
    // Once from the record layer, once from the rendered-files layer.
    expect(problems.filter((p) => p.field === 'profileId')).toHaveLength(2)
  })

  it('passes the happy path', () => {
    expect(validateBotProfile(source(), projectBotProfile(source()))).toEqual({ ok: true })
  })
})

describe('describeProblems', () => {
  it('renders field-prefixed lines for the IPC reply', () => {
    const problems = collectProblems(validateBotProfileSource(source({ name: '' })))
    expect(describeProblems(problems)[0]).toMatch(/^name: /)
  })
})

/** Re-render one profile's TOML through a mutation, keeping the rest intact. */
function withToml(files: BotProfileFiles, mutate: (toml: string) => string): BotProfileFiles {
  return { ...files, agentToml: mutate(files.agentToml) }
}
