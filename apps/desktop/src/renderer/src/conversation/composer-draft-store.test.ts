import { describe, it, expect } from 'vitest'
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  LEGACY_COMPOSER_DRAFT_STORAGE_KEY,
  clearDraft,
  createComposerDraftStore,
  getComposerDraft,
  getDraft,
  setComposerDraft,
  setDraft,
  type DraftStorage,
} from './composer-draft-store'

/**
 * Per-Thread composer drafts (#60): unsent composer text persisted to localStorage
 * so it survives any unmount. The module is pure over an injected storage seam, so
 * here we feed it a Map-backed fake — round-trip, prune, raw-text fidelity, send
 * clear, per-Thread isolation, and the never-throw tolerance paths.
 */

/** A Map-backed fake satisfying the injected `DraftStorage` seam. */
function fakeStorage(): DraftStorage & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
    removeItem: (k) => {
      map.delete(k)
    },
  }
}

describe('getDraft / setDraft round-trip', () => {
  it('stores and reads back a structured draft keyed by threadId', () => {
    const storage = fakeStorage()
    setComposerDraft(storage, 't1', {
      prompt: 'hello world',
      inlineTokens: [],
      contextAttachments: [],
      images: [],
      nonPersistedImageIds: [],
    })
    expect(getComposerDraft(storage, 't1')).toEqual({
      prompt: 'hello world',
      inlineTokens: [],
      contextAttachments: [],
      images: [],
      nonPersistedImageIds: [],
    })
  })

  it('round-trips structured context attachments and images', () => {
    const storage = fakeStorage()
    setComposerDraft(storage, 't1', {
      prompt: 'review this',
      inlineTokens: [],
      contextAttachments: [
        {
          kind: 'review',
          id: 'rc:1',
          filePath: 'src/app.ts',
          startLine: 4,
          endLine: 6,
          note: 'check this',
          excerpt: '+const x = 1',
        },
        { kind: 'pasted', id: 'paste:1', text: 'long\npaste' },
      ],
      images: [
        {
          id: 'img:1',
          data: 'abc',
          mimeType: 'image/png',
          name: 'screen.png',
          previewUrl: 'data:image/png;base64,abc',
        },
      ],
      nonPersistedImageIds: [],
    })

    expect(getComposerDraft(storage, 't1')).toEqual({
      prompt: 'review this',
      inlineTokens: [],
      contextAttachments: [
        {
          kind: 'review',
          id: 'rc:1',
          filePath: 'src/app.ts',
          startLine: 4,
          endLine: 6,
          note: 'check this',
          excerpt: '+const x = 1',
        },
        { kind: 'pasted', id: 'paste:1', text: 'long\npaste' },
      ],
      images: [
        {
          id: 'img:1',
          data: 'abc',
          mimeType: 'image/png',
          name: 'screen.png',
          previewUrl: 'data:image/png;base64,abc',
        },
      ],
      nonPersistedImageIds: [],
    })
  })

  it('stores and reads back a draft keyed by threadId', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'hello world')
    expect(getDraft(storage, 't1')).toBe('hello world')
  })

  it('persists structured drafts behind explicit schema metadata', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'hello world')
    expect(JSON.parse(storage.map.get(COMPOSER_DRAFT_STORAGE_KEY) ?? '{}')).toEqual({
      schemaVersion: 1,
      drafts: {
        t1: {
          prompt: 'hello world',
          inlineTokens: [],
          contextAttachments: [],
          images: [],
          nonPersistedImageIds: [],
        },
      },
    })
  })

  it('returns "" for an absent thread', () => {
    expect(getDraft(fakeStorage(), 'never')).toBe('')
  })

  it('overwrites an existing draft', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'first')
    setDraft(storage, 't1', 'second')
    expect(getDraft(storage, 't1')).toBe('second')
  })
})

describe('prune on empty / whitespace-only', () => {
  it('removes the entry when set to an empty string', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'something')
    setDraft(storage, 't1', '')
    expect(getDraft(storage, 't1')).toBe('')
    // The entry is gone from the underlying map, not stored as ''.
    expect(JSON.parse(storage.map.get(COMPOSER_DRAFT_STORAGE_KEY) ?? '{}')).toEqual({})
  })

  it('removes the entry when set to whitespace-only text', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'something')
    setDraft(storage, 't1', '   \n\t  ')
    expect(getDraft(storage, 't1')).toBe('')
    expect(JSON.parse(storage.map.get(COMPOSER_DRAFT_STORAGE_KEY) ?? '{}')).toEqual({})
  })

  it('removes the whole storage key once the last draft is pruned (no dangling blob)', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'something')
    setDraft(storage, 't1', '')
    expect(storage.map.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false)
  })

  it('removes the whole storage key once the last draft is cleared', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'queued')
    clearDraft(storage, 't1')
    expect(storage.map.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false)
  })
})

describe('raw text fidelity (only the prune decision trims)', () => {
  it('preserves leading/trailing spaces and newlines verbatim', () => {
    const storage = fakeStorage()
    const raw = '  hello \n  world  \n'
    setDraft(storage, 't1', raw)
    expect(getDraft(storage, 't1')).toBe(raw)
  })

  it('keeps a non-empty draft that has trailing whitespace', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'typing ')
    expect(getDraft(storage, 't1')).toBe('typing ')
  })
})

describe('clearDraft (send / delete)', () => {
  it('removes the entry', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'queued prompt')
    clearDraft(storage, 't1')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('is a no-op for an absent entry', () => {
    const storage = fakeStorage()
    expect(() => clearDraft(storage, 'gone')).not.toThrow()
    expect(getDraft(storage, 'gone')).toBe('')
  })
})

describe('per-Thread isolation', () => {
  it('keeps two threads independent', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'one')
    setDraft(storage, 't2', 'two')
    expect(getDraft(storage, 't1')).toBe('one')
    expect(getDraft(storage, 't2')).toBe('two')
  })

  it('clearing one thread leaves the other intact (delete cascade)', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'one')
    setDraft(storage, 't2', 'two')
    clearDraft(storage, 't1')
    expect(getDraft(storage, 't1')).toBe('')
    expect(getDraft(storage, 't2')).toBe('two')
  })

  it('pruning one thread leaves the other intact', () => {
    const storage = fakeStorage()
    setDraft(storage, 't1', 'one')
    setDraft(storage, 't2', 'two')
    setDraft(storage, 't1', '')
    expect(getDraft(storage, 't1')).toBe('')
    expect(getDraft(storage, 't2')).toBe('two')
  })
})

describe('composer draft external store', () => {
  it('notifies subscribers when a Thread draft changes and exposes per-Thread snapshots', () => {
    const storage = fakeStorage()
    const store = createComposerDraftStore(storage)
    let notifications = 0
    const unsubscribe = store.subscribe(() => {
      notifications += 1
    })

    store.setText('t1', 'one')

    expect(notifications).toBe(1)
    expect(store.getSnapshot('t1').prompt).toBe('one')
    expect(store.getTextSnapshot('t1')).toBe('one')
    expect(store.getSnapshot('t2').prompt).toBe('')

    unsubscribe()
    store.setText('t1', 'two')
    expect(notifications).toBe(1)
    expect(store.getSnapshot('t1').prompt).toBe('two')
  })

  it('returns a referentially stable structured snapshot between writes', () => {
    const storage = fakeStorage()
    const store = createComposerDraftStore(storage)
    store.setDraft('t1', {
      prompt: 'one',
      inlineTokens: [{ kind: 'slashCommand', name: 'teach' }],
      contextAttachments: [],
      images: [],
      nonPersistedImageIds: [],
    })

    expect(store.getSnapshot('t1')).toBe(store.getSnapshot('t1'))
  })
})

describe('lazy migration from text-only v1 drafts', () => {
  it('migrates text-only drafts to structured drafts and removes the legacy key after writing v2', () => {
    const storage = fakeStorage()
    storage.map.set(
      LEGACY_COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        t1: 'keep this\n\n<attached_files>\n@src/main.ts\n</attached_files>',
        t2: 'second',
      }),
    )

    expect(getComposerDraft(storage, 't1')).toEqual({
      prompt: 'keep this\n\n<attached_files>\n@src/main.ts\n</attached_files>',
      inlineTokens: [],
      contextAttachments: [],
      images: [],
      nonPersistedImageIds: [],
    })
    expect(getDraft(storage, 't2')).toBe('second')
    expect(storage.map.has(LEGACY_COMPOSER_DRAFT_STORAGE_KEY)).toBe(false)
    expect(JSON.parse(storage.map.get(COMPOSER_DRAFT_STORAGE_KEY) ?? '{}')).toEqual({
      schemaVersion: 1,
      drafts: {
        t1: {
          prompt: 'keep this\n\n<attached_files>\n@src/main.ts\n</attached_files>',
          inlineTokens: [],
          contextAttachments: [],
          images: [],
          nonPersistedImageIds: [],
        },
        t2: {
          prompt: 'second',
          inlineTokens: [],
          contextAttachments: [],
          images: [],
          nonPersistedImageIds: [],
        },
      },
    })
  })

  it('keeps the legacy key and still returns the text draft when the v2 migration write fails', () => {
    const storage = fakeStorage()
    storage.map.set(LEGACY_COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ t1: 'local only' }))
    const originalSetItem = storage.setItem
    storage.setItem = (key, value) => {
      if (key === COMPOSER_DRAFT_STORAGE_KEY) throw new Error('quota exceeded')
      originalSetItem(key, value)
    }

    expect(getDraft(storage, 't1')).toBe('local only')
    expect(storage.map.has(LEGACY_COMPOSER_DRAFT_STORAGE_KEY)).toBe(true)
    expect(storage.map.has(COMPOSER_DRAFT_STORAGE_KEY)).toBe(false)
  })
})

describe('malformed / missing tolerance (never throws into render)', () => {
  it('treats malformed JSON as empty', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '{not json')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('treats a non-object blob as empty', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '"a string"')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('treats an array blob as empty', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '[1,2,3]')
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('treats a non-string entry value as ""', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ t1: 42 }))
    expect(getDraft(storage, 't1')).toBe('')
  })

  it('drops malformed context attachments and images from persisted structured drafts', () => {
    const storage = fakeStorage()
    storage.map.set(
      COMPOSER_DRAFT_STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        drafts: {
          t1: {
            prompt: 'keep',
            inlineTokens: [],
            contextAttachments: [
              { kind: 'file', path: 'src/app.ts' },
              { kind: 'review', id: 'missing-fields' },
              null,
            ],
            images: [
              {
                id: 'img:1',
                data: 'abc',
                mimeType: 'image/png',
                name: 'screen.png',
                previewUrl: 'data:image/png;base64,abc',
              },
              { id: 'bad' },
            ],
            nonPersistedImageIds: [],
          },
        },
      }),
    )

    expect(getComposerDraft(storage, 't1')).toEqual({
      prompt: 'keep',
      inlineTokens: [],
      contextAttachments: [{ kind: 'file', path: 'src/app.ts' }],
      images: [
        {
          id: 'img:1',
          data: 'abc',
          mimeType: 'image/png',
          name: 'screen.png',
          previewUrl: 'data:image/png;base64,abc',
        },
      ],
      nonPersistedImageIds: [],
    })
  })

  it('returns "" for an absent key', () => {
    expect(getDraft(fakeStorage(), 't1')).toBe('')
  })

  it('overwrites a malformed blob on the next set', () => {
    const storage = fakeStorage()
    storage.map.set(COMPOSER_DRAFT_STORAGE_KEY, '{not json')
    setDraft(storage, 't1', 'recovered')
    expect(getDraft(storage, 't1')).toBe('recovered')
  })
})

describe('best-effort writes (a throwing storage does not propagate)', () => {
  it('swallows a setItem exception on set', () => {
    const throwing: DraftStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded')
      },
      removeItem: () => {},
    }
    expect(() => setDraft(throwing, 't1', 'text')).not.toThrow()
  })

  it('swallows a getItem exception on read', () => {
    const throwing: DraftStorage = {
      getItem: () => {
        throw new Error('SecurityError')
      },
      setItem: () => {},
      removeItem: () => {},
    }
    expect(getDraft(throwing, 't1')).toBe('')
    expect(() => clearDraft(throwing, 't1')).not.toThrow()
  })
})

describe('absent storage guard', () => {
  it('getDraft returns "" when storage is null/undefined', () => {
    expect(getDraft(null, 't1')).toBe('')
    expect(getDraft(undefined, 't1')).toBe('')
  })

  it('setDraft / clearDraft are no-ops when storage is null/undefined', () => {
    expect(() => setDraft(null, 't1', 'x')).not.toThrow()
    expect(() => clearDraft(undefined, 't1')).not.toThrow()
  })
})
