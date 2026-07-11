import { afterEach, describe, expect, it } from 'vitest'
import {
  activateSurface,
  activateWorkspaceSurface,
  closeAllSurfaces,
  closeOtherSurfaces,
  closeSurface,
  closeSurfacesToRight,
  closePanel,
  closeWorkspaceSurface,
  coercePanelState,
  coerceSurface,
  EMPTY_PANEL_STATE,
  getWorkspacePanel,
  MAX_TERMINALS_PER_WORKSPACE,
  openBrowserSurface,
  setBrowserSurfaceUrl,
  toggleBrowserSurface,
  openFileSurface,
  openSideThreadSurface,
  openSurface,
  openTerminalSurface,
  terminalSurfaceCount,
  toggleTerminalSurface,
  openWorkspaceFileSurface,
  openWorkspaceSideThreadSurface,
  openWorkspaceSurface,
  promoteSideThreadSurface,
  promoteWorkspaceSideThreadSurface,
  readPanelMap,
  removeWorkspacePanel,
  showPanel,
  SIDE_PANEL_STORAGE_KEY,
  subscribe,
  toggleSurface,
  toggleWorkspaceSurface,
  togglePanelVisibility,
  updateWorkspace,
  writePanelMap,
  _resetSidePanelStore,
  type PanelStorage,
  type Surface,
  type WorkspacePanelState,
} from './side-panel-store'

/** A closed, empty starting state (a copy so tests never share the frozen constant). */
function empty(): WorkspacePanelState {
  return { isOpen: false, activeSurfaceId: null, surfaces: [] }
}

const REVIEW: Surface = { id: 'review', kind: 'review' }
const FILES: Surface = { id: 'files', kind: 'files' }

describe('openSurface', () => {
  it('opens the panel with the singleton active from a closed empty state', () => {
    expect(openSurface(empty(), 'review')).toEqual({
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW],
    })
  })

  it('appends a second singleton and activates it (ordered, both open)', () => {
    const one = openSurface(empty(), 'review')
    expect(openSurface(one, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('re-activates an already-open singleton instead of duplicating it', () => {
    const both = openSurface(openSurface(empty(), 'review'), 'files')
    const again = openSurface(both, 'review')
    expect(again.surfaces).toEqual([REVIEW, FILES])
    expect(again.activeSurfaceId).toBe('review')
  })

  it('re-opens the panel (isOpen) when a hidden panel still holds the surface', () => {
    const hidden: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(openSurface(hidden, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })
})

describe('openFileSurface', () => {
  const APP: Surface = { id: 'file:src/app.ts', kind: 'file', relativePath: 'src/app.ts' }
  const UTIL: Surface = { id: 'file:src/util.ts', kind: 'file', relativePath: 'src/util.ts' }

  it('opens a file tab (id keyed by path) and activates it, opening the panel', () => {
    expect(openFileSurface(empty(), 'src/app.ts')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/app.ts',
      surfaces: [APP],
    })
  })

  it('appends a second distinct file tab, activating the new one', () => {
    const one = openFileSurface(empty(), 'src/app.ts')
    expect(openFileSurface(one, 'src/util.ts')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/util.ts',
      surfaces: [APP, UTIL],
    })
  })

  it('re-activates an already-open file (dedupe by path) instead of duplicating it', () => {
    const both = openFileSurface(openFileSurface(empty(), 'src/app.ts'), 'src/util.ts')
    const again = openFileSurface(both, 'src/app.ts')
    expect(again.surfaces).toEqual([APP, UTIL]) // no duplicate appended
    expect(again.activeSurfaceId).toBe('file:src/app.ts') // just re-activated
  })

  it('coexists with singleton surfaces (opened beside Review/Files)', () => {
    const withReview = openSurface(empty(), 'review')
    const withFile = openFileSurface(withReview, 'src/app.ts')
    expect(withFile.surfaces).toEqual([REVIEW, APP])
    expect(withFile.activeSurfaceId).toBe('file:src/app.ts')
  })
})

describe('openSideThreadSurface', () => {
  it('opens and activates a Draft Side Thread Surface keyed by its Thread id', () => {
    expect(openSideThreadSurface(empty(), 'thread-1')).toEqual({
      isOpen: true,
      activeSurfaceId: 'thread:thread-1',
      surfaces: [
        {
          id: 'thread:thread-1',
          kind: 'thread',
          threadId: 'thread-1',
          lifecycle: 'draft',
        },
      ],
    })
  })

  it('promotes only the matching Draft Side Thread to durable without disturbing siblings', () => {
    const first = openSideThreadSurface(empty(), 'thread-1')
    const both = openSideThreadSurface(first, 'thread-2')

    expect(promoteSideThreadSurface(both, 'thread-1')).toEqual({
      ...both,
      surfaces: [
        {
          id: 'thread:thread-1',
          kind: 'thread',
          threadId: 'thread-1',
          lifecycle: 'durable',
        },
        {
          id: 'thread:thread-2',
          kind: 'thread',
          threadId: 'thread-2',
          lifecycle: 'draft',
        },
      ],
    })
  })

  it('promotion is a no-op for an unknown or already-durable Side Thread', () => {
    const draft = openSideThreadSurface(empty(), 'thread-1')
    expect(promoteSideThreadSurface(draft, 'missing')).toBe(draft)

    const durable = promoteSideThreadSurface(draft, 'thread-1')
    expect(promoteSideThreadSurface(durable, 'thread-1')).toBe(durable)
  })
})

describe('openTerminalSurface (ADR-0014, slice 3 multi-terminal)', () => {
  const T1: Surface = { id: 'terminal:term-1', kind: 'terminal', resourceId: 'term-1' }
  const T2: Surface = { id: 'terminal:term-2', kind: 'terminal', resourceId: 'term-2' }

  it('opens term-1 for the first terminal, activating it', () => {
    expect(openTerminalSurface(empty())).toEqual({ isOpen: true, activeSurfaceId: 'terminal:term-1', surfaces: [T1] })
  })

  it('mints a NEW term-N each call (a second terminal, not a re-activation)', () => {
    const one = openTerminalSurface(empty())
    const two = openTerminalSurface(one)
    expect(two.surfaces).toEqual([T1, T2])
    expect(two.activeSurfaceId).toBe('terminal:term-2')
  })

  it('reuses the lowest-free id after a close (gap reuse keeps ids small)', () => {
    const two = openTerminalSurface(openTerminalSurface(empty())) // term-1, term-2
    const closedFirst = closeSurface(two, 'terminal:term-1') // frees term-1
    const reopened = openTerminalSurface(closedFirst)
    expect(reopened.surfaces.map((s) => s.id)).toEqual(['terminal:term-2', 'terminal:term-1'])
  })

  it('no-ops at the per-Workspace cap (returns the same state)', () => {
    let state = empty()
    for (let i = 0; i < MAX_TERMINALS_PER_WORKSPACE; i++) state = openTerminalSurface(state)
    expect(terminalSurfaceCount(state)).toBe(MAX_TERMINALS_PER_WORKSPACE)
    expect(openTerminalSurface(state)).toBe(state) // same ref — capped
  })
})

describe('toggleTerminalSurface (header button / ⌘J semantics)', () => {
  const T1: Surface = { id: 'terminal:term-1', kind: 'terminal', resourceId: 'term-1' }

  it('spawns term-1 from a closed empty state (nothing to re-activate)', () => {
    expect(toggleTerminalSurface(empty())).toEqual({
      isOpen: true,
      activeSurfaceId: 'terminal:term-1',
      surfaces: [T1],
    })
  })

  it('hides the panel when a terminal is the active tab', () => {
    const open = toggleTerminalSurface(empty())
    expect(toggleTerminalSurface(open)).toEqual({ ...open, isOpen: false })
  })

  it('re-shows the SAME terminal after a hide (never spawns a second)', () => {
    const hidden = toggleTerminalSurface(toggleTerminalSurface(empty()))
    expect(toggleTerminalSurface(hidden)).toEqual({
      isOpen: true,
      activeSurfaceId: 'terminal:term-1',
      surfaces: [T1],
    })
  })

  it('re-activates an existing terminal from another active tab (no new spawn)', () => {
    const withReview = openSurface(toggleTerminalSurface(empty()), 'review') // review active
    const toggled = toggleTerminalSurface(withReview)
    expect(toggled.isOpen).toBe(true)
    expect(toggled.activeSurfaceId).toBe('terminal:term-1')
    expect(toggled.surfaces).toEqual([T1, REVIEW])
  })

  it('spawns a terminal when the panel is open on another tab with none open', () => {
    const filesOnly = openSurface(empty(), 'files')
    const toggled = toggleTerminalSurface(filesOnly)
    expect(toggled.activeSurfaceId).toBe('terminal:term-1')
    expect(toggled.surfaces.map((s) => s.kind)).toEqual(['files', 'terminal'])
  })
})

describe('openBrowserSurface (#216, singleton dev-server preview)', () => {
  const B: Surface = { id: 'browser:main', kind: 'browser', resourceId: 'main' }

  it('opens the singleton browser tab, activating it and opening the panel', () => {
    expect(openBrowserSurface(empty())).toEqual({
      isOpen: true,
      activeSurfaceId: 'browser:main',
      surfaces: [B],
    })
  })

  it('re-activates rather than duplicates when already open (singleton semantics)', () => {
    const withBrowser = openBrowserSurface(empty())
    const behindOther = openSurface(withBrowser, 'files')
    const again = openBrowserSurface(behindOther)
    expect(again.surfaces.filter((s) => s.kind === 'browser')).toHaveLength(1)
    expect(again.activeSurfaceId).toBe('browser:main')
  })

  it('preserves a previously-stored url when re-opened (does not wipe it)', () => {
    const withUrl = setBrowserSurfaceUrl(openBrowserSurface(empty()), 'http://localhost:5173/')
    const files = openSurface(withUrl, 'files')
    const reopened = openBrowserSurface(files)
    const browser = reopened.surfaces.find((s) => s.kind === 'browser')
    expect(browser).toMatchObject({ kind: 'browser', url: 'http://localhost:5173/' })
  })
})

describe('setBrowserSurfaceUrl (#217, per-Workspace URL persistence)', () => {
  it('records the last visited url on the browser surface', () => {
    const s = setBrowserSurfaceUrl(openBrowserSurface(empty()), 'http://localhost:3000/app')
    expect(s.surfaces.find((x) => x.kind === 'browser')).toEqual({
      id: 'browser:main',
      kind: 'browser',
      resourceId: 'main',
      url: 'http://localhost:3000/app',
    })
  })

  it('is a no-op (same ref) when no browser surface is open', () => {
    const s = openSurface(empty(), 'files')
    expect(setBrowserSurfaceUrl(s, 'http://x/')).toBe(s)
  })
})

describe('toggleBrowserSurface (⌘T semantics, #217)', () => {
  it('opens/activates the browser when it is not the active tab', () => {
    const s = toggleBrowserSurface(empty())
    expect(s.isOpen).toBe(true)
    expect(s.activeSurfaceId).toBe('browser:main')
  })

  it('hides the panel when the browser is already the active tab', () => {
    const open = toggleBrowserSurface(empty())
    expect(toggleBrowserSurface(open)).toEqual({ ...open, isOpen: false })
  })

  it('activates the browser (not hide) when another tab is active', () => {
    const withBoth = openSurface(openBrowserSurface(empty()), 'files') // files active
    const s = toggleBrowserSurface(withBoth)
    expect(s.isOpen).toBe(true)
    expect(s.activeSurfaceId).toBe('browser:main')
  })
})

describe('toggleSurface (⌘P / ⌃⇧G semantics)', () => {
  it('opens a closed empty panel with the surface active', () => {
    expect(toggleSurface(empty(), 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('opens a closed panel that already holds the surface (does NOT stay closed)', () => {
    const hidden: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(toggleSurface(hidden, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('hides the panel when its kind is already the ACTIVE tab (keeping tabs + active id)', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(toggleSurface(open, 'files')).toEqual({
      isOpen: false,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('switches to the surface when a DIFFERENT tab is active (panel stays open)', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(toggleSurface(open, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('opens + adds the surface when the panel is open but the kind is not present', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW] }
    expect(toggleSurface(open, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })
})

describe('activateSurface', () => {
  it('activates an open surface and shows the panel', () => {
    const hidden: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(activateSurface(hidden, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('is a no-op for an unknown id (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW] }
    expect(activateSurface(state, 'files')).toBe(state)
  })
})

describe('closeSurface', () => {
  it('removes a non-active tab, leaving the active one', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(closeSurface(state, 'review')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('activates the NEXT tab (slid into the slot) when closing the active middle tab', () => {
    const c: Surface = { id: 'file:c', kind: 'file', relativePath: 'c' }
    const state: WorkspacePanelState = {
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES, c],
    }
    // index 1 (files) closed → neighbour at min(1, 1) = the new index 1 = c.
    expect(closeSurface(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:c',
      surfaces: [REVIEW, c],
    })
  })

  it('activates the new LAST tab when closing the active last tab', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    // index 1 closed → min(1, 0) = 0 = review.
    expect(closeSurface(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW],
    })
  })

  it('returns to the cards (active null, panel still open) when closing the last tab', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(closeSurface(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: null,
      surfaces: [],
    })
  })

  it('is a no-op for an unknown id (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW] }
    expect(closeSurface(state, 'files')).toBe(state)
  })
})

describe('closeOtherSurfaces', () => {
  it('keeps + activates only the given surface', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(closeOtherSurfaces(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('is a no-op with a single surface (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(closeOtherSurfaces(state, 'files')).toBe(state)
  })
})

describe('closeSurfacesToRight', () => {
  it('drops every tab after the given one', () => {
    const c: Surface = { id: 'file:c', kind: 'file', relativePath: 'c' }
    const state: WorkspacePanelState = {
      isOpen: true,
      activeSurfaceId: 'file:c',
      surfaces: [REVIEW, FILES, c],
    }
    // active (c) is dropped → falls back to the anchor (files).
    expect(closeSurfacesToRight(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('keeps the active tab when it survives to the left', () => {
    const c: Surface = { id: 'file:c', kind: 'file', relativePath: 'c' }
    const state: WorkspacePanelState = {
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW, FILES, c],
    }
    expect(closeSurfacesToRight(state, 'files')).toEqual({
      isOpen: true,
      activeSurfaceId: 'review',
      surfaces: [REVIEW, FILES],
    })
  })

  it('is a no-op when the given tab is already last (same ref)', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(closeSurfacesToRight(state, 'files')).toBe(state)
  })
})

describe('closeAllSurfaces', () => {
  it('clears every tab and hides the panel', () => {
    const state: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'review', surfaces: [REVIEW, FILES] }
    expect(closeAllSurfaces(state)).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] })
  })

  it('is a no-op when already empty (same ref)', () => {
    const state = empty()
    expect(closeAllSurfaces(state)).toBe(state)
  })
})

describe('panel visibility', () => {
  it('showPanel opens; is a no-op when already open', () => {
    const closed: WorkspacePanelState = { isOpen: false, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(showPanel(closed).isOpen).toBe(true)
    const open = showPanel(closed)
    expect(showPanel(open)).toBe(open)
  })

  it('closePanel hides; is a no-op when already closed', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] }
    expect(closePanel(open).isOpen).toBe(false)
    const closed = closePanel(open)
    expect(closePanel(closed)).toBe(closed)
  })

  it('togglePanelVisibility flips isOpen, keeping tabs + active id', () => {
    const open: WorkspacePanelState = { isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] }
    expect(togglePanelVisibility(open)).toEqual({
      isOpen: false,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
    expect(togglePanelVisibility(togglePanelVisibility(open))).toEqual(open)
  })
})

describe('updateWorkspace', () => {
  it('scopes state per Workspace without touching siblings (stable sibling ref)', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const before = map['ws-a']
    const next = updateWorkspace(map, 'ws-b', (s) => openSurface(s, 'files'))
    expect(next['ws-a']).toBe(before) // unchanged sibling keeps its identity
    expect(next['ws-b']?.activeSurfaceId).toBe('files')
  })

  it('prunes a Workspace that lands fully-empty (no residue)', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const closed = updateWorkspace(map, 'ws-a', closeAllSurfaces)
    expect('ws-a' in closed).toBe(false)
  })

  it('returns the SAME map when the updater is a no-op', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const same = updateWorkspace(map, 'ws-a', (s) => activateSurface(s, 'nope'))
    expect(same).toBe(map)
  })

  it('KEEPS an open, zero-surface Workspace (the cards empty state is legitimate)', () => {
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(s, 'review'))
    const cards = updateWorkspace(map, 'ws-a', (s) => closeSurface(s, 'review'))
    expect(cards['ws-a']).toEqual({ isOpen: true, activeSurfaceId: null, surfaces: [] })
  })
})

describe('coerceSurface', () => {
  it('accepts the implemented singletons', () => {
    expect(coerceSurface({ id: 'review', kind: 'review' })).toEqual(REVIEW)
    expect(coerceSurface({ id: 'files', kind: 'files' })).toEqual(FILES)
  })

  it('accepts a well-formed persisted file tab (id matches file:<relativePath>)', () => {
    expect(coerceSurface({ id: 'file:src/app.ts', kind: 'file', relativePath: 'src/app.ts' })).toEqual({
      id: 'file:src/app.ts',
      kind: 'file',
      relativePath: 'src/app.ts',
    })
  })

  it('drops a malformed file tab (missing/mismatched id, empty or non-string path)', () => {
    expect(coerceSurface({ kind: 'file', relativePath: 'x' })).toBeNull() // no id
    expect(coerceSurface({ id: 'file:wrong', kind: 'file', relativePath: 'x' })).toBeNull() // id≠file:x
    expect(coerceSurface({ id: 'file:', kind: 'file', relativePath: '' })).toBeNull() // empty path
    expect(coerceSurface({ id: 'file:5', kind: 'file', relativePath: 5 })).toBeNull() // non-string
  })

  it('accepts any well-formed term-N terminal tab and drops malformed ones', () => {
    expect(coerceSurface({ id: 'terminal:term-1', kind: 'terminal', resourceId: 'term-1' })).toEqual({
      id: 'terminal:term-1',
      kind: 'terminal',
      resourceId: 'term-1',
    })
    expect(coerceSurface({ id: 'terminal:term-3', kind: 'terminal', resourceId: 'term-3' })).toEqual({
      id: 'terminal:term-3',
      kind: 'terminal',
      resourceId: 'term-3',
    })
    expect(coerceSurface({ kind: 'terminal' })).toBeNull() // no id/resource
    expect(coerceSurface({ id: 'terminal:evil', kind: 'terminal', resourceId: 'evil' })).toBeNull() // not term-N
    expect(coerceSurface({ id: 'terminal:term-1', kind: 'terminal', resourceId: 'term-9' })).toBeNull() // id≠resource
  })

  it('accepts the singleton browser tab and drops malformed browser blobs (#216)', () => {
    expect(coerceSurface({ id: 'browser:main', kind: 'browser', resourceId: 'main' })).toEqual({
      id: 'browser:main',
      kind: 'browser',
      resourceId: 'main',
    })
    expect(coerceSurface({ kind: 'browser' })).toBeNull() // no id/resource
    expect(coerceSurface({ id: 'browser:evil', kind: 'browser', resourceId: 'evil' })).toBeNull() // not the singleton
    expect(coerceSurface({ id: 'browser:main', kind: 'browser', resourceId: 'other' })).toBeNull() // id≠resource
  })

  it('restores a persisted browser url when it is a valid http(s) URL (#217)', () => {
    expect(
      coerceSurface({ id: 'browser:main', kind: 'browser', resourceId: 'main', url: 'http://localhost:5173/' }),
    ).toEqual({ id: 'browser:main', kind: 'browser', resourceId: 'main', url: 'http://localhost:5173/' })
  })

  it('drops a bad/unsafe persisted url but keeps the browser surface', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', '', 42, null]) {
      expect(coerceSurface({ id: 'browser:main', kind: 'browser', resourceId: 'main', url })).toEqual({
        id: 'browser:main',
        kind: 'browser',
        resourceId: 'main',
      })
    }
  })

  it('never restores a Draft Side Thread descriptor but accepts the durable lifecycle seam', () => {
    expect(
      coerceSurface({
        id: 'thread:thread-1',
        kind: 'thread',
        threadId: 'thread-1',
        lifecycle: 'draft',
      }),
    ).toBeNull()
    expect(
      coerceSurface({
        id: 'thread:thread-1',
        kind: 'thread',
        threadId: 'thread-1',
        lifecycle: 'durable',
      }),
    ).toEqual({
      id: 'thread:thread-1',
      kind: 'thread',
      threadId: 'thread-1',
      lifecycle: 'durable',
    })
  })

  it('drops not-yet-implemented / unknown / malformed descriptors', () => {
    expect(coerceSurface({ kind: 'nope' })).toBeNull()
    expect(coerceSurface(null)).toBeNull()
    expect(coerceSurface('review')).toBeNull()
  })
})

describe('coercePanelState', () => {
  it('coerces + de-duplicates surfaces and validates the active id', () => {
    const state = coercePanelState({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [
        { id: 'review', kind: 'review' },
        { id: 'review', kind: 'review' },
        { id: 'files', kind: 'files' },
        { id: 'x', kind: 'nope' },
      ],
    })
    expect(state).toEqual({ isOpen: true, activeSurfaceId: 'files', surfaces: [REVIEW, FILES] })
  })

  it('nulls an active id that no longer names a surviving surface', () => {
    const state = coercePanelState({ isOpen: true, activeSurfaceId: 'gone', surfaces: [REVIEW] })
    expect(state.activeSurfaceId).toBeNull()
  })

  it('degrades a malformed blob to the empty state', () => {
    expect(coercePanelState(null)).toEqual(EMPTY_PANEL_STATE)
    expect(coercePanelState(42)).toEqual(EMPTY_PANEL_STATE)
    expect(coercePanelState([])).toEqual(EMPTY_PANEL_STATE)
    expect(coercePanelState({})).toEqual({ isOpen: false, activeSurfaceId: null, surfaces: [] })
  })
})

// --- Persistence round-trip through a fake storage ---

/** An in-memory `PanelStorage` with an injectable throw. */
function fakeStorage(): PanelStorage & { store: Map<string, string>; throwOnGet?: boolean; throwOnSet?: boolean } {
  const store = new Map<string, string>()
  return {
    store,
    getItem(key) {
      if (this.throwOnGet) throw new Error('blocked')
      return store.get(key) ?? null
    },
    setItem(key, value) {
      if (this.throwOnSet) throw new Error('full')
      store.set(key, value)
    },
  }
}

describe('readPanelMap / writePanelMap', () => {
  it('round-trips a per-Workspace map under the v2 key', () => {
    const storage = fakeStorage()
    const map = updateWorkspace({}, 'ws-a', (s) => openSurface(openSurface(s, 'review'), 'files'))
    writePanelMap(storage, map)
    expect(storage.store.has(SIDE_PANEL_STORAGE_KEY)).toBe(true)
    expect(readPanelMap(storage)).toEqual(map)
  })

  it('returns {} for absent storage value', () => {
    expect(readPanelMap(fakeStorage())).toEqual({})
  })

  it('falls through an active Draft Side Thread to the next surviving Surface on restore', () => {
    const storage = fakeStorage()
    const draft: Surface = {
      id: 'thread:thread-1',
      kind: 'thread',
      threadId: 'thread-1',
      lifecycle: 'draft',
    }
    writePanelMap(storage, {
      'ws-a': {
        isOpen: true,
        activeSurfaceId: draft.id,
        surfaces: [REVIEW, draft, FILES],
      },
    })

    expect(readPanelMap(storage)['ws-a']).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [REVIEW, FILES],
    })
  })

  it('falls back to the previous surviving Surface when an active Draft has no durable neighbour to its right', () => {
    const storage = fakeStorage()
    const draft: Surface = {
      id: 'thread:thread-1',
      kind: 'thread',
      threadId: 'thread-1',
      lifecycle: 'draft',
    }
    writePanelMap(storage, {
      'ws-a': {
        isOpen: true,
        activeSurfaceId: draft.id,
        surfaces: [REVIEW, draft],
      },
    })

    expect(readPanelMap(storage)['ws-a']?.activeSurfaceId).toBe('review')
  })

  it('prunes fully-empty entries on read', () => {
    const storage = fakeStorage()
    storage.store.set(
      SIDE_PANEL_STORAGE_KEY,
      JSON.stringify({ 'ws-a': { isOpen: false, activeSurfaceId: null, surfaces: [] } }),
    )
    expect(readPanelMap(storage)).toEqual({})
  })

  it('degrades a non-object / array payload to {}', () => {
    const storage = fakeStorage()
    storage.store.set(SIDE_PANEL_STORAGE_KEY, JSON.stringify([1, 2, 3]))
    expect(readPanelMap(storage)).toEqual({})
  })

  it('swallows a throwing setItem (best-effort write)', () => {
    const storage = fakeStorage()
    storage.throwOnSet = true
    expect(() => writePanelMap(storage, { 'ws-a': openSurface(empty(), 'review') })).not.toThrow()
  })
})

// --- The reactive singleton (reset per test so state never leaks) ---

describe('module singleton', () => {
  afterEach(() => _resetSidePanelStore(null))

  it('seeds from the injected storage and reads back per Workspace', () => {
    const storage = fakeStorage()
    writePanelMap(storage, { 'ws-a': openSurface(empty(), 'review') })
    _resetSidePanelStore(storage)
    expect(getWorkspacePanel('ws-a').activeSurfaceId).toBe('review')
    expect(getWorkspacePanel('ws-unknown')).toBe(EMPTY_PANEL_STATE)
  })

  it('persists ops back to the injected storage', () => {
    const storage = fakeStorage()
    _resetSidePanelStore(storage)
    openWorkspaceSurface('ws-a', 'files')
    expect(readPanelMap(storage)['ws-a']).toEqual({
      isOpen: true,
      activeSurfaceId: 'files',
      surfaces: [FILES],
    })
  })

  it('opens + persists a file tab through the workspace-scoped wrapper', () => {
    const storage = fakeStorage()
    _resetSidePanelStore(storage)
    openWorkspaceFileSurface('ws-a', 'src/app.ts')
    const stored = readPanelMap(storage)['ws-a']
    expect(stored).toEqual({
      isOpen: true,
      activeSurfaceId: 'file:src/app.ts',
      surfaces: [{ id: 'file:src/app.ts', kind: 'file', relativePath: 'src/app.ts' }],
    })
    // Re-opening the same path just re-activates (no duplicate) and survives a reload round-trip.
    openWorkspaceFileSurface('ws-a', 'src/app.ts')
    _resetSidePanelStore(storage)
    expect(getWorkspacePanel('ws-a').surfaces).toHaveLength(1)
  })

  it('keeps a workspace-scoped Draft Side Thread live but never persists or restores its descriptor', () => {
    const storage = fakeStorage()
    _resetSidePanelStore(storage)

    openWorkspaceSideThreadSurface('ws-a', 'thread-1')

    expect(getWorkspacePanel('ws-a').activeSurfaceId).toBe('thread:thread-1')
    expect(storage.store.get(SIDE_PANEL_STORAGE_KEY)).not.toContain('thread-1')

    _resetSidePanelStore(storage)
    expect(getWorkspacePanel('ws-a').surfaces).toEqual([])
    expect(getWorkspacePanel('ws-a').activeSurfaceId).toBeNull()
  })

  it('uses the standard workspace-scoped activation and close mechanics for Side Drafts', () => {
    _resetSidePanelStore(null)
    openWorkspaceSideThreadSurface('ws-a', 'thread-1')
    openWorkspaceSideThreadSurface('ws-a', 'thread-2')

    activateWorkspaceSurface('ws-a', 'thread:thread-1')
    expect(getWorkspacePanel('ws-a').activeSurfaceId).toBe('thread:thread-1')

    closeWorkspaceSurface('ws-a', 'thread:thread-1')
    expect(getWorkspacePanel('ws-a')).toEqual({
      isOpen: true,
      activeSurfaceId: 'thread:thread-2',
      surfaces: [
        {
          id: 'thread:thread-2',
          kind: 'thread',
          threadId: 'thread-2',
          lifecycle: 'draft',
        },
      ],
    })
  })

  it('persists and restores a workspace-scoped Side Thread only after promotion', () => {
    const storage = fakeStorage()
    _resetSidePanelStore(storage)
    openWorkspaceSideThreadSurface('ws-a', 'thread-1')

    promoteWorkspaceSideThreadSurface('ws-a', 'thread-1')
    _resetSidePanelStore(storage)

    expect(getWorkspacePanel('ws-a')).toEqual({
      isOpen: true,
      activeSurfaceId: 'thread:thread-1',
      surfaces: [
        {
          id: 'thread:thread-1',
          kind: 'thread',
          threadId: 'thread-1',
          lifecycle: 'durable',
        },
      ],
    })
  })

  it('notifies subscribers on a real change only', () => {
    _resetSidePanelStore(null)
    let count = 0
    const off = subscribe(() => (count += 1))
    openWorkspaceSurface('ws-a', 'files')
    expect(count).toBe(1)
    activateWorkspaceSurface('ws-a', 'zzz') // unknown id changes nothing → no notify
    expect(count).toBe(1)
    off()
  })

  it('tolerates a throwing storage on seed (degrades to empty)', () => {
    const storage = fakeStorage()
    storage.throwOnGet = true
    expect(() => _resetSidePanelStore(storage)).not.toThrow()
    expect(getWorkspacePanel('ws-a')).toBe(EMPTY_PANEL_STATE)
  })

  it('toggleWorkspaceSurface drives the full open→hide cycle', () => {
    _resetSidePanelStore(null)
    toggleWorkspaceSurface('ws-a', 'files') // closed → open, files active
    expect(getWorkspacePanel('ws-a')).toEqual({ isOpen: true, activeSurfaceId: 'files', surfaces: [FILES] })
    toggleWorkspaceSurface('ws-a', 'files') // active kind → hide
    expect(getWorkspacePanel('ws-a').isOpen).toBe(false)
    toggleWorkspaceSurface('ws-a', 'files') // hidden → re-open
    expect(getWorkspacePanel('ws-a').isOpen).toBe(true)
  })
})

// #193 review SHOULD-FIX: the delete-cascade for a removed Workspace (t3code removeThread
// parity) — workspaceIds are fresh UUIDs, so without this a removed Workspace's entry
// would sit unreachable in localStorage forever.
describe('removeWorkspacePanel', () => {
  afterEach(() => _resetSidePanelStore(null))

  it('drops the Workspace entry entirely, including from persistence', () => {
    const storage = fakeStorage()
    _resetSidePanelStore(storage)
    openWorkspaceSurface('ws-gone', 'review')
    openWorkspaceSurface('ws-kept', 'files')
    removeWorkspacePanel('ws-gone')
    expect(getWorkspacePanel('ws-gone')).toBe(EMPTY_PANEL_STATE)
    expect(getWorkspacePanel('ws-kept').activeSurfaceId).toBe('files')
    expect(storage.store.get(SIDE_PANEL_STORAGE_KEY)).not.toContain('ws-gone')
    expect(storage.store.get(SIDE_PANEL_STORAGE_KEY)).toContain('ws-kept')
  })

  it('is a no-op for an unknown Workspace (no write, no notify)', () => {
    _resetSidePanelStore(null)
    expect(() => removeWorkspacePanel('never-seen')).not.toThrow()
    expect(getWorkspacePanel('never-seen')).toBe(EMPTY_PANEL_STATE)
  })
})
