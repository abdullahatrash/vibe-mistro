import { useState, type JSX } from 'react'
import {
  Brain,
  Check,
  Circle,
  Eye,
  FileDiff,
  FilePenLine,
  FilePlus2,
  FileX2,
  FolderOpen,
  Globe,
  Loader2,
  Move,
  PanelRightOpen,
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
import { useRowStreaming, useTimelineHandlers } from '../timeline-context'
import {
  changeLinePreview,
  fileChangeHeading,
  fileChangeStats,
  fileChanges,
  type FileChange,
} from '../file-change'
import { basename } from '../../lib/paths'
import { FoldChevron, FoldableRow } from './foldable-row'
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

export function ToolRow({ item, index }: { item: ToolItem; index: number }): JSX.Element {
  const changes = fileChanges(item)
  return changes.length > 0 ? (
    <FileChangeToolRow item={item} index={index} changes={changes} />
  ) : (
    <GenericToolRow item={item} index={index} />
  )
}

function GenericToolRow({ item, index }: { item: ToolItem; index: number }): JSX.Element {
  // Tool call (#115, adapted from the reference implementation's work-entry row): a
  // compact row — leading tone-icon (kind→lucide) + heading + dimmed preview + a
  // rotating chevron (only when there's detail) + a right status glyph (ACP status→
  // display). Container-zone fold (#386): the whole row toggles an indented `<pre>`
  // of the raw input/output/content. `streaming` (#164, activity context) settles a
  // non-terminal status to a static dot once this Thread's turn ends, so a missing
  // terminal `tool_call_update` doesn't spin forever.
  const streaming = useRowStreaming(index)
  const [expanded, setExpanded] = useState(false)
  const status = describeToolStatus(item.status, streaming)
  const heading = item.title ?? item.toolKind ?? 'tool'
  const preview = toolPreview(item, heading)
  const detail = toolDetail(item)
  const canExpand = detail !== null

  return (
    <FoldableRow
      open={expanded}
      onOpenChange={setExpanded}
      canExpand={canExpand}
      toggleZone="container"
      className={cn(
        'flex flex-col rounded-md px-0.5 py-0.5 transition-colors',
        canExpand && 'cursor-pointer hover:bg-accent/10 focus-visible:bg-accent/10 outline-none',
      )}
      headerClassName="flex items-center gap-1.5 select-none"
      header={
        <>
          <span className="flex size-5 shrink-0 items-center justify-center text-muted">
            <ToolKindIcon name={toolKindIcon(item.toolKind)} className="size-3.5 shrink-0 stroke-[1.8]" />
          </span>
          <p className="flex min-w-0 flex-1 items-baseline gap-1.5 text-[13px] leading-5">
            <span className="min-w-0 shrink truncate font-medium text-text-body">{heading}</span>
            {preview && <span className="min-w-0 flex-1 truncate text-muted">{preview}</span>}
          </p>
          <span className="flex shrink-0 items-center gap-px">
            {canExpand && <FoldChevron open={expanded} className="text-muted" />}
            <span className="flex size-4 shrink-0 items-center justify-center">
              <ToolStatusGlyph glyph={status.glyph} />
            </span>
          </span>
        </>
      }
    >
      {detail && (
        <pre className="mt-1 ms-7 max-h-64 cursor-default overflow-auto border-s border-border ps-3 font-mono text-[11px] whitespace-pre-wrap">
          {detail}
        </pre>
      )}
    </FoldableRow>
  )
}

const FILE_CHANGE_ICONS = {
  created: FilePlus2,
  edited: FilePenLine,
  deleted: FileX2,
} satisfies Record<FileChange['kind'], LucideIcon>

const FILE_CHANGE_LABELS = {
  created: 'Created',
  edited: 'Edited',
  deleted: 'Deleted',
} satisfies Record<FileChange['kind'], string>

/**
 * Vibe's `edit` / `write_file` ACP calls carry real `{type:'diff'}` content. Render it as
 * a compact change ledger instead of hiding it in the generic raw-JSON disclosure: summary
 * and touched files stay visible, while the bounded replacement diff expands on demand.
 */
function FileChangeToolRow({
  item,
  index,
  changes,
}: {
  item: ToolItem
  index: number
  changes: FileChange[]
}): JSX.Element {
  const streaming = useRowStreaming(index)
  const { onOpenToolFile, onRevealToolFile } = useTimelineHandlers()
  const [expanded, setExpanded] = useState(false)
  const status = describeToolStatus(item.status, streaming)
  const stats = fileChangeStats(changes)
  const localActionsEnabled = status.state === 'done' || status.state === 'settled'
  const failureDetail = status.state === 'failed' ? toolDetail(item) : null

  return (
    <section
      data-file-change-card
      className="overflow-hidden rounded-lg border border-border bg-surface/80 shadow-[0_1px_0_rgba(24,20,16,0.03)]"
    >
      <div className="flex items-center gap-2 border-b border-border-muted bg-sidebar/55 px-2.5 py-2">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-bg text-accent-text">
          <FileDiff className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-semibold tracking-[0.01em] text-text-strong">{fileChangeHeading(changes)}</p>
          <p className="flex items-center gap-1.5 font-mono text-[10px] tabular-nums text-muted">
            {stats.additions > 0 ? <span className="text-ok">+{stats.additions}</span> : null}
            {stats.deletions > 0 ? <span className="text-bad">−{stats.deletions}</span> : null}
            {stats.additions === 0 && stats.deletions === 0 ? <span>No text changes</span> : null}
          </p>
        </div>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10"
        >
          {expanded ? 'Hide changes' : 'View changes'}
          <FoldChevron open={expanded} />
        </button>
        <span className="flex size-4 shrink-0 items-center justify-center">
          <ToolStatusGlyph glyph={status.glyph} />
        </span>
      </div>

      <div className="divide-y divide-border-muted">
        {changes.map((change, changeIndex) => (
          <FileChangeRow
            key={`${change.path}:${changeIndex}`}
            change={change}
            actionsEnabled={localActionsEnabled}
            onOpen={onOpenToolFile}
            onReveal={onRevealToolFile}
          />
        ))}
      </div>

      {expanded ? (
        <div className="border-t border-border bg-bg px-2.5 py-2.5">
          <div className="space-y-3">
            {changes.map((change, changeIndex) => (
              <FileChangePreview key={`${change.path}:preview:${changeIndex}`} change={change} />
            ))}
          </div>
          {failureDetail ? (
            <pre className="mt-2 max-h-32 overflow-auto rounded-md border border-[var(--bad-tint-border)] bg-[var(--bad-tint)] p-2 font-mono text-[10px] whitespace-pre-wrap text-bad">
              {failureDetail}
            </pre>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

function FileChangeRow({
  change,
  actionsEnabled,
  onOpen,
  onReveal,
}: {
  change: FileChange
  actionsEnabled: boolean
  onOpen: ((path: string) => void) | null
  onReveal: ((path: string) => void) | null
}): JSX.Element {
  const Icon = FILE_CHANGE_ICONS[change.kind]
  const label = FILE_CHANGE_LABELS[change.kind]
  // The existing reveal/read IPC paths require a live regular file; a completed delete
  // intentionally keeps its historical diff visible but has no local target to open.
  const canOpenLocalFile = actionsEnabled && change.kind !== 'deleted'
  const pathContent = (
    <>
      <Icon className="size-3.5 shrink-0 text-accent-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text" title={change.path}>
        {change.path}
      </span>
      <span
        className={cn(
          'shrink-0 rounded-sm px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.06em] uppercase',
          change.kind === 'created' && 'bg-ok/10 text-ok',
          change.kind === 'edited' && 'bg-[var(--accent-tint)] text-accent-text',
          change.kind === 'deleted' && 'bg-bad/10 text-bad',
        )}
      >
        {label}
      </span>
    </>
  )

  return (
    <div className="group flex min-w-0 items-center gap-1 px-2.5 py-1.5">
      {onOpen ? (
        <button
          type="button"
          disabled={!canOpenLocalFile}
          onClick={() => onOpen(change.path)}
          aria-label={`Open ${change.path}`}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left outline-none transition-colors hover:bg-accent/10 focus-visible:bg-accent/10 disabled:cursor-default disabled:opacity-65"
        >
          {pathContent}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-1">{pathContent}</div>
      )}
      {onOpen ? (
        <button
          type="button"
          disabled={!canOpenLocalFile}
          onClick={() => onOpen(change.path)}
          title="Open file preview"
          aria-label={`Open ${basename(change.path)} in file preview`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-60 outline-none transition-all hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10 focus-visible:opacity-100 disabled:opacity-25 group-hover:opacity-100"
        >
          <PanelRightOpen className="size-3.5" aria-hidden />
        </button>
      ) : null}
      {onReveal ? (
        <button
          type="button"
          disabled={!canOpenLocalFile}
          onClick={() => onReveal(change.path)}
          title="Reveal in Finder"
          aria-label={`Reveal ${basename(change.path)} in Finder`}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted opacity-60 outline-none transition-all hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10 focus-visible:opacity-100 disabled:opacity-25 group-hover:opacity-100"
        >
          <FolderOpen className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  )
}

function FileChangePreview({ change }: { change: FileChange }): JSX.Element {
  const oldPreview = changeLinePreview(change.oldText)
  const newPreview = changeLinePreview(change.newText)
  return (
    <div>
      <p className="mb-1.5 truncate font-mono text-[10px] font-medium text-muted" title={change.path}>
        {change.path}
      </p>
      <div className="max-h-72 overflow-auto rounded-md border border-border-muted bg-sidebar/35 font-mono text-[10.5px] leading-[1.55]">
        <ChangeLines marker="−" preview={oldPreview} tone="deletion" />
        <ChangeLines marker="+" preview={newPreview} tone="addition" />
        {oldPreview.lines.length === 0 && newPreview.lines.length === 0 ? (
          <p className="px-3 py-2 text-muted">No textual replacement to preview.</p>
        ) : null}
      </div>
    </div>
  )
}

function ChangeLines({
  marker,
  preview,
  tone,
}: {
  marker: '+' | '−'
  preview: ReturnType<typeof changeLinePreview>
  tone: 'addition' | 'deletion'
}): JSX.Element | null {
  if (preview.lines.length === 0) return null
  const addition = tone === 'addition'
  return (
    <div className={addition ? 'bg-ok/10' : 'bg-bad/10'}>
      {preview.lines.map((line, lineIndex) => (
        <div
          key={lineIndex}
          className={cn(
            'grid min-w-max grid-cols-[24px_1fr] border-b border-border-muted/60 last:border-b-0',
            addition ? 'text-text' : 'text-text-body',
          )}
        >
          <span className={cn('select-none px-1.5 text-center', addition ? 'text-ok' : 'text-bad')}>{marker}</span>
          <code className="pe-3 whitespace-pre">{line || ' '}</code>
        </div>
      ))}
      {preview.hiddenLineCount > 0 ? (
        <p className="border-t border-border-muted px-3 py-1 text-muted">
          {preview.hiddenLineCount.toLocaleString()} more lines not shown
        </p>
      ) : null}
    </div>
  )
}
