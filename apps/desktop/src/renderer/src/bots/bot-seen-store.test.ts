import { describe, it, expect } from 'vitest'
import { BOTS_SEEN_STORAGE_KEY, getBotsSeen, markBotSeen, type BotSeenStorage } from './bot-seen-store'

/** A throwaway in-memory Storage seam, KEYED like the real thing (project-open-store.test.ts). */
function fakeStorage(seed?: Record<string, string>): BotSeenStorage & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed ?? {}))
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('getBotsSeen', () => {
  it('reads back what was written, from the key the module owns', () => {
    const storage = fakeStorage({ [BOTS_SEEN_STORAGE_KEY]: JSON.stringify({ 't-rex': 42 }) })
    expect(getBotsSeen(storage)).toEqual({ 't-rex': 42 })
  })

  it('ignores a value stored under a different key', () => {
    expect(getBotsSeen(fakeStorage({ 'some-other-key': JSON.stringify({ 't-rex': 42 }) }))).toEqual({})
  })

  it('is empty when nothing is stored', () => {
    expect(getBotsSeen(fakeStorage())).toEqual({})
  })

  it('is empty for corrupt JSON rather than throwing into the sidebar render', () => {
    expect(getBotsSeen(fakeStorage({ [BOTS_SEEN_STORAGE_KEY]: '{not json' }))).toEqual({})
  })

  it('is empty for a non-object payload', () => {
    expect(getBotsSeen(fakeStorage({ [BOTS_SEEN_STORAGE_KEY]: '["t-rex"]' }))).toEqual({})
  })

  it('drops non-numeric entries instead of trusting them', () => {
    const raw = JSON.stringify({ 't-rex': 'yesterday', 't-ada': 7, 't-nan': null })
    expect(getBotsSeen(fakeStorage({ [BOTS_SEEN_STORAGE_KEY]: raw }))).toEqual({ 't-ada': 7 })
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
  it('round-trips through the store', () => {
    const storage = fakeStorage()
    markBotSeen(storage, 't-rex', 100)
    expect(getBotsSeen(storage)).toEqual({ 't-rex': 100 })
  })

  it('writes to the key the module reads, so a reload finds it', () => {
    const storage = fakeStorage()
    markBotSeen(storage, 't-rex', 100)
    expect([...storage.map.keys()]).toEqual([BOTS_SEEN_STORAGE_KEY])
  })

  it('keeps other Bots entries', () => {
    const storage = fakeStorage({ [BOTS_SEEN_STORAGE_KEY]: JSON.stringify({ 't-ada': 5 }) })
    expect(markBotSeen(storage, 't-rex', 100)).toEqual({ 't-ada': 5, 't-rex': 100 })
  })

  it('never moves a recorded time BACKWARDS, so a stale write cannot resurrect a dot', () => {
    const storage = fakeStorage({ [BOTS_SEEN_STORAGE_KEY]: JSON.stringify({ 't-rex': 100 }) })
    expect(markBotSeen(storage, 't-rex', 50)).toEqual({ 't-rex': 100 })
    expect(getBotsSeen(storage)).toEqual({ 't-rex': 100 })
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
})
