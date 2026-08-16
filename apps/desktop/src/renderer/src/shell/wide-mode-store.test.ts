import { describe, expect, it, beforeEach } from 'vitest'
import {
  DEFAULT_WIDE_MODE,
  WIDE_MODE_STORAGE_KEY,
  applyWideModeToDocument,
  getWideMode,
  initWideMode,
  readWideMode,
  setWideMode,
  subscribeWideMode,
} from './wide-mode-store'

/** A minimal in-memory fake for the WideModeStorage interface. */
function makeStorage(): { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void } {
  const store = new Map<string, string>()
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value)
    },
  }
}

/** A storage that throws on every access — simulates a blocked/corrupt store. */
function throwingStorage(): { getItem: () => string | null; setItem: () => void } {
  return {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
  }
}

describe('wide-mode-store', () => {
  beforeEach(() => {
    setWideMode(null, DEFAULT_WIDE_MODE)
  })

  describe('readWideMode', () => {
    it('returns the default when storage is null', () => {
      expect(readWideMode(null)).toBe(false)
    })

    it('returns false for an absent key', () => {
      expect(readWideMode(makeStorage())).toBe(false)
    })

    it('returns true when the stored value is "true"', () => {
      const storage = makeStorage()
      storage.setItem(WIDE_MODE_STORAGE_KEY, 'true')
      expect(readWideMode(storage)).toBe(true)
    })

    it('returns false for an unexpected stored value', () => {
      const storage = makeStorage()
      storage.setItem(WIDE_MODE_STORAGE_KEY, 'maybe')
      expect(readWideMode(storage)).toBe(false)
    })

    it('falls back to the default when the store throws', () => {
      expect(readWideMode(throwingStorage())).toBe(false)
    })
  })

  describe('setWideMode', () => {
    it('updates the in-memory state and persists to storage', () => {
      const storage = makeStorage()
      setWideMode(storage, true)
      expect(getWideMode()).toBe(true)
      expect(storage.getItem(WIDE_MODE_STORAGE_KEY)).toBe('true')
    })

    it('does not notify when the value is unchanged', () => {
      let calls = 0
      const unsubscribe = subscribeWideMode(() => {
        calls++
      })
      setWideMode(null, false)
      expect(calls).toBe(0)
      unsubscribe()
    })

    it('notifies subscribers when the value changes', () => {
      let calls = 0
      const unsubscribe = subscribeWideMode(() => {
        calls++
      })
      setWideMode(null, true)
      expect(calls).toBe(1)
      setWideMode(null, false)
      expect(calls).toBe(2)
      unsubscribe()
    })

    it('swallows a throwing store without losing the in-memory state', () => {
      setWideMode(throwingStorage(), true)
      expect(getWideMode()).toBe(true)
    })
  })

  describe('initWideMode', () => {
    it('loads the persisted value into the in-memory state', () => {
      const storage = makeStorage()
      storage.setItem(WIDE_MODE_STORAGE_KEY, 'true')
      initWideMode(storage)
      expect(getWideMode()).toBe(true)
    })

    it('is a no-op when the stored value matches the current state', () => {
      let calls = 0
      const unsubscribe = subscribeWideMode(() => {
        calls++
      })
      initWideMode(makeStorage())
      expect(calls).toBe(0)
      unsubscribe()
    })
  })

  describe('applyWideModeToDocument', () => {
    it('does not throw when document is unavailable (node env guard)', () => {
      expect(() => applyWideModeToDocument(true)).not.toThrow()
      expect(() => applyWideModeToDocument(false)).not.toThrow()
    })
  })
})
