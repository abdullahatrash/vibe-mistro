import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent, type ReactNode } from 'react'
import { FileDiff, FileText, Files, Globe, MessageSquare, Plus, SquareTerminal, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useMediaQuery } from '../lib/use-media-query'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Sheet,
  SheetPopup,
} from '../ui'
import { ChangesPanel } from '../git/ChangesPanel'
import { FilesSurface } from './FilesSurface'
import { FilePreview } from './FilePreview'
import { TerminalSurface } from './TerminalSurface'
import { BrowserSurface } from './BrowserSurface'
import { surfaceForChord } from './surface-keys'
import { basename } from '../lib/paths'
import { clearComposerDraft } from '../conversation/composer-draft-store'
import type { ThreadStatusMap } from '../conversation/thread-status'
import { Badge } from '../ui/badge'
import { LogoSnakeSpinner } from '../shell/logo-snake-spinner'
import {
  activateWorkspaceSurface,
  closeAllWorkspaceSurfaces,
  closeOtherWorkspaceSurfaces,
  closeWorkspacePanel,
  closeWorkspaceSurface,
  closeWorkspaceSurfacesToRight,
  MAX_TERMINALS_PER_WORKSPACE,
  openWorkspaceBrowserSurface,
  openWorkspaceFileSurface,
  openWorkspaceSurface,
  openWorkspaceTerminalSurface,
  setWorkspaceBrowserSurfaceUrl,
  toggleWorkspaceBrowserSurface,
  terminalSurfaceCount,
  toggleWorkspaceSurface,
  toggleWorkspaceTerminalSurface,
  useWorkspacePanel,
  type SingletonKind,
  type SideThreadLifecycle,
  type Surface,
} from './side-panel-store'
import {
  clampPanelWidth,
  DEFAULT_PANEL_WIDTH,
  getPanelWidth,
  setPanelWidth,
} from './panel-width-store'
import { unpromptedSideThreadIds } from './side-thread-surface-cleanup'
import { surfaceThreadStatus } from './surface-thread-status'

/** Windows this narrow present the panel as a slide-over Sheet (t3code's 980px break). */
const NARROW_QUERY = '(max-width: 980px)'

/**
 * The right-hand side panel as a t3code Sheet/tab surface stack (#193, ADR-0013 decision 1;
 * CONTEXT.md "Surface" / "Side panel"). Per-Workspace state (open flag + ordered Surfaces +
 * active id) lives in the shared `side-panel-store`; this component renders it and drives
 * ⌘P/⌃⇧G. Open Surfaces show as a TAB STRIP; with zero open, the panel shows the launcher
 * CARDS (its empty state). Review re-homes the git Changes panel behavior-identical
 * (#84–#88, ADR-0008); Files is the searchable tree (#188); Terminal is the Workspace
 * shell (ADR-0014); Browser is the embedded dev-server preview (#216, ADR-0015).
 *
 * Presentation is DUAL: inline beside the conversation on wide windows — a full-height,
 * flush, `border-l`-separated column (t3code's editor-panel chrome) whose width is
 * DRAG-RESIZABLE on its left edge (`panel-width-store`: default 540, min 360, max 70% of
 * the viewport, persisted per-window) — and inside a Sheet (right-edge slide-over, dimmed/
 * blurred backdrop, Esc/outside-click closes) on narrow ones; the SAME `PanelBody` feeds
 * both. Rendered by `ConnectedWorkspace` for the active/connected Workspace only. Stays
 * MOUNTED even while closed so the ⌘P/⌃⇧G listener stays live (a matched chord toggles
 * the Surface, opening a closed panel).
 */
export function SurfacePanel({
  workspaceId,
  workspaceDir,
  agentId,
  activeThreadId,
  renderSideThread,
  getSideThreadTitle,
  threadStatuses,
  isActive,
  busy,
}: {
  workspaceId: string
  workspaceDir: string
  /** The warm agent handle — Files addresses `files:list`/`files:read` by this (confinement, #188 F3). */
  agentId: string
  /** The live Thread whose composer a file preview's Insert-@path targets (#189); null when none. */
  activeThreadId: string | null
  /** Render a Side Thread conversation without changing the primary Thread selection. */
  renderSideThread: (threadId: string, lifecycle: SideThreadLifecycle) => ReactNode
  /** Resolve a bound Side Thread's latest Vibe-generated title for its tab. */
  getSideThreadTitle: (threadId: string) => string | null
  /** Main-authored status for every live Thread, including unmounted Side Threads. */
  threadStatuses: ThreadStatusMap
  /** Whether this is the on-screen Workspace (#84) — gates git streaming AND shortcuts. */
  isActive: boolean
  /** Whether a turn is streaming (#86) — threaded to the Review panel's commit guard. */
  busy: boolean
}): JSX.Element | null {
  const panel = useWorkspacePanel(workspaceId)
  const narrow = useMediaQuery(NARROW_QUERY)

  // Renderer-level shortcuts (NO Electron accelerators): ⌘P for Files, ⌃⇧G for Review.
  // Gated on `isActive` so a backgrounded (mounted-hidden) Workspace never grabs keys;
  // live even while the panel is CLOSED (this component stays mounted). The store's pure
  // `toggleSurface` op resolves the closed-panel / active-tab / other-tab cases. Both
  // chords carry a modifier, so a focused textarea is intentionally NOT exempt (⌘P must
  // open Files while composing). We preventDefault the match to stop the ⌘P print dialog.
  useEffect(() => {
    if (!isActive) return
    function onKeyDown(e: KeyboardEvent): void {
      const kind = surfaceForChord(e)
      if (!kind) return
      e.preventDefault()
      // Browser and terminal are singleton-ish but not `SingletonKind`s (their
      // descriptors carry a resourceId), so each has its own toggle op; the rest
      // share `toggleSurface`.
      if (kind === 'browser') toggleWorkspaceBrowserSurface(workspaceId)
      else if (kind === 'terminal') toggleWorkspaceTerminalSurface(workspaceId)
      else toggleWorkspaceSurface(workspaceId, kind)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isActive, workspaceId])

  // A BACKGROUND Workspace renders nothing (#193 review MUST-FIX): App keeps it mounted
  // inside a `hidden` wrapper, but base-ui's Dialog PORTALS to document.body — a
  // backgrounded Workspace's left-open Sheet would escape the wrapper and paint a modal
  // backdrop over the active Workspace (stacking per background Workspace). The keydown
  // effect above already no-ops when inactive, so returning null here only drops DOM —
  // the per-Workspace panel STATE survives in the store for its next activation. (Also
  // skips mounting a hidden inline PanelBody — needless DOM.) AFTER the hooks: hook order.
  if (!isActive) return null

  // Content mounts ONLY while open: this keeps the Review Surface's git subscription
  // (gated on `isActive` inside ChangesPanel) from running behind a closed panel, so the
  // git behaviour stays frozen (#84/ADR-0008). A closed wide panel renders nothing; a
  // closed narrow Sheet renders its empty shell.
  const body = panel.isOpen ? (
    <PanelBody
      mode={narrow ? 'sheet' : 'inline'}
      workspaceId={workspaceId}
      workspaceDir={workspaceDir}
      agentId={agentId}
      activeThreadId={activeThreadId}
      renderSideThread={renderSideThread}
      getSideThreadTitle={getSideThreadTitle}
      threadStatuses={threadStatuses}
      isActive={isActive}
      busy={busy}
      panel={panel}
    />
  ) : null

  if (narrow) {
    return (
      <Sheet
        open={panel.isOpen}
        onOpenChange={(open) => {
          if (!open) closeWorkspacePanel(workspaceId)
        }}
      >
        <SheetPopup keepMounted aria-label="Side panel">
          {body}
        </SheetPopup>
      </Sheet>
    )
  }

  return body
}

/**
 * The panel's content, shared across both presentations: the full-height SHELL (t3code's
 * `PreviewPanelShell`) holding either the tab strip + active Surface (≥1 Surface open) or
 * the centered launcher grid (zero open). Inline, the shell is a flush `border-l` column
 * at the drag-resizable width (left-edge handle: pointer-captured drag, clamp to the
 * viewport-relative range, persist on release, double-click resets — the sidebar's
 * #drag-to-resize pattern mirrored). In a Sheet the popup owns width + chrome, so the
 * shell just fills it (no handle, no border).
 */
function PanelBody({
  mode,
  workspaceId,
  workspaceDir,
  agentId,
  activeThreadId,
  renderSideThread,
  getSideThreadTitle,
  threadStatuses,
  isActive,
  busy,
  panel,
}: {
  mode: 'inline' | 'sheet'
  workspaceId: string
  workspaceDir: string
  agentId: string
  activeThreadId: string | null
  renderSideThread: (threadId: string, lifecycle: SideThreadLifecycle) => ReactNode
  getSideThreadTitle: (threadId: string) => string | null
  threadStatuses: ThreadStatusMap
  isActive: boolean
  busy: boolean
  panel: ReturnType<typeof useWorkspacePanel>
}): JSX.Element {
  const inline = mode === 'inline'
  const [width, setWidth] = useState(() => getPanelWidth(window.localStorage, window.innerWidth))
  const [dragging, setDragging] = useState(false)
  const dragOrigin = useRef<{ x: number; width: number } | null>(null)

  function onHandlePointerDown(e: PointerEvent<HTMLDivElement>): void {
    dragOrigin.current = { x: e.clientX, width }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onHandlePointerMove(e: PointerEvent<HTMLDivElement>): void {
    const origin = dragOrigin.current
    if (!origin) return
    // The handle rides the panel's LEFT edge: dragging left (negative clientX delta)
    // grows the panel. Clamped live so the drag can never overshoot the range.
    setWidth(clampPanelWidth(origin.width + (origin.x - e.clientX), window.innerWidth))
  }
  function endDrag(e: PointerEvent<HTMLDivElement>): void {
    if (!dragOrigin.current) return
    dragOrigin.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // Persist the settled width (best-effort). Read from state via the setter to avoid
    // a stale closure — setWidth's identity update returns the current value.
    setWidth((current) => {
      setPanelWidth(window.localStorage, current, window.innerWidth)
      return current
    })
  }
  function resetWidth(): void {
    const fallback = clampPanelWidth(DEFAULT_PANEL_WIDTH, window.innerWidth)
    setWidth(fallback)
    setPanelWidth(window.localStorage, fallback, window.innerWidth)
  }

  const active = panel.surfaces.find((s) => s.id === panel.activeSurfaceId) ?? null
  // The singleton browser tab (if open) — rendered persistently (see below) rather
  // than only when active, so its live <webview> survives tab switches.
  const browserSurface = panel.surfaces.find((s) => s.kind === 'browser') ?? null
  // Stable so BrowserSurface's event-listener effect doesn't re-subscribe each render.
  const persistBrowserUrl = useCallback(
    (url: string) => setWorkspaceBrowserSurfaceUrl(workspaceId, url),
    [workspaceId],
  )

  // A close op is a VIEW op except for resource-owning renderer-only Surfaces:
  // terminal tabs own PTYs, and unprompted Side Threads own composer Draft state.
  // Every explicit close path cleans those resources before removing descriptors.
  function cleanUpRemovedSurfaces(removed: Surface[]): void {
    for (const surface of removed) {
      if (surface.kind === 'terminal') {
        void window.api.terminalClose({ workspaceId, terminalId: surface.resourceId })
      }
    }
    for (const threadId of unpromptedSideThreadIds(removed)) clearComposerDraft(threadId)
  }
  function closeSurfaceAndCleanUp(id: string): void {
    cleanUpRemovedSurfaces(panel.surfaces.filter((surface) => surface.id === id))
    closeWorkspaceSurface(workspaceId, id)
  }
  function closeOthersAndCleanUp(id: string): void {
    cleanUpRemovedSurfaces(panel.surfaces.filter((surface) => surface.id !== id))
    closeOtherWorkspaceSurfaces(workspaceId, id)
  }
  function closeToRightAndCleanUp(id: string): void {
    const index = panel.surfaces.findIndex((surface) => surface.id === id)
    if (index >= 0) cleanUpRemovedSurfaces(panel.surfaces.slice(index + 1))
    closeWorkspaceSurfacesToRight(workspaceId, id)
  }
  function closeAllAndCleanUp(): void {
    cleanUpRemovedSurfaces(panel.surfaces)
    closeAllWorkspaceSurfaces(workspaceId)
  }
  /** A launcher card / "+"-menu target: singletons via the store op, terminal/browser via their own. */
  function openCardTarget(target: CardDef['target']): void {
    if (target === 'terminal') openWorkspaceTerminalSurface(workspaceId)
    else if (target === 'browser') openWorkspaceBrowserSurface(workspaceId)
    else openWorkspaceSurface(workspaceId, target)
  }
  // At the per-Workspace terminal cap, the Terminal affordance disables (its store
  // op no-ops anyway — this keeps the button from reading as broken).
  const terminalAtCap = terminalSurfaceCount(panel) >= MAX_TERMINALS_PER_WORKSPACE

  return (
    <aside
      aria-label="Side panel"
      style={inline ? { width } : undefined}
      className={cn(
        'relative flex h-full min-h-0 flex-col bg-panel text-text',
        inline ? 'shrink-0 self-stretch border-l border-border' : 'w-full',
        dragging && 'select-none',
      )}
    >
      {/* Resize handle (inline only): an 8px invisible hit strip straddling the left
          border, its visible affordance a 1px seam that lights on hover/drag. */}
      {inline && (
        <div
          aria-hidden
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={resetWidth}
          className={cn(
            'absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize select-none [-webkit-app-region:no-drag]',
            'after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:transition-colors after:content-[""] hover:after:bg-accent/40',
            dragging && 'after:bg-accent/60',
          )}
        />
      )}
      {panel.surfaces.length === 0 ? (
        <LauncherGrid onOpen={openCardTarget} terminalAtCap={terminalAtCap} />
      ) : (
        <>
          <SurfaceTabStrip
            surfaces={panel.surfaces}
            activeSurfaceId={panel.activeSurfaceId}
            getSideThreadTitle={getSideThreadTitle}
            threadStatuses={threadStatuses}
            onActivate={(id) => activateWorkspaceSurface(workspaceId, id)}
            onClose={closeSurfaceAndCleanUp}
            onCloseOthers={closeOthersAndCleanUp}
            onCloseToRight={closeToRightAndCleanUp}
            onCloseAll={closeAllAndCleanUp}
            onOpen={openCardTarget}
            terminalAtCap={terminalAtCap}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {active?.kind === 'review' && (
              <ChangesPanel
                workspaceDir={workspaceDir}
                isActive={isActive}
                busy={busy}
                onCollapse={() => closeWorkspaceSurface(workspaceId, 'review')}
                activeThreadId={activeThreadId}
              />
            )}
            {active?.kind === 'files' && (
              // The Files Surface tree (#188). It only mounts here — when `files` is the ACTIVE
              // tab and the panel is open — and focuses its own search on mount, so ⌘P (which
              // opens/activates Files via the store) and a Files card/tab click both land in a
              // search-focused tree (ADR-0013 decision 1), with no per-trigger plumbing.
              // Selecting a file opens a panel-level `file:` Surface (a preview tab) via the
              // store — dedupes on the path, so re-selecting an open file just re-activates it.
              <FilesSurface
                onCollapse={() => closeWorkspaceSurface(workspaceId, 'files')}
                agentId={agentId}
                onOpenFile={(relativePath) => openWorkspaceFileSurface(workspaceId, relativePath)}
              />
            )}
            {active?.kind === 'terminal' && (
              // The Workspace's shell (ADR-0014). Keyed by the surface id so each
              // `term-N` tab remounts its OWN view/session; the SESSION lives in main —
              // this view detaching (tab switch) leaves the shell running.
              <TerminalSurface
                key={active.id}
                workspaceId={workspaceId}
                terminalId={active.resourceId}
                agentId={agentId}
                activeThreadId={activeThreadId}
              />
            )}
            {active?.kind === 'file' && (
              // A read-only file preview tab (#189): fetches the confined `files:read` and renders
              // the highlighted content (or a binary/too-large/error notice), keyed by the path so a
              // tab switch remounts a fresh fetch.
              <FilePreview
                key={active.id}
                agentId={agentId}
                relativePath={active.relativePath}
                activeThreadId={activeThreadId}
              />
            )}
            {active?.kind === 'thread' && renderSideThread(active.threadId, active.lifecycle)}
            {/* The embedded dev-server preview (#216, ADR-0015). Unlike the other
                surfaces it stays MOUNTED whenever its tab is open — only HIDDEN when
                another tab is active — because the live page lives in the renderer's
                <webview> (no main-side session to reattach, unlike Terminal), so
                unmounting on a tab switch would drop it back to the URL-entry state.
                Closing the tab removes it from `surfaces`, unmounting it (discarding
                the page). Keyed by id for a future multi-tab browser. */}
            {browserSurface && (
              <div className={cn('flex min-h-0 flex-1 flex-col', active?.kind !== 'browser' && 'hidden')}>
                <BrowserSurface
                  key={browserSurface.id}
                  workspaceDir={workspaceDir}
                  persistedUrl={browserSurface.url}
                  onUrlChange={persistBrowserUrl}
                  activeThreadId={activeThreadId}
                />
              </div>
            )}
          </div>
        </>
      )}
    </aside>
  )
}

/** A Surface's tab-strip presentation: its kind icon + a short human label. */
function surfaceMeta(
  surface: Surface,
  getSideThreadTitle: (threadId: string) => string | null,
): { icon: ReactNode; label: string } {
  switch (surface.kind) {
    case 'review':
      return { icon: <FileDiff aria-hidden />, label: 'Review' }
    case 'files':
      return { icon: <Files aria-hidden />, label: 'Files' }
    case 'file':
      return { icon: <FileText aria-hidden />, label: basename(surface.relativePath) }
    case 'terminal': {
      // Number the tabs from the `term-N` id so siblings disambiguate: the first
      // reads "Terminal", the rest "Terminal N".
      const n = Number(/^term-(\d+)$/.exec(surface.resourceId)?.[1] ?? '1')
      return { icon: <SquareTerminal aria-hidden />, label: n <= 1 ? 'Terminal' : `Terminal ${n}` }
    }
    case 'browser':
      return { icon: <Globe aria-hidden />, label: 'Browser' }
    case 'thread':
      return {
        icon: <MessageSquare aria-hidden />,
        label: getSideThreadTitle(surface.threadId) ?? 'Side Thread',
      }
  }
}

/**
 * The tab strip across the panel top (t3code `RightPanelTabs`): one tab per open Surface —
 * kind icon + label + a close ×, the active tab visually distinct. Clicking a tab activates
 * it; MIDDLE-click closes it (t3code's aux-click); right-click opens a context menu (Close /
 * Close others / Close to the right / Close all). A trailing "+" menu (t3code's add-surface
 * button) opens another Surface without going back through the launcher. A `tablist` /
 * `tab` a11y contract with `aria-selected` on the active tab.
 */
function SurfaceTabStrip({
  surfaces,
  activeSurfaceId,
  getSideThreadTitle,
  threadStatuses,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseAll,
  onOpen,
  terminalAtCap,
}: {
  surfaces: Surface[]
  activeSurfaceId: string | null
  getSideThreadTitle: (threadId: string) => string | null
  threadStatuses: ThreadStatusMap
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onCloseOthers: (id: string) => void
  onCloseToRight: (id: string) => void
  onCloseAll: () => void
  onOpen: (target: CardDef['target']) => void
  terminalAtCap: boolean
}): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Open surfaces"
      className="flex w-full shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-panel px-2 py-1.5"
    >
      {surfaces.map((surface, index) => {
        const active = surface.id === activeSurfaceId
        const { icon, label } = surfaceMeta(surface, getSideThreadTitle)
        const threadStatus = surfaceThreadStatus(surface, threadStatuses)
        return (
          <ContextMenu key={surface.id}>
            <ContextMenuTrigger
              onAuxClick={(e) => {
                // Middle-click closes the tab (t3code parity); right-click is the menu's.
                if (e.button === 1) onClose(surface.id)
              }}
              className={cn(
                'group flex h-7 min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-md pl-2 pr-1 text-[13px] transition-colors',
                '[&_svg]:size-3.5 [&_svg]:shrink-0',
                active
                  ? 'bg-accent/15 text-text-strong'
                  : 'text-muted hover:bg-accent/10 hover:text-text',
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onActivate(surface.id)}
                className="flex min-w-0 flex-1 items-center gap-1.5 outline-none"
              >
                {icon}
                <span className="min-w-0 flex-1 truncate text-left">{label}</span>
                {threadStatus?.streaming && <LogoSnakeSpinner size={14} label="Streaming" />}
                {threadStatus?.needsAttention && (
                  <Badge
                    variant="destructive"
                    aria-label="Needs attention"
                    title="Awaiting your response"
                    className="px-1.5"
                  >
                    !
                  </Badge>
                )}
              </button>
              <button
                type="button"
                onClick={() => onClose(surface.id)}
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                className={cn(
                  'flex size-4 shrink-0 items-center justify-center rounded outline-none hover:bg-accent/20',
                  active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                )}
              >
                <X className="size-3" aria-hidden />
              </button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onClick={() => onClose(surface.id)}>Close</ContextMenuItem>
              <ContextMenuItem onClick={() => onCloseOthers(surface.id)} disabled={surfaces.length <= 1}>
                Close others
              </ContextMenuItem>
              <ContextMenuItem
                onClick={() => onCloseToRight(surface.id)}
                disabled={index >= surfaces.length - 1}
              >
                Close to the right
              </ContextMenuItem>
              <ContextMenuItem onClick={onCloseAll}>Close all</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        )
      })}
      {/* Add-surface "+" (t3code): opens/activates a Surface directly from the strip.
          The store dedupes singletons, so picking an already-open kind just activates it. */}
      <Menu>
        <MenuTrigger
          aria-label="Open a surface"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10"
        >
          <Plus className="size-4" aria-hidden />
        </MenuTrigger>
        <MenuContent align="start">
          {CARDS.map((card) => {
            const enabled = cardEnabled(card, terminalAtCap)
            return (
            <MenuItem
              key={card.label}
              disabled={!enabled}
              onClick={enabled ? () => onOpen(card.target) : undefined}
            >
              <span className="flex items-center gap-2 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted">
                {card.icon}
                {card.label}
                {!card.live && <span className="text-[11px] font-medium text-faint">Soon</span>}
              </span>
            </MenuItem>
            )
          })}
        </MenuContent>
      </Menu>
    </div>
  )
}

/**
 * Whether a launcher card / menu item is actionable: a live card, unless it's the
 * Terminal at the per-Workspace session cap (where opening another would no-op).
 */
function cardEnabled(card: CardDef, terminalAtCap: boolean): boolean {
  return card.live && !(card.target === 'terminal' && terminalAtCap)
}

/** A launcher card's definition. Live cards open a Surface; inert ones are reserved. */
interface CardDef {
  /** The live Surface it opens, or a reserved slot with no Surface kind yet. */
  target: SingletonKind | 'terminal' | 'browser'
  label: string
  description: string
  icon: ReactNode
  /** The keyboard-shortcut hint (⌘T stays aspirational chrome until #217 wires it). */
  hint?: string
  live: boolean
}

const CARDS: readonly CardDef[] = [
  {
    target: 'review',
    label: 'Review',
    description: 'Inspect and commit working-tree changes.',
    icon: <FileDiff aria-hidden />,
    hint: '⌃⇧G',
    live: true,
  },
  {
    target: 'terminal',
    label: 'Terminal',
    description: 'Run commands in the Workspace.',
    icon: <SquareTerminal aria-hidden />,
    live: true,
  },
  {
    target: 'browser',
    label: 'Browser',
    description: 'Preview a local dev server.',
    icon: <Globe aria-hidden />,
    hint: '⌘T',
    live: true,
  },
  {
    target: 'files',
    label: 'Files',
    description: 'Browse and preview Workspace files.',
    icon: <Files aria-hidden />,
    hint: '⌘P',
    live: true,
  },
]

/**
 * The launcher EMPTY STATE (panel open, zero Surfaces) — t3code's `RightPanelEmptyState`:
 * a centered "Open a surface" heading over a 2-column grid of cards (leading icon, label +
 * shortcut hint, a short description). Live cards open their Surface; an inert card is
 * disabled + tagged "Soon" (the sidebar PlaceholderNav precedent) — all four are live now.
 * Opening one replaces the grid with the tab strip; closing the last tab returns here.
 */
function LauncherGrid({
  onOpen,
  terminalAtCap,
}: {
  onOpen: (target: CardDef['target']) => void
  terminalAtCap: boolean
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="w-full max-w-xl">
        <div className="mb-5 text-center">
          <h3 className="text-sm font-medium text-text-strong">Open a surface</h3>
          <p className="mt-1 text-xs text-muted">Choose what to show in the side panel.</p>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {CARDS.map((card) => (
            <LauncherCard
              key={card.label}
              card={card}
              onClick={cardEnabled(card, terminalAtCap) ? () => onOpen(card.target) : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One launcher card. A live card is a real button opening its Surface; an inert card is
 * disabled + `aria-disabled` with a muted "Soon" tag, so it reads as intentionally
 * reserved rather than broken. Shortcut hints render as small muted keycaps either way.
 */
function LauncherCard({ card, onClick }: { card: CardDef; onClick?: () => void }): JSX.Element {
  const inert = onClick === undefined
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={inert}
      aria-disabled={inert || undefined}
      title={inert ? 'Coming soon' : card.label}
      className={cn(
        'flex min-h-28 w-full flex-col items-start rounded-lg border border-border bg-surface p-4 text-left outline-none transition-colors',
        '[&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted',
        inert
          ? 'cursor-default opacity-50'
          : 'hover:bg-accent/10 focus-visible:bg-accent/10 [&_svg]:hover:text-text-strong',
      )}
    >
      <span className="mb-3">{card.icon}</span>
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">{card.label}</span>
        {card.hint && (
          <kbd className="shrink-0 rounded-md text-[11px] font-medium tabular-nums text-faint">{card.hint}</kbd>
        )}
        {inert && <span className="shrink-0 text-[11px] font-medium text-faint">Soon</span>}
      </span>
      <span className="mt-1 text-xs leading-relaxed text-muted">{card.description}</span>
    </button>
  )
}
