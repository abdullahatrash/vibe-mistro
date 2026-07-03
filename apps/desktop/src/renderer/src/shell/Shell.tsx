import { useEffect, useRef, useState, type JSX, type PointerEvent, type ReactNode } from 'react'
import { ChevronDown, Search, Settings, Sparkles, SquarePen } from 'lucide-react'
import type { ListMetadataResult } from '../../../shared/ipc'
import type { NavState } from './nav-reducer'
import type { UnifiedThreadRow } from './unified-threads'
import { WorkspaceNav, type ThreadRowActions, type WorkspaceFlags } from './workspace-nav'
import { UpdateReadyChip } from './UpdateReadyChip'
import {
  clampSidebarWidth,
  DEFAULT_SIDEBAR_WIDTH,
  getSidebarWidth,
  setSidebarWidth,
} from './sidebar-width-store'
import { cn } from '../lib/utils'
import { planLabel } from '../auth/plan-label'
import { useAccountPlan } from '../auth/use-account-plan'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../ui/menu'
import { NavItem } from '../ui/nav-item'

export type { WorkspaceFlags } from './workspace-nav'

/**
 * The persistent two-pane app shell (ADR-0006 decision 1): a left sidebar that
 * stays mounted and a right conversation OUTLET whose content swaps. Navigation
 * (the pure nav reducer, decision 2) and the per-Workspace connection registry
 * (decision 3) live in App; Shell is the presentational layout — now restyled onto
 * the design-system tokens + primitives (#113): a warm `--sidebar` surface, a primary
 * nav (New chat + Search; the logo + wordmark live in App's window-chrome header),
 * a collapsible Projects list (= Workspaces, the {@link WorkspaceNav} subtree) with
 * thread rows + relative timestamps + a "Show more" cap, and a placeholder account chip.
 * Behavior is unchanged: the same selection/New-thread/delete handlers, the same
 * live/streaming/needs-attention indicators, the same empty states — only the JSX +
 * styling moved.
 *
 * The per-Thread-row handlers are bundled into ONE {@link ThreadRowActions} `actions`
 * prop threaded explicitly to `WorkspaceNav`; the layout, resize, and top-level nav
 * sections stay here.
 */
export function Shell({
  collapsed,
  workspaces,
  nav,
  workspaceFlags,
  rows,
  protectedThreadId,
  outlet,
  opening,
  onOpenProject,
  onNewThread,
  actions,
  onOpenSettings,
  onOpenSearch,
  onOpenSkills,
}: {
  /** Whether the left sidebar is collapsed (#127) — animate its width to 0 (still mounted). */
  collapsed: boolean
  /** Persisted Workspaces (cold metadata) for the switcher rows + display names. */
  workspaces: ListMetadataResult
  /** The current navigation selection (controlled by App). */
  nav: NavState
  /** Per-Workspace rolled-up live status, keyed by Workspace id (switcher badges). */
  workspaceFlags: Readonly<Record<string, WorkspaceFlags>>
  /** The unified rows (cold + live) for the SELECTED Workspace. */
  rows: UnifiedThreadRow[]
  /** The connection's primary Thread (never deletable mid-connection), or null. */
  protectedThreadId: string | null
  /** The fully-computed conversation outlet (connection views / cold replay). */
  outlet: ReactNode
  /** Whether an Open-project connect is in flight — busies the header's new-project +. */
  opening: boolean
  /** Open a project via the OS dialog (the existing `openProject`), from the Projects header +. */
  onOpenProject: () => void
  /** Mint a New-thread draft on the selected Workspace's live agent. */
  onNewThread: () => void
  /** The bundled per-Thread-row actions (select / new / delete / remove / flags / rename). */
  actions: ThreadRowActions
  /** Open the routed Settings page (#130) — from the account chip's menu. */
  onOpenSettings: () => void
  /** Open the Search palette (#174) — from the primary nav's Search row (or ⌘K). */
  onOpenSearch: () => void
  /** Open the Skills browser (#259) — from the primary nav's Skills row. */
  onOpenSkills: () => void
}): JSX.Element {
  // The sidebar's EXPANDED width (#drag-to-resize): renderer-only UI state, seeded from
  // localStorage (clamped) and persisted on drag-release. `dragging` disables the
  // collapse width-transition so the aside tracks the pointer 1:1 with no lag, and
  // suppresses text selection while the pointer is captured.
  const [width, setWidth] = useState(() => getSidebarWidth(window.localStorage))
  const [dragging, setDragging] = useState(false)
  // The drag origin, captured on pointer-down so the move handler reads no stale state.
  const dragOrigin = useRef({ startX: 0, startWidth: DEFAULT_SIDEBAR_WIDTH })

  function onHandlePointerDown(e: PointerEvent<HTMLDivElement>): void {
    e.preventDefault()
    dragOrigin.current = { startX: e.clientX, startWidth: width }
    setDragging(true)
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onHandlePointerMove(e: PointerEvent<HTMLDivElement>): void {
    if (!dragging) return
    const { startX, startWidth } = dragOrigin.current
    setWidth(clampSidebarWidth(startWidth + (e.clientX - startX)))
  }
  function endDrag(e: PointerEvent<HTMLDivElement>): void {
    if (!dragging) return
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
    // Persist the settled EXPANDED width (best-effort). Read from state via the setter to
    // avoid a stale closure — setWidth's identity update returns the current value.
    setWidth((current) => {
      setSidebarWidth(window.localStorage, current)
      return current
    })
  }
  function resetWidth(): void {
    setWidth(DEFAULT_SIDEBAR_WIDTH)
    setSidebarWidth(window.localStorage, DEFAULT_SIDEBAR_WIDTH)
  }
  // Collapsing unmounts the handle, so a drag in flight would never get its pointerup
  // (→ `dragging` stuck true: stuck `select-none`, suppressed transition, and — worst —
  // the re-expanded handle resizing on mere hover off a stale origin). Clear it on collapse.
  useEffect(() => {
    if (collapsed) setDragging(false)
  }, [collapsed])

  return (
    <div className={cn('flex min-h-0 flex-1', dragging && 'select-none')}>
      {/* The sidebar stays MOUNTED when collapsed (#127) — its state (open projects,
          scroll, the #138 fold list) survives, so re-expanding is instant. The OUTER
          <aside> animates only its width (0 ↔ the resized width) and clips
          (`overflow-hidden`); the INNER holds a FIXED (resized) width so the content
          SLIDES under the clip cleanly instead of squishing as the container shrinks.
          `aria-hidden`/`inert` take the now-hidden controls out of the tab order + a11y
          tree while collapsed. The <main> outlet is `flex-1`, so it reclaims the freed
          space automatically. The width is inline (dynamic #drag-to-resize); the
          transition is disabled WHILE DRAGGING so the aside tracks the pointer with no
          lag, but kept for the collapse animation. */}
      <aside
        aria-hidden={collapsed || undefined}
        inert={collapsed || undefined}
        style={{ width: collapsed ? 0 : width }}
        className={cn(
          'flex flex-none overflow-hidden border-border bg-sidebar transition-[width] duration-200',
          collapsed ? 'border-r-0' : 'border-r',
          dragging && 'transition-none',
        )}
      >
        {/* Three-band sidebar: a PINNED top (primary nav — the logo + wordmark moved
            to the window-chrome header, user call 2026-07-03) and a PINNED bottom
            (account) sandwich the ONLY scroll region — the Projects list — so the nav
            and account stay put while just the projects scroll. The INNER holds the
            resized width (not shrinking) so content slides under the clip on collapse. */}
        <div className="flex h-full flex-none flex-col gap-3 p-3" style={{ width }}>
          <div className="flex flex-none flex-col gap-3">
            <PrimaryNav
              busy={opening}
              onNewThread={onNewThread}
              onOpenSearch={onOpenSearch}
              onOpenSkills={onOpenSkills}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspaceNav
              workspaces={workspaces}
              nav={nav}
              workspaceFlags={workspaceFlags}
              rows={rows}
              protectedThreadId={protectedThreadId}
              opening={opening}
              onOpenProject={onOpenProject}
              actions={actions}
            />
          </div>
          <UpdateReadyChip />
          <AccountChip onOpenSettings={onOpenSettings} />
        </div>
      </aside>

      {/* Resize handle (#drag-to-resize): a SIBLING of the <aside> (so it lives OUTSIDE
          the aside's `overflow-hidden`/collapse clip) rendered only when expanded — a
          collapsed sidebar can't be resized. A 0-width relative wrapper on the border
          carries a WIDER (8px) invisible hit strip (`absolute -left-1 w-2`) with a thin
          visible line on hover/drag, so the grab target is forgiving but the affordance
          is a 1px seam. Pointer-capture keeps the drag tracking outside the strip and
          auto-cleans (no leaked window listener). Double-click resets to the default. */}
      {!collapsed && (
        <div className="relative z-10 w-0 flex-none">
          <div
            aria-hidden
            onPointerDown={onHandlePointerDown}
            onPointerMove={onHandlePointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={resetWidth}
            className={cn(
              'absolute -left-1 top-0 h-full w-2 cursor-col-resize [-webkit-app-region:no-drag]',
              'after:absolute after:inset-y-0 after:left-1 after:w-px after:bg-transparent after:transition-colors after:content-[""] hover:after:bg-accent/40',
              dragging && 'after:bg-accent/60',
            )}
          />
        </div>
      )}

      {/* Full-bleed (t3code): the side panel must reach the window edges, so the
          padding lives in each outlet view (the chat column / the p-6 wrappers in
          App's outlet), not here. */}
      <main className="min-w-0 flex-1 overflow-y-auto">{outlet}</main>
    </div>
  )
}

/**
 * The primary nav: the peach-tinted "New chat" pill (the ONE filled tint,
 * `--accent-fill`). It's ALWAYS actionable now — `onNewThread` (App's `startNewChat`)
 * targets the selected/most-recent project (connect-if-needed) or opens the picker when
 * there are none — so it's only disabled while a connect is in flight (`busy`). Below it,
 * Search opens the Search palette (#174; also ⌘K); Skills opens the Skills browser
 * (#259, the slot Plugins vacated). The old Scheduled / Plugins "Soon" placeholders
 * are HIDDEN for v1 (user call, 2026-07-03): their epics (#175 / #176) stay parked
 * as backlog, and unbuilt rows shouldn't greet first-version users.
 */
function PrimaryNav({
  busy,
  onNewThread,
  onOpenSearch,
  onOpenSkills,
}: {
  busy: boolean
  onNewThread: () => void
  onOpenSearch: () => void
  onOpenSkills: () => void
}): JSX.Element {
  return (
    <nav className="flex flex-col gap-0.5">
      <button
        type="button"
        onClick={onNewThread}
        disabled={busy}
        className="flex w-full items-center gap-2.5 rounded-lg bg-[var(--accent-fill)] px-3 py-2 text-left text-[14px] font-semibold text-accent-text outline-none transition-[filter] hover:brightness-[0.98] disabled:pointer-events-none disabled:opacity-50"
      >
        <SquarePen className="size-[18px]" aria-hidden />
        New chat
      </button>
      <NavItem onClick={onOpenSearch}>
        <Search className="size-[18px]" aria-hidden />
        <span className="flex-1">Search</span>
        <span className="text-[11px] font-medium text-faint">⌘K</span>
      </NavItem>
      <NavItem onClick={onOpenSkills}>
        <Sparkles className="size-[18px]" aria-hidden />
        <span className="flex-1">Skills</span>
      </NavItem>
    </nav>
  )
}

/**
 * The account chip pinned to the sidebar's bottom — a gradient avatar + a name + a
 * tier, the TRIGGER of an account dropdown (#130). The tier line is LIVE: the plan
 * from console whoami (ADR-0003 amendment), rendered as "Mistral Vibe · <plan>" when
 * known. The name stays a static placeholder — plan is the CEILING of account
 * identity Vibe exposes (no email/name anywhere in its surfaces), so a real name
 * can never render here. The menu holds a real "Settings" item (→ the routed
 * Settings page that now hosts the env/CLI status the sidebar gear used to toggle)
 * plus room for future account actions.
 */
function AccountChip({ onOpenSettings }: { onOpenSettings: () => void }): JSX.Element {
  const plan = planLabel(useAccountPlan())
  return (
    <Menu>
      <MenuTrigger className="flex items-center gap-2.5 rounded-[9px] px-2 py-2 text-left outline-none transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 data-[popup-open]:bg-accent/10">
        {/* static avatar/name — Vibe exposes no identity to fill them with (ADR-0003). */}
        <span
          aria-hidden
          className="flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold text-white"
          style={{ backgroundImage: 'var(--accent-grad-avatar)' }}
        >
          V
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[14px] font-semibold text-text-strong">Your account</span>
          <span className="truncate text-[12px] text-faint">
            {plan ? `Mistral Vibe · ${plan}` : 'Mistral Vibe'}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-muted" aria-hidden />
      </MenuTrigger>
      <MenuContent align="start" className="min-w-[200px]">
        <MenuItem onClick={onOpenSettings}>
          <Settings className="size-3.5" aria-hidden />
          Settings
        </MenuItem>
        {/* room for future account actions (sign-out shortcut, plan upgrade) — #future. */}
      </MenuContent>
    </Menu>
  )
}
