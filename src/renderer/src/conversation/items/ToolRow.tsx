import { useState, type JSX, type KeyboardEvent } from 'react'
import {
  Brain,
  Check,
  ChevronDown,
  Circle,
  Eye,
  Globe,
  Loader2,
  Move,
  Search,
  SquarePen,
  Terminal,
  Trash2,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '../../lib/utils'
import { describeToolStatus, type ToolStatusGlyph as ToolStatusGlyphName } from '../tool-status'
import { toolKindIcon, type ToolIconName } from '../tool-icon'
import { toolDetail, toolPreview } from '../tool-detail'
import type { ToolItem } from '../reducer'

/** The leading tone-icon lookup: resolved tool-kind name (pure `tool-icon.ts`) → lucide. */
const TOOL_KIND_ICONS: Record<ToolIconName, LucideIcon> = {
  eye: Eye,
  'square-pen': SquarePen,
  terminal: Terminal,
  globe: Globe,
  brain: Brain,
  trash: Trash2,
  move: Move,
  search: Search,
  wrench: Wrench,
}

/** Map a resolved tool-kind icon name (pure `tool-icon.ts`) to a lucide element. */
function ToolKindIcon({ name, className }: { name: ToolIconName; className?: string }): JSX.Element {
  const Icon = TOOL_KIND_ICONS[name]
  return <Icon className={className} aria-hidden />
}

/** The right-hand status glyph lookup (pure `tool-status.ts` → lucide): a spinner while
 *  live, a muted check when completed, a destructive X on failure, a neutral static dot
 *  when a non-terminal status settled after the turn ended (#164). */
const TOOL_STATUS_GLYPHS: Record<ToolStatusGlyphName, { icon: LucideIcon; className: string }> = {
  check: { icon: Check, className: 'size-4 text-muted' },
  x: { icon: X, className: 'size-4 text-bad' },
  spinner: { icon: Loader2, className: 'size-4 animate-spin text-muted' },
  dot: { icon: Circle, className: 'size-2 fill-muted text-muted opacity-60' },
}

function ToolStatusGlyph({ glyph }: { glyph: ToolStatusGlyphName }): JSX.Element {
  const { icon: Icon, className } = TOOL_STATUS_GLYPHS[glyph]
  return <Icon className={className} aria-hidden />
}

export function ToolRow({ item, streaming }: { item: ToolItem; streaming: boolean }): JSX.Element {
  // Tool call (#115, adapted from t3code SimpleWorkEntryRow): a compact row —
  // leading tone-icon (kind→lucide) + heading + dimmed preview + a rotating chevron
  // (only when there's detail) + a right status glyph (ACP status→display). Clicking
  // an expandable row toggles an indented `<pre>` of the raw input/output/content.
  // `streaming` (#164) settles a non-terminal status to a static dot once this
  // Thread's turn ends, so a missing terminal `tool_call_update` doesn't spin forever.
  const [expanded, setExpanded] = useState(false)
  const status = describeToolStatus(item.status, streaming)
  const heading = item.title ?? item.toolKind ?? 'tool'
  const preview = toolPreview(item, heading)
  const detail = toolDetail(item)
  const canExpand = detail !== null

  const toggleProps = canExpand
    ? {
        role: 'button' as const,
        tabIndex: 0,
        'aria-expanded': expanded,
        onClick: () => setExpanded((v) => !v),
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setExpanded((v) => !v)
          }
        },
      }
    : {}

  return (
    <div
      className={cn(
        'flex flex-col rounded-md px-0.5 py-0.5 transition-colors',
        canExpand && 'cursor-pointer hover:bg-accent/10 focus-visible:bg-accent/10 outline-none',
      )}
      {...toggleProps}
    >
      <div className="flex items-center gap-1.5 select-none">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted">
          <ToolKindIcon name={toolKindIcon(item.toolKind)} className="size-3.5 shrink-0 stroke-[1.8]" />
        </span>
        <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px] leading-5">
          <span className="min-w-0 shrink truncate font-medium text-text-body">{heading}</span>
          {preview && <span className="min-w-0 flex-1 truncate text-muted">{preview}</span>}
        </p>
        <span className="flex shrink-0 items-center gap-px">
          {canExpand && (
            <ChevronDown
              className={cn(
                'size-3.5 shrink-0 text-muted opacity-70 transition-transform duration-200',
                expanded && 'rotate-180',
              )}
              aria-hidden
            />
          )}
          <span className="flex size-4 shrink-0 items-center justify-center">
            <ToolStatusGlyph glyph={status.glyph} />
          </span>
        </span>
      </div>
      {expanded && detail && (
        <pre
          className="mt-1 ms-7 max-h-64 cursor-default overflow-auto border-s border-border ps-3 font-mono text-[11px] whitespace-pre-wrap"
          onClick={(e) => e.stopPropagation()}
        >
          {detail}
        </pre>
      )}
    </div>
  )
}
