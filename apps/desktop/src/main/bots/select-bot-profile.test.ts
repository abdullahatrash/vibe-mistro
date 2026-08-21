import { describe, it, expect, vi } from 'vitest'
import type { ThreadAgentControls } from '../../shared/ipc'
import {
  applyBotProfile,
  mayClaimPreopenedSession,
  planBotProfileSelection,
} from './select-bot-profile'

const PROFILE = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function controls(currentModeId: string, ids: string[]): ThreadAgentControls {
  return {
    modes: {
      currentModeId,
      availableModes: ids.map((id) => ({ id, name: id })),
    },
    models: null,
    reasoningEffort: null,
  }
}

describe('mayClaimPreopenedSession', () => {
  it('lets an ordinary Thread take the eager primary session, always', () => {
    expect(mayClaimPreopenedSession(null, controls('ask', ['ask']))).toBe(true)
    expect(mayClaimPreopenedSession(null, null)).toBe(true)
  })

  it('lets a Bot take it when that session advertises the persona', () => {
    expect(mayClaimPreopenedSession(PROFILE, controls('ask', ['ask', PROFILE]))).toBe(true)
  })

  it('makes a Bot MINT instead when the primary session predates its profile', () => {
    // The silent-failure sequence this exists to break: connect a Project, create
    // a Bot, prompt it. The primary session was scanned before the profile file
    // existed, so binding to it would leave the Bot unable to wear its persona for
    // the whole run — every later turn reuses that session and skips re-selection.
    expect(mayClaimPreopenedSession(PROFILE, controls('ask', ['ask', 'plan']))).toBe(false)
  })

  it('makes a Bot mint when there is no primary session to judge', () => {
    expect(mayClaimPreopenedSession(PROFILE, null)).toBe(false)
    expect(
      mayClaimPreopenedSession(PROFILE, { modes: null, models: null, reasoningEffort: null }),
    ).toBe(false)
  })
})

describe('planBotProfileSelection', () => {
  it('does nothing for an ordinary Thread', () => {
    expect(planBotProfileSelection(null, controls('ask', ['ask']))).toEqual({ kind: 'satisfied' })
  })

  it('does nothing on a plain session REUSE — the earlier bind already selected it', () => {
    expect(planBotProfileSelection(PROFILE, null)).toEqual({ kind: 'satisfied' })
  })

  it('selects the profile on a fresh session that offers it', () => {
    const plan = planBotProfileSelection(PROFILE, controls('ask', ['ask', PROFILE]))
    expect(plan).toEqual({ kind: 'select', profileId: PROFILE })
  })

  it('re-selects after a resume, where Mode falls back to a builtin', () => {
    // Mode does not survive session/load — the reason this runs on every bind.
    const plan = planBotProfileSelection(PROFILE, controls('plan', ['ask', 'plan', PROFILE]))
    expect(plan).toEqual({ kind: 'select', profileId: PROFILE })
  })

  it('is satisfied when the session already reports the profile as current', () => {
    expect(planBotProfileSelection(PROFILE, controls(PROFILE, [PROFILE]))).toEqual({
      kind: 'satisfied',
    })
  })

  it('reports MISSING when Vibe no longer lists the profile (the file is gone)', () => {
    const plan = planBotProfileSelection(PROFILE, controls('ask', ['ask', 'plan']))
    expect(plan.kind).toBe('missing')
  })

  it('reports MISSING when the session advertises no modes at all', () => {
    const plan = planBotProfileSelection(PROFILE, { modes: null, models: null, reasoningEffort: null })
    expect(plan.kind).toBe('missing')
  })
})

describe('applyBotProfile', () => {
  it('sends the profile through the validating mode setter', async () => {
    const setMode = vi.fn().mockResolvedValue(undefined)
    const outcome = await applyBotProfile({ setMode }, 'sess-1', {
      kind: 'select',
      profileId: PROFILE,
    })
    expect(setMode).toHaveBeenCalledWith('sess-1', PROFILE)
    expect(outcome).toEqual({ ok: true, selected: PROFILE })
  })

  it('calls nothing when the plan is satisfied', async () => {
    const setMode = vi.fn()
    expect(await applyBotProfile({ setMode }, 'sess-1', { kind: 'satisfied' })).toEqual({
      ok: true,
      selected: null,
    })
    expect(setMode).not.toHaveBeenCalled()
  })

  it('SURFACES a rejection instead of letting the Bot answer as a plain agent', async () => {
    const setMode = vi.fn().mockRejectedValue(new Error('Unsupported config option mode=…'))
    const outcome = await applyBotProfile({ setMode }, 'sess-1', {
      kind: 'select',
      profileId: PROFILE,
    })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.message).toContain(PROFILE)
    expect(outcome.message).toContain('Unsupported config option')
  })

  it('never throws — a persona failure must not fail the turn', async () => {
    const setMode = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(
      applyBotProfile({ setMode }, 'sess-1', { kind: 'select', profileId: PROFILE }),
    ).resolves.toMatchObject({ ok: false })
  })

  it('reports a missing profile without calling the agent', async () => {
    const setMode = vi.fn()
    const outcome = await applyBotProfile({ setMode }, 'sess-1', {
      kind: 'missing',
      profileId: PROFILE,
      reason: 'its profile file is missing',
    })
    expect(setMode).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ ok: false })
  })
})
