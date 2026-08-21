import { describe, expect, it } from 'vitest'
import { projectRoutineProfile, renderRoutineProfileToml, ROUTINE_GATE } from './routine-profile'
import { confirmRoutineGate, parseRoutineProfileToml } from './confirm-routine-gate'

/**
 * The routine-only gate profile (#469, ADR-0028 part 4): what we write, and the
 * read-back that is the only proof it is really a gate.
 *
 * The projection tests are about the FILE — a profile Vibe would drop, or load and
 * silently not honour, is the failure this slice exists to make impossible, and
 * neither has a wire signal.
 */

const BOT = 'mistro-bot-11111111-2222-3333-4444-555555555555'
const GATE = 'mistro-routine-11111111-2222-3333-4444-555555555555'

const SOURCE = { botProfileId: BOT, botName: 'Triager' }

describe('projectRoutineProfile', () => {
  it('derives the routine profile id from the Bot, and names the file after it', () => {
    const file = projectRoutineProfile(SOURCE)
    expect(file).toMatchObject({ profileId: GATE, agentFileName: `${GATE}.toml`, botProfileId: BOT })
  })

  it('refuses a profile id that is not a Bot of ours', () => {
    expect(projectRoutineProfile({ botProfileId: 'ask', botName: 'x' })).toBeNull()
    expect(projectRoutineProfile({ botProfileId: GATE, botName: 'x' })).toBeNull()
    expect(projectRoutineProfile({ botProfileId: 'mistro-bot-nope', botName: 'x' })).toBeNull()
  })

  it("points at the BOT's system prompt, so a routine turn is the same teammate", () => {
    const keys = parseRoutineProfileToml(renderRoutineProfileToml(SOURCE))
    expect(keys?.get('system_prompt_id')).toBe(`"${BOT}"`)
  })

  it('writes every gate entry, and nothing else', () => {
    const keys = parseRoutineProfileToml(renderRoutineProfileToml(SOURCE))
    expect(keys?.get('tools.write_file.permission')).toBe('"never"')
    expect(keys?.get('tools.edit.permission')).toBe('"never"')
    expect(keys?.get('tools.bash.permission')).toBe('"ask"')
    // The empty allowlist is the load-bearing half: it is what removes the schema
    // defaults that let `echo … > file` through a command allowlist (#458).
    expect(keys?.get('tools.bash.allowlist')).toBe('[]')
    expect([...(keys?.keys() ?? [])].sort()).toEqual(
      [
        'display_name',
        'description',
        'agent_type',
        'safety',
        'system_prompt_id',
        ...ROUTINE_GATE.map((entry) => `${entry.table}.${entry.key}`),
      ].sort(),
    )
  })

  it('stays agent_type = "agent" — a subagent profile is never offered as a mode', () => {
    const keys = parseRoutineProfileToml(renderRoutineProfileToml(SOURCE))
    expect(keys?.get('agent_type')).toBe('"agent"')
  })

  it('escapes a Bot name that would otherwise break the TOML', () => {
    const toml = renderRoutineProfileToml({ botProfileId: BOT, botName: 'He said "hi"' })
    expect(parseRoutineProfileToml(toml)?.get('display_name')).toBe('"He said \\"hi\\" (routine)"')
  })

  it('round-trips: what we render is what confirms', () => {
    const file = projectRoutineProfile(SOURCE)
    expect(
      confirmRoutineGate(file?.agentToml ?? '', { profileId: GATE, botProfileId: BOT }),
    ).toEqual({ ok: true })
  })
})
