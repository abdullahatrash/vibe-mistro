import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  MISTRO_BOT_PROFILE_PREFIX,
  isMistroBotProfileId,
  isMistroProfileId,
  isMistroRoutineProfileId,
  mintBotProfileId,
  routineProfileIdFor,
} from './bot-profile-id'

describe('mintBotProfileId', () => {
  it('prefixes a uuid and produces an id we recognise as ours', () => {
    const id = mintBotProfileId(randomUUID())
    expect(id.startsWith(MISTRO_BOT_PROFILE_PREFIX)).toBe(true)
    expect(isMistroBotProfileId(id)).toBe(true)
  })

  it('lowercases so a capitalised uuid still round-trips through the ownership test', () => {
    const id = mintBotProfileId('AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')
    expect(id).toBe('mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(isMistroBotProfileId(id)).toBe(true)
  })

  it('mints a distinct id every time, so no Bot inherits another Bot profile', () => {
    const a = mintBotProfileId(randomUUID())
    const b = mintBotProfileId(randomUUID())
    expect(a).not.toBe(b)
  })
})

describe('isMistroBotProfileId — the foreign-profile gate', () => {
  it('rejects every Vibe builtin, so a Bot profile can never shadow one', () => {
    for (const builtin of ['ask', 'plan', 'accept-edits', 'auto-approve', 'explore', 'lean']) {
      expect(isMistroBotProfileId(builtin)).toBe(false)
    }
  })

  it('rejects a hand-written profile id', () => {
    for (const foreign of ['my-bot', 'reviewer', 'zz-probe-bot', '', 'mistro-bot']) {
      expect(isMistroBotProfileId(foreign)).toBe(false)
    }
  })

  it('rejects a near-miss rather than claiming it (failure direction: leave it alone)', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(isMistroBotProfileId(`mistro-bot-${uuid.toUpperCase()}`)).toBe(false)
    expect(isMistroBotProfileId(`mistro-bot-${uuid.slice(0, 20)}`)).toBe(false)
    expect(isMistroBotProfileId(`mistro-bot-${uuid}-extra`)).toBe(false)
    expect(isMistroBotProfileId(` mistro-bot-${uuid}`)).toBe(false)
    expect(isMistroBotProfileId(`x-mistro-bot-${uuid}`)).toBe(false)
  })

  it('rejects a path-shaped id, so an id can never escape the profile directory', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(isMistroBotProfileId(`../mistro-bot-${uuid}`)).toBe(false)
    expect(isMistroBotProfileId(`mistro-bot-${uuid}/../../evil`)).toBe(false)
    expect(isMistroBotProfileId(`mistro-bot-${uuid}.toml`)).toBe(false)
  })
})

describe('the routine gate profile id (#469)', () => {
  const BOT = 'mistro-bot-6f9619ff-8b86-d011-b42d-00c04fc964ff'
  const GATE = 'mistro-routine-6f9619ff-8b86-d011-b42d-00c04fc964ff'

  it('is derived from the Bot, sharing its uuid — never stored, never minted twice', () => {
    expect(routineProfileIdFor(BOT)).toBe(GATE)
  })

  it('is null for anything that is not a Bot profile of ours', () => {
    // Including a routine id: the pair is derived one way only, so there is no
    // path by which a gate could father a second gate.
    for (const id of ['ask', GATE, 'mistro-bot-nope', 'MISTRO-BOT-6f9619ff-8b86-d011-b42d-00c04fc964ff']) {
      expect({ id, derived: routineProfileIdFor(id) }).toEqual({ id, derived: null })
    }
  })

  it('keeps the two ownership tests apart, so neither writer can touch the other’s file', () => {
    expect(isMistroBotProfileId(GATE)).toBe(false)
    expect(isMistroRoutineProfileId(BOT)).toBe(false)
    expect(isMistroRoutineProfileId(GATE)).toBe(true)
  })

  it('answers the PRESENTATION question for both — a Mode picker must hide each', () => {
    expect(isMistroProfileId(BOT)).toBe(true)
    expect(isMistroProfileId(GATE)).toBe(true)
    expect(isMistroProfileId('ask')).toBe(false)
    expect(isMistroProfileId('my-own-profile')).toBe(false)
  })
})
