import type { JSX, KeyboardEvent, MouseEvent, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * The ONE fold mechanism for transcript rows (#386) — replaces the three divergent
 * implementations (Base UI Collapsible in Reasoning, a hand-rolled role="button"
 * container in Tool, a native `<details>` in Fallback) with a single controlled
 * disclosure that pins the shared semantics:
 *
 * - `toggleZone: 'header'` — only the header line toggles (a real `<button>`, so
 *   Enter/Space/focus come native). The detail body is inert: clicking to select
 *   reasoning text must never collapse the fold.
 * - `toggleZone: 'container'` — the whole row toggles (tool rows: icon + heading +
 *   preview + glyphs are all one target). The expanded detail stops propagation so
 *   selecting text inside it doesn't re-fold.
 * - `canExpand: false` renders the header inert with no toggle affordance — the
 *   caller decides whether to show a chevron at all (peek-only rows stay peek-only).
 *
 * The header is caller markup: place `<FoldChevron open={...} />` wherever the row's
 * design wants it (reasoning: after the label; tool: before the status glyph).
 */
export function FoldableRow({
  open,
  onOpenChange,
  canExpand = true,
  toggleZone,
  className,
  headerClassName,
  header,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** False = nothing to disclose: header renders inert, detail never mounts. */
  canExpand?: boolean
  toggleZone: 'header' | 'container'
  /** Container element classes. */
  className?: string
  /** Header element classes (the `<button>` for `header` zone, a `<div>` otherwise). */
  headerClassName?: string
  header: ReactNode
  /** The detail body, mounted only while expanded — fully styled by the caller. */
  children: ReactNode
}): JSX.Element {
  const toggle = (): void => onOpenChange(!open)

  if (toggleZone === 'container') {
    const toggleProps = canExpand
      ? {
          role: 'button' as const,
          tabIndex: 0,
          'aria-expanded': open,
          onClick: toggle,
          onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              toggle()
            }
          },
        }
      : {}
    return (
      <div className={className} {...toggleProps}>
        <div className={headerClassName}>{header}</div>
        {canExpand && open && (
          // Text selection / clicks inside the detail must not re-fold the row.
          <div onClick={(e: MouseEvent) => e.stopPropagation()}>{children}</div>
        )}
      </div>
    )
  }

  return (
    <div className={className}>
      {canExpand ? (
        <button type="button" className={headerClassName} aria-expanded={open} onClick={toggle}>
          {header}
        </button>
      ) : (
        <div className={headerClassName}>{header}</div>
      )}
      {canExpand && open && children}
    </div>
  )
}

/** The shared rotating disclosure chevron — callers place it inside their header. */
export function FoldChevron({ open, className }: { open: boolean; className?: string }): JSX.Element {
  return (
    <ChevronDown
      className={cn(
        'size-3.5 shrink-0 opacity-70 transition-transform duration-200',
        open && 'rotate-180',
        className,
      )}
      aria-hidden
    />
  )
}
