import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ThreadMeta } from '../../../shared/ipc'
import {
  _resetComposerDraftStore,
  isComposerDraftEmpty,
} from '../conversation/composer-draft-store'
import { replayCache } from '../conversation/replay-cache'
import { initialConversationState } from '../conversation/reducer'
import {
  _resetSidePanelStore,
  getWorkspacePanel,
  openWorkspaceSideThreadSurface,
  promoteWorkspaceSideThreadSurface,
} from '../side-panel/side-panel-store'
import { initialNavState } from '../shell/nav-reducer'
import { useWorkspaceActions, type WorkspaceActionsDeps } from './use-workspace-actions'

const THREAD: ThreadMeta = {
  id: 'thread-1',
  workspaceId: 'ws-a',
  sessionId: 'session-1',
  title: 'One',
  createdAt: 1,
  lastActiveAt: 1,
}

function fakeStorage(): Storage {
  return {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  } as unknown as Storage
}

function deps(): WorkspaceActionsDeps {
  return {
    recents: [
      { id: 'ws-a', dir: '/a', displayName: 'A', lastOpenedAt: 1, threads: [THREAD] },
    ],
    nav: initialNavState,
    connections: {},
    workspaceThreads: {},
    navDispatch: vi.fn(),
    connDispatch: vi.fn(),
    wtDispatch: vi.fn(),
    setStatuses: vi.fn(),
    refreshRecents: vi.fn(async () => undefined),
    selectThreadInWorkspace: vi.fn(),
    storage: fakeStorage(),
  }
}

function openDurableSideThread(): void {
  openWorkspaceSideThreadSurface('ws-a', THREAD.id)
  promoteWorkspaceSideThreadSurface('ws-a', THREAD.id)
}

describe('useWorkspaceActions Side Thread placement cleanup', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    _resetComposerDraftStore(null)
    replayCache.clear()
    _resetSidePanelStore(null)
  })

  it('discards a renderer-only Draft Thread from every renderer projection', () => {
    const draftId = 'draft-thread'
    const draftStore = _resetComposerDraftStore(null)
    draftStore.setText(draftId, 'orphaned text')
    replayCache.put(draftId, {
      state: initialConversationState,
      sessionId: null,
      workspaceId: 'ws-a',
    })
    openWorkspaceSideThreadSurface('ws-a', draftId)
    const d = deps()

    useWorkspaceActions(d).discardDraftThread('ws-a', draftId)

    expect(d.wtDispatch).toHaveBeenCalledWith({
      type: 'remove',
      workspaceId: 'ws-a',
      threadId: draftId,
    })
    const updateStatuses = vi.mocked(d.setStatuses).mock.calls[0]?.[0]
    expect(typeof updateStatuses).toBe('function')
    if (typeof updateStatuses === 'function') {
      expect(
        updateStatuses({ [draftId]: { streaming: false, needsAttention: false } }),
      ).toEqual({})
    }
    expect(isComposerDraftEmpty(draftId)).toBe(true)
    expect(replayCache.take(draftId)).toBeNull()
    expect(getWorkspacePanel('ws-a').surfaces).toEqual([])
  })

  it('closes a deleted Thread Surface after main confirms deletion', async () => {
    vi.stubGlobal('window', { api: { deleteThread: vi.fn(async () => ({ ok: true })) } })
    _resetSidePanelStore(null)
    openDurableSideThread()

    await useWorkspaceActions(deps()).deleteThread(THREAD)

    expect(getWorkspacePanel('ws-a').surfaces).toEqual([])
  })

  it('leaves placement untouched when main refuses deletion', async () => {
    vi.stubGlobal('window', {
      api: { deleteThread: vi.fn(async () => ({ ok: false, reason: 'streaming' })) },
    })
    _resetSidePanelStore(null)
    openDurableSideThread()

    await useWorkspaceActions(deps()).deleteThread(THREAD)

    expect(getWorkspacePanel('ws-a').activeSurfaceId).toBe('thread:thread-1')
  })

  it('cascades Workspace removal through the whole placement entry', async () => {
    vi.stubGlobal('window', { api: { removeWorkspace: vi.fn(async () => undefined) } })
    _resetSidePanelStore(null)
    openDurableSideThread()

    await useWorkspaceActions(deps()).removeWorkspace('ws-a')

    expect(getWorkspacePanel('ws-a').surfaces).toEqual([])
  })
})
