import {
  useEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { cn } from '../lib/utils'
import { moveSelection } from './command-autocomplete'
import { resolveAutocomplete, type ActiveTrigger, type Detection } from './autocomplete-machine'
import type { PendingContext } from './pending-contexts'
import type { ComposerEditorHandle } from './composer-editor-handle'
import type { ComposerInlineToken } from './composer-inline-tokens'

/**
 * One completion mechanism for the composer (quality-review slice 4a): the `/` command
 * popover and the `@` file-path popover are two configs of this ONE hook + descriptor,
 * not two hand-mirrored state machines. A {@link CompletionSource} is a thin adapter over
 * a pure core (command-autocomplete.ts / path-autocomplete.ts): it detects its token,
 * ranks its rows, splices an accepted row in, and renders a row's inner markup. The hook
 * holds the single trigger/index/dismiss state machine (`autocomplete-machine.ts`); the
 * sources are ordered by PRIORITY (array order = which wins when two tokens overlap).
 *
 * `Row` is the source's row type (an `AcpCommand`, a `FileEntry`, …); the hook type-erases
 * it to `unknown` so a heterogeneous `CompletionSource[]` composes, and hands each row back
 * to its own source for keying/applying/rendering — never inspecting it itself.
 */
export interface CompletionSource<Row = unknown> {
  /** Stable id (debug/keying). */
  id: string
  /** aria-label for this source's listbox popover. */
  label: string
  /** Base `<li>` classes for this source's rows (the shared wrapper adds the active tint). */
  rowClassName: string
  /** Probe the value + caret; return the open trigger, or null when this source isn't active. */
  detect(value: string, caret: number): Detection | null
  /** The ranked, already-capped visible rows for a query. */
  rows(query: string): readonly Row[]
  /** A stable React key for a row. */
  rowKey(row: Row): string
  /** Splice the accepted row over its `@`/`/` token; return the new value + caret. A source
   *  whose accept stages structured data instead of inline text removes the typed token
   *  and returns either a pending-context chip or an Inline token. */
  apply(
    value: string,
    start: number,
    caret: number,
    row: Row,
  ): { value: string; caret: number; context?: PendingContext; inlineToken?: ComposerInlineToken }
  /** Whether accepting this row CLOSES the popover. False re-derives the trigger for
   *  source-specific continuation flows. */
  closeOnAccept(row: Row): boolean
  /** Fired once this source's token becomes active — the lazy `@` listing fetch hooks here. */
  onOpen?(): void
  /** Render a row's inner content (the shared `<li>` wrapper handles selection + accept). */
  renderRow(row: Row): JSX.Element
}

/** The handle the composer holds: derived open-state + the input/keyboard wiring. */
export interface ComposerAutocomplete {
  /** True when a source is open AND has at least one row (so the keyboard handler is live). */
  open: boolean
  /** The open source (for rendering its popover), or null. */
  activeSource: CompletionSource | null
  /** The open source's visible rows. */
  rows: readonly unknown[]
  /** The highlighted row index, clamped to the current row count. */
  activeIndex: number
  /** Ref for the highlighted `<li>` so ↑/↓ keep it scrolled into the overflow window. */
  activeRowRef: RefObject<HTMLLIElement | null>
  /** Re-derive the trigger after any edit or caret move (onChange / onSelect). */
  onInput(value: string, caret: number | null): void
  /** Popover-open key interception (nav + accept + Esc). Returns true when it handled the
   *  key, so the composer skips Enter's send / Tab's focus move. */
  onKeyDown(e: KeyboardEvent<HTMLElement>): boolean
  /** Accept a row (mouse click on a popover row). */
  accept(row: unknown): void
}

/**
 * The single autocomplete state machine for the composer. Holds ONE trigger (which source +
 * where), ONE highlight index, and a per-source Esc-dismiss latch — driven by the pure
 * `resolveAutocomplete`. The keyboard contract is source-agnostic: ↑/↓ navigate, Enter/Tab
 * accept, Esc dismisses + latches the token, all only while open; when closed every key
 * falls through (the composer's Enter sends).
 */
export function useComposerAutocomplete(
  sources: readonly CompletionSource[],
  value: string,
  setValue: (next: string) => void,
  inputRef: RefObject<ComposerEditorHandle | null>,
  /** Receives the pending-context chip when an accepted row stages one (#229). */
  onContext?: (context: PendingContext) => void,
  onInlineToken?: (token: ComposerInlineToken) => void,
): ComposerAutocomplete {
  const [trigger, setTrigger] = useState<ActiveTrigger | null>(null)
  const [index, setIndex] = useState(0)
  // Per-source Esc-dismiss latch, keyed by source index: the token start the user dismissed.
  // While it holds, re-deriving the SAME token keeps that source closed (so Esc stays
  // dismissed as you keep typing — the escape hatch for a literal `/text` / `@foo`), which
  // also lets a lower-priority source win in its place.
  const dismissedRef = useRef<Array<number | null>>([])
  const activeRowRef = useRef<HTMLLIElement>(null)

  const activeSource = trigger ? sources[trigger.sourceIndex] : null
  const rows = trigger && activeSource ? activeSource.rows(trigger.query) : []
  const open = trigger !== null && rows.length > 0
  const activeIndex = Math.min(index, rows.length - 1)

  // Keep the highlighted row visible when ↑/↓ walk past the popover's max-height.
  // `block: 'nearest'` scrolls only the overflow list, not the whole page. Keyed on the
  // source id too, so swapping which popover is open (e.g. dismissing `/` to reveal `@`)
  // re-scrolls the new active row.
  useEffect(() => {
    if (open) activeRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open, activeIndex, activeSource?.id])

  // Re-derive the trigger from the composer's value + caret after any edit or caret move.
  // Reads the live caret so `hello /re` (mid-line) never triggers `/` while `/re` (line
  // start) does. Resetting the highlight to the top on every re-derive is safe: list
  // navigation preventDefaults the caret move, so it never re-runs this.
  function onInput(inputValue: string, caret: number | null): void {
    const detections = sources.map((source) =>
      caret === null ? null : source.detect(inputValue, caret),
    )
    const resolved = resolveAutocomplete(detections, dismissedRef.current)
    dismissedRef.current = resolved.dismissed
    // Fire the lazy `onOpen` (e.g. the `@` listing fetch) for every source that became
    // eligible — even one hidden behind a higher-priority winner.
    for (const i of resolved.opened) sources[i].onOpen?.()
    setTrigger(resolved.winner)
    setIndex(0)
  }

  // Accept a completion: splice the row in over its token, keep the composer value (+ its
  // persisted draft, via `setValue`) in lockstep, then restore focus and drop the caret
  // just past the insertion (rAF, so React's controlled value doesn't stomp the DOM caret).
  // A source that DOESN'T close on accept re-derives the trigger for source-specific
  // continuation flows; otherwise the token's latch is cleared and the popover shuts.
  function accept(row: unknown): void {
    if (!trigger) return
    const source = sources[trigger.sourceIndex]
    const node = inputRef.current
    const caret = node?.getSelectionStart() ?? value.length
    const next = source.apply(value, trigger.start, caret, row)
    setValue(next.value)
    if (next.context) onContext?.(next.context)
    if (next.inlineToken) onInlineToken?.(next.inlineToken)
    setIndex(0)
    if (source.closeOnAccept(row)) {
      dismissedRef.current[trigger.sourceIndex] = null
      setTrigger(null)
    } else {
      onInput(next.value, next.caret)
    }
    requestAnimationFrame(() => {
      const el = inputRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(next.caret, next.caret)
    })
  }

  function onKeyDown(e: KeyboardEvent<HTMLElement>): boolean {
    // Popover-open key interception: navigation + accept must win over Enter's send and
    // Tab's focus move. When closed, this returns false and every key falls through.
    if (!open || !trigger) return false
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex(moveSelection(activeIndex, rows.length, 1))
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex(moveSelection(activeIndex, rows.length, -1))
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      accept(rows[activeIndex])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      // Latch this token as dismissed so typing more doesn't reopen it.
      dismissedRef.current[trigger.sourceIndex] = trigger.start
      setTrigger(null)
      return true
    }
    return false
  }

  return { open, activeSource, rows, activeIndex, activeRowRef, onInput, onKeyDown, accept }
}

/**
 * The single popover replacing the twin `<ul>`s. Structure (positioning, listbox roles,
 * mousedown-before-blur accept) is shared; each source supplies its `<li>` base classes
 * (`rowClassName`) and inner markup (`renderRow`), so command rows still show name +
 * description and path rows still show icon + path with their exact original classes.
 */
export function CompletionPopover({
  source,
  rows,
  activeIndex,
  activeRowRef,
  onAccept,
}: {
  source: CompletionSource
  rows: readonly unknown[]
  activeIndex: number
  activeRowRef: RefObject<HTMLLIElement | null>
  onAccept: (row: unknown) => void
}): JSX.Element {
  return (
    <ul
      className="absolute right-0 bottom-full left-0 z-10 mb-2 max-h-56 list-none overflow-y-auto rounded-xl border border-border bg-panel p-1 shadow-lg"
      role="listbox"
      aria-label={source.label}
    >
      {rows.map((row, i) => (
        <li
          key={source.rowKey(row)}
          ref={i === activeIndex ? activeRowRef : null}
          role="option"
          aria-selected={i === activeIndex}
          className={cn(source.rowClassName, i === activeIndex && 'bg-[var(--accent-tint)]')}
          // mousedown (not click) so we accept BEFORE the textarea blurs.
          onMouseDown={(e) => {
            e.preventDefault()
            onAccept(row)
          }}
        >
          {source.renderRow(row)}
        </li>
      ))}
    </ul>
  )
}
