import { describe, it, expect } from 'vitest'
import { assessBotProfile } from './assess-bot-profile'

const PROFILE = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const WRITTEN = 1_000

describe('assessBotProfile', () => {
  it('is HEALTHY when a later scan lists the profile', () => {
    expect(
      assessBotProfile({
        profileId: PROFILE,
        profileWrittenAt: WRITTEN,
        discovery: { modeIds: ['ask', 'plan', PROFILE], observedAt: WRITTEN + 1 },
      }),
    ).toEqual({ kind: 'healthy' })
  })

  it('is MISSING when a later scan lists only builtins — the profile file is gone', () => {
    const status = assessBotProfile({
      profileId: PROFILE,
      profileWrittenAt: WRITTEN,
      discovery: { modeIds: ['ask', 'plan', 'accept-edits'], observedAt: WRITTEN + 1 },
    })
    expect(status.kind).toBe('missing')
    // The banner names the profile, so the reason must travel with the id.
    expect(status).toMatchObject({ profileId: PROFILE })
  })

  it('does not distinguish a malformed profile from a deleted one — both are absent', () => {
    // Vibe drops an unreadable TOML at scan with only a log line (#424), so the
    // ONLY evidence either way is that the id is not in the list.
    const status = assessBotProfile({
      profileId: PROFILE,
      profileWrittenAt: WRITTEN,
      discovery: { modeIds: ['ask'], observedAt: WRITTEN + 5_000 },
    })
    expect(status.kind).toBe('missing')
  })

  it('is UNKNOWN when the agent has never reported modes', () => {
    expect(
      assessBotProfile({ profileId: PROFILE, profileWrittenAt: WRITTEN, discovery: null }),
    ).toEqual({ kind: 'unknown' })
  })

  it('is UNKNOWN when the only scan PREDATES the profile write', () => {
    // Creating (or rebuilding) a Bot on an already-warm agent: the registry was
    // scanned before the file existed, so its absence proves nothing.
    expect(
      assessBotProfile({
        profileId: PROFILE,
        profileWrittenAt: WRITTEN,
        discovery: { modeIds: ['ask', 'plan'], observedAt: WRITTEN - 1 },
      }),
    ).toEqual({ kind: 'unknown' })
  })

  it('is UNKNOWN on a same-millisecond tie — an unorderable pair accuses nobody', () => {
    expect(
      assessBotProfile({
        profileId: PROFILE,
        profileWrittenAt: WRITTEN,
        discovery: { modeIds: ['ask'], observedAt: WRITTEN },
      }),
    ).toEqual({ kind: 'unknown' })
  })

  it('checks freshness FIRST, so even a stale affirmative reading is UNKNOWN', () => {
    // Pinned deliberately: the answer only ever drives a banner, and `unknown`
    // and `healthy` both mean "say nothing" — so the rule stays one comparison
    // rather than growing a second, cleverer path for the affirmative case.
    expect(
      assessBotProfile({
        profileId: PROFILE,
        profileWrittenAt: WRITTEN,
        discovery: { modeIds: [PROFILE], observedAt: WRITTEN - 1 },
      }),
    ).toEqual({ kind: 'unknown' })
  })
})
