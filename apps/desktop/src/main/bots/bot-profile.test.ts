import { describe, it, expect } from 'vitest'
import {
  BOT_PROFILE_HEADER,
  projectBotProfile,
  renderBotProfileToml,
  renderBotPromptMarkdown,
  tomlString,
  type BotProfileSource,
} from './bot-profile'

const PROFILE_ID = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function source(overrides: Partial<BotProfileSource> = {}): BotProfileSource {
  return {
    profileId: PROFILE_ID,
    name: 'Rex',
    description: 'Reviews my diffs before I open a PR',
    instructions: 'Read the diff first. Never approve without reading the tests.',
    ...overrides,
  }
}

describe('projectBotProfile — file names', () => {
  it('names both files after the profile id (the ACP mode id IS the file stem)', () => {
    const files = projectBotProfile(source())
    expect(files.agentFileName).toBe(`${PROFILE_ID}.toml`)
    expect(files.promptFileName).toBe(`${PROFILE_ID}.md`)
    expect(files.profileId).toBe(PROFILE_ID)
  })
})

describe('renderBotProfileToml', () => {
  it('renders the exact shape vibe-acp 2.24.1 publishes as a mode', () => {
    expect(renderBotProfileToml(source())).toBe(
      `# ${BOT_PROFILE_HEADER}\n` +
        'display_name = "Rex"\n' +
        'description = "Reviews my diffs before I open a PR"\n' +
        'agent_type = "agent"\n' +
        'safety = "neutral"\n' +
        `system_prompt_id = "${PROFILE_ID}"\n`,
    )
  })

  it('carries the generated-file header on its first line', () => {
    expect(renderBotProfileToml(source()).split('\n')[0]).toBe(`# ${BOT_PROFILE_HEADER}`)
  })

  it('points system_prompt_id at the BARE stem — Vibe appends the .md itself', () => {
    const toml = renderBotProfileToml(source())
    expect(toml).toContain(`system_prompt_id = "${PROFILE_ID}"`)
    expect(toml).not.toContain('.md')
    expect(toml).not.toContain('/')
  })

  it('stays agent_type = "agent" — a subagent is never offered as a mode', () => {
    expect(renderBotProfileToml(source())).toContain('agent_type = "agent"')
  })

  it('trims the name and description so a stray space never reaches the mode list', () => {
    const toml = renderBotProfileToml(source({ name: '  Rex  ', description: ' tidy \t' }))
    expect(toml).toContain('display_name = "Rex"')
    expect(toml).toContain('description = "tidy"')
  })

  it('escapes quotes and backslashes so tomllib cannot reject the file', () => {
    const toml = renderBotProfileToml(source({ name: 'The "Boss"', description: 'C:\\work' }))
    expect(toml).toContain('display_name = "The \\"Boss\\""')
    expect(toml).toContain('description = "C:\\\\work"')
  })

  it('emits an empty description rather than omitting the key', () => {
    expect(renderBotProfileToml(source({ description: '' }))).toContain('description = ""')
  })
})

describe('renderBotPromptMarkdown', () => {
  it('carries the generated-file header as an invisible HTML comment, then the persona', () => {
    expect(renderBotPromptMarkdown(source())).toBe(
      `<!-- ${BOT_PROFILE_HEADER} -->\n\n` +
        '# Rex\n\n' +
        'Reviews my diffs before I open a PR\n\n' +
        'Read the diff first. Never approve without reading the tests.\n',
    )
  })

  it('drops an empty description instead of emitting blank noise', () => {
    expect(renderBotPromptMarkdown(source({ description: '   ' }))).toBe(
      `<!-- ${BOT_PROFILE_HEADER} -->\n\n# Rex\n\nRead the diff first. Never approve without reading the tests.\n`,
    )
  })

  it('still writes a file for a Bot with no instructions, so system_prompt_id resolves', () => {
    const markdown = renderBotPromptMarkdown(source({ instructions: '' }))
    expect(markdown).toContain(BOT_PROFILE_HEADER)
    expect(markdown).toContain('# Rex')
  })

  it('keeps multi-line instructions verbatim — the persona is the whole point', () => {
    const instructions = '## Rules\n\n- one\n- two'
    expect(renderBotPromptMarkdown(source({ instructions }))).toContain(instructions)
  })
})

describe('tomlString', () => {
  it('escapes the pairs TOML requires and leaves ordinary text alone', () => {
    expect(tomlString('plain')).toBe('"plain"')
    expect(tomlString('a"b')).toBe('"a\\"b"')
    expect(tomlString('a\\b')).toBe('"a\\\\b"')
    expect(tomlString('a\nb')).toBe('"a\\nb"')
    expect(tomlString('a\tb')).toBe('"a\\tb"')
    expect(tomlString('a\r')).toBe('"a\\r"')
  })

  it('escapes other control characters as \\uXXXX rather than emitting them raw', () => {
    expect(tomlString('a\u0007b')).toBe('"a\\u0007b"')
    expect(tomlString('a\u007fb')).toBe('"a\\u007fb"')
  })

  it('passes non-ASCII through — the file is UTF-8', () => {
    expect(tomlString('Café — 東京')).toBe('"Café — 東京"')
  })
})
