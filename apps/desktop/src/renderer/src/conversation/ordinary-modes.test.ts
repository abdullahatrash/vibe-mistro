import { describe, it, expect } from 'vitest'
import type { ThreadModes } from '../../../shared/ipc'
import { modesWithoutBotProfiles } from './ordinary-modes'

const BOT_A = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const BOT_B = 'mistro-bot-11111111-2222-3333-4444-555555555555'

function modes(currentModeId: string, ids: string[]): ThreadModes {
  return { currentModeId, availableModes: ids.map((id) => ({ id, name: id })) }
}

describe('modesWithoutBotProfiles', () => {
  it('drops every Bot persona from the picker', () => {
    const filtered = modesWithoutBotProfiles(modes('ask', ['ask', BOT_A, 'plan', BOT_B]))
    expect(filtered?.availableModes.map((m) => m.id)).toEqual(['ask', 'plan'])
  })

  it('leaves the builtin modes and the current value untouched', () => {
    const builtins = ['ask', 'plan', 'accept-edits', 'auto-approve', 'explore', 'lean']
    const filtered = modesWithoutBotProfiles(modes('plan', [...builtins, BOT_A]))
    expect(filtered?.availableModes.map((m) => m.id)).toEqual(builtins)
    expect(filtered?.currentModeId).toBe('plan')
  })

  it('never touches a hand-written profile of the user’s', () => {
    // The ownership test is the minted `mistro-bot-<uuid>` shape, so a profile a
    // human wrote — including a near-miss — stays in their own picker.
    const foreign = ['reviewer', 'mistro-bot-not-a-uuid', 'MISTRO-BOT-AAAAAAAA']
    const filtered = modesWithoutBotProfiles(modes('ask', ['ask', ...foreign]))
    expect(filtered?.availableModes.map((m) => m.id)).toEqual(['ask', ...foreign])
  })

  it('returns the SAME object when there is nothing to filter', () => {
    const original = modes('ask', ['ask', 'plan'])
    expect(modesWithoutBotProfiles(original)).toBe(original)
  })

  it('reports NO axis when every advertised mode is a Bot — never an empty menu', () => {
    expect(modesWithoutBotProfiles(modes(BOT_A, [BOT_A, BOT_B]))).toBeNull()
  })

  it('passes null through — an agent that advertises no modes still shows no picker', () => {
    expect(modesWithoutBotProfiles(null)).toBeNull()
  })
})
