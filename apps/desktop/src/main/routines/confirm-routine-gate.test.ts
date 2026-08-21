import { describe, expect, it } from 'vitest'
import { confirmRoutineGate, describeGateProblems, gateProblems } from './confirm-routine-gate'
import { renderRoutineProfileToml } from './routine-profile'

/**
 * **Verify the gate took** (#469) — the check that stands between a typo and a
 * routine that runs unattended with no permission gate and looks correctly
 * configured while it does it.
 *
 * Each case below is a file Vibe would happily load. That is the point: Vibe
 * validates nothing inside a profile's `tools` table and ignores what it does not
 * recognise (#424), so every one of these is INVISIBLE on the wire. If this
 * function does not catch them, nothing does.
 */

const BOT = 'mistro-bot-11111111-2222-3333-4444-555555555555'
const GATE = 'mistro-routine-11111111-2222-3333-4444-555555555555'
const EXPECTED = { profileId: GATE, botProfileId: BOT }
const GOOD = renderRoutineProfileToml({ botProfileId: BOT, botName: 'Triager' })

const fields = (toml: string): string[] =>
  gateProblems(confirmRoutineGate(toml, EXPECTED)).map((problem) => problem.field)

describe('confirmRoutineGate', () => {
  it('confirms the file we write', () => {
    expect(confirmRoutineGate(GOOD, EXPECTED)).toEqual({ ok: true })
  })

  it('refuses a MISSPELLED key — the silent-ignore case, in full', () => {
    // `permisson` is a key Vibe has never heard of. It is swept into the profile's
    // overrides, validated by nothing, and dropped. The profile loads, appears as
    // a mode, and gates NOTHING.
    const typo = GOOD.replace('permission = "ask"', 'permisson = "ask"')
    expect(fields(typo)).toContain('tools.bash.permisson')
    expect(fields(typo)).toContain('tools.bash.permission')
  })

  it('refuses a misspelled TABLE, which would gate a tool that does not exist', () => {
    const typo = GOOD.replace('[tools.write_file]', '[tools.writefile]')
    expect(fields(typo)).toContain('tools.writefile.permission')
    expect(fields(typo)).toContain('tools.write_file.permission')
  })

  it('refuses a gate with the wrong VALUE', () => {
    expect(fields(GOOD.replace('permission = "never"', 'permission = "always"'))).toContain(
      'tools.write_file.permission',
    )
    expect(fields(GOOD.replace('permission = "ask"', 'permission = "always"'))).toContain(
      'tools.bash.permission',
    )
  })

  it('refuses a NON-EMPTY bash allowlist — the half that removes the defaults', () => {
    const widened = GOOD.replace('allowlist = []', 'allowlist = ["echo"]')
    expect(fields(widened)).toEqual(['tools.bash.allowlist'])
  })

  it('refuses a gate with an entry missing entirely', () => {
    const partial = GOOD.split('\n')
      .filter((line) => line !== 'allowlist = []')
      .join('\n')
    expect(fields(partial)).toEqual(['tools.bash.allowlist'])
  })

  it('refuses an extra key, however harmless it looks', () => {
    // A gate erodes one well-meaning addition at a time, and an addition Vibe does
    // not read is worse than one it does: it changes nothing and looks like it did.
    // (Appended after the last table header it belongs to that table — which is
    // what TOML says and what makes the key-path check the right shape of check.)
    const extra = fields(`${GOOD}\nbypass_tool_permissions = true\n`)
    expect(extra).toHaveLength(1)
    expect(extra[0]).toMatch(/bypass_tool_permissions$/)
  })

  it('refuses a profile pointing at somebody else’s system prompt', () => {
    const other = GOOD.replace(BOT, 'mistro-bot-99999999-2222-3333-4444-555555555555')
    expect(fields(other)).toContain('system_prompt_id')
  })

  it('refuses agent_type = "subagent" and an unknown safety value', () => {
    expect(fields(GOOD.replace('agent_type = "agent"', 'agent_type = "subagent"'))).toContain(
      'agent_type',
    )
    expect(fields(GOOD.replace('safety = "neutral"', 'safety = "harmless"'))).toContain('safety')
  })

  it('refuses a file that is not the flat TOML we write', () => {
    // A line that is neither a comment, a table header nor `key = value` is a
    // file we did not write, and the refusal is about the FILE rather than about
    // any key in it.
    expect(fields('this is not valid toml [[[')).toEqual(['file'])
    expect(fields('[tools.bash')).toEqual(['file'])
    expect(fields('')).not.toEqual([]) // an empty file has no gate at all
  })

  it('refuses ids that are not ours', () => {
    const problems = gateProblems(
      confirmRoutineGate(GOOD, { profileId: 'ask', botProfileId: 'plan' }),
    )
    expect(problems.map((p) => p.field)).toContain('profileId')
    expect(problems.map((p) => p.field)).toContain('system_prompt_id')
  })

  it('describes problems as "field: message", the shape a failure carries', () => {
    const described = describeGateProblems(
      gateProblems(confirmRoutineGate(GOOD.replace('allowlist = []', 'allowlist = ["ls"]'), EXPECTED)),
    )
    expect(described).toHaveLength(1)
    expect(described[0]).toMatch(/^tools\.bash\.allowlist: /)
  })
})
