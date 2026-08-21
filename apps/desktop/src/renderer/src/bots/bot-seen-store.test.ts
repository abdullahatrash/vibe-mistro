import { describe, it, expect } from 'vitest'
import { BOTS_SEEN_STORAGE_KEY, getBotsSeen, markBotSeen, type BotSeenStorage } from './bot-seen-store'

function fakeStorage(initial?: string): BotSeenStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem() {
      return this.value
    },
    setItem(_key: string, value: string) {
      this.value = value
    },
  }
}

describe('getBotsSeen', () => {
  it('reads back what was written', () => {
    const storage = fakeStorage(JSON.stringify({ 't-rex': 42 }))
    expect(getBotsSeen(storage)).toEqual({ 't-rex': 42 })
  })

  it('is empty when nothing is stored', () => {
    expect(getBotsSeen(fakeStorage())).toEqual({})
  })

  it('is empty for corrupt JSON rather than throwing into the sidebar render', () => {
    expect(getBotsSeen(fakeStorage('{not json'))).toEqual({})
  })

  it('is empty for a non-object payload', () => {
    expect(getBotsSeen(fakeStorage('["t-rex"]'))).toEqual({})
  })

  it('drops non-numeric entries instead of trusting them', () => {
    const storage = fakeStorage(JSON.stringify({ 't-rex': 'yesterday', 't-ada': 7, 't-nan': NaN }))
    expect(getBotsSeen(storage)).toEqual({ 't-ada': 7 })
  })

  it('tolerates an absent storage (never throws)', () => {
    expect(getBotsSeen(null)).toEqual({})
    expect(getBotsSeen(undefined)).toEqual({})
  })

  it('tolerates a throwing storage', () => {
    const throwing: BotSeenStorage = {
      getItem() {
        throw new Error('blocked')
      },
      setItem() {},
    }
    expect(getBotsSeen(throwing)).toEqual({})
  })
})

describe('markBotSeen', () => {
  it('records the time and persists it under the one key', () => {
    const storage = fakeStorage()
    expect(markBotSeen(storage, 't-rex', 100)).toEqual({ 't-rex': 100 })
    expect(JSON.parse(storage.value ?? '{}')).toEqual({ 't-rex': 100 })
  })

  it('keeps other Bots entries', () => {
    const storage = fakeStorage(JSON.stringify({ 't-ada': 5 }))
    expect(markBotSeen(storage, 't-rex', 100)).toEqual({ 't-ada': 5, 't-rex': 100 })
  })

  it('never moves a recorded time BACKWARDS, so a stale write cannot resurrect a dot', () => {
    const storage = fakeStorage(JSON.stringify({ 't-rex': 100 }))
    expect(markBotSeen(storage, 't-rex', 50)).toEqual({ 't-rex': 100 })
  })

  it('still returns the updated map when storage is unavailable (the dot clears for this run)', () => {
    expect(markBotSeen(null, 't-rex', 100)).toEqual({ 't-rex': 100 })
  })

  it('swallows a quota failure from the write', () => {
    const full: BotSeenStorage = {
      getItem: () => null,
      setItem() {
        throw new Error('QuotaExceeded')
      },
    }
    expect(() => markBotSeen(full, 't-rex', 100)).not.toThrow()
  })

  it('uses a versioned key', () => {
    expect(BOTS_SEEN_STORAGE_KEY).toMatch(/:v1$/)
  })
})
