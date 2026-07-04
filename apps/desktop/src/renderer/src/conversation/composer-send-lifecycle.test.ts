import { describe, expect, it } from 'vitest'
import {
  createComposerSendSnapshot,
  createQueuedFollowUp,
  restoreFailedSendSnapshot,
} from './composer-send-lifecycle'
import type { PendingContext } from './pending-contexts'

describe('createComposerSendSnapshot', () => {
  it('captures an immutable send-ready snapshot from live composer state', () => {
    const contexts: PendingContext[] = [{ kind: 'file', path: 'src/app.ts' }]
    const images = [
      {
        id: 'img:1',
        name: 'screen.png',
        data: 'abc',
        mimeType: 'image/png',
        previewUrl: 'data:image/png;base64,abc',
      },
    ]

    const snapshot = createComposerSendSnapshot({
      prompt: 'read this',
      contexts,
      images,
    })

    contexts.push({ kind: 'skill', name: 'teach' })
    images[0].data = 'mutated'

    expect(snapshot.hasContent).toBe(true)
    expect(snapshot.text).toBe('read this\n\n<attached_files>\n@src/app.ts\n</attached_files>')
    expect(snapshot.images).toEqual([
      {
        data: 'abc',
        mimeType: 'image/png',
        previewUrl: 'data:image/png;base64,abc',
      },
    ])
    expect(snapshot.restore).toEqual({
      prompt: 'read this',
      contexts: [{ kind: 'file', path: 'src/app.ts' }],
      images: [
        {
          id: 'img:1',
          name: 'screen.png',
          data: 'abc',
          mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,abc',
        },
      ],
    })
  })
})

describe('restoreFailedSendSnapshot', () => {
  it('restores the attempted snapshot only when the current composer is still empty', () => {
    const snapshot = createComposerSendSnapshot({
      prompt: 'retry this',
      contexts: [{ kind: 'skill', name: 'teach' }],
      images: [
        {
          id: 'img:1',
          name: 'screen.png',
          data: 'abc',
          mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,abc',
        },
      ],
    })

    expect(
      restoreFailedSendSnapshot(snapshot, {
        prompt: '',
        contexts: [],
        images: [],
      }),
    ).toEqual(snapshot.restore)

    expect(
      restoreFailedSendSnapshot(snapshot, {
        prompt: 'new draft',
        contexts: [],
        images: [],
      }),
    ).toEqual({
      prompt: 'new draft',
      contexts: [],
      images: [],
    })
  })
})

describe('createQueuedFollowUp', () => {
  it('stores the send-ready snapshot payload independently from later snapshot mutation', () => {
    const snapshot = createComposerSendSnapshot({
      prompt: 'queue this',
      contexts: [],
      images: [
        {
          id: 'img:1',
          name: 'screen.png',
          data: 'abc',
          mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,abc',
        },
      ],
    })

    const queued = createQueuedFollowUp('queued:1', snapshot)
    snapshot.images[0].data = 'mutated'

    expect(queued).toEqual({
      id: 'queued:1',
      text: 'queue this',
      images: [
        {
          data: 'abc',
          mimeType: 'image/png',
          previewUrl: 'data:image/png;base64,abc',
        },
      ],
    })
  })
})
