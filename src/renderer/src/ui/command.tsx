import type { ComponentProps, JSX, ReactNode } from 'react'
import { Autocomplete as BaseAutocomplete } from '@base-ui/react/autocomplete'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import { Search } from 'lucide-react'
import { cn } from '../lib/utils'

/**
 * Command-window primitives (#174): a top-anchored modal shell + a Base UI
 * Autocomplete in external-filtering mode — the t3code `ui/command.tsx` pattern
 * (Base UI Dialog + Autocomplete, NOT cmdk) ported onto our tokens. The Search
 * palette composes these today; a future general command palette reuses them.
 *
 * Filtering/ranking is the CALLER's job (`mode="none"`): pass ranked `items` and
 * render rows via `CommandCollection`'s render prop — the primitives contribute
 * keyboard highlight/selection (↑↓ + Enter → item click) and the chrome.
 */

export const CommandDialog = BaseDialog.Root

/**
 * The palette's modal chrome: dimming backdrop + a top-anchored panel (10vh down,
 * not centred — palettes hang from the top so the list can grow without jumping).
 */
export function CommandDialogPopup({
  className,
  children,
  ...props
}: ComponentProps<typeof BaseDialog.Popup>): JSX.Element {
  return (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop
        data-slot="command-dialog-backdrop"
        className="fixed inset-0 z-50 bg-black/30"
      />
      <div className="pointer-events-none fixed inset-0 z-50 flex flex-col items-center px-4 py-[10vh]">
        <BaseDialog.Popup
          data-slot="command-dialog-popup"
          className={cn(
            'pointer-events-auto flex max-h-[min(28rem,70vh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-panel text-text shadow-lg outline-none',
            className,
          )}
          {...props}
        >
          {children}
        </BaseDialog.Popup>
      </div>
    </BaseDialog.Portal>
  )
}

/** The Autocomplete root, pinned to command-window behavior (inline, always open,
 * external filtering, keyboard highlight that survives pointer leave). Typed on
 * Base UI's FLAT-list overload — ranked results are one list, never grouped. */
export function Command<ItemValue>({
  ...props
}: Omit<BaseAutocomplete.Root.Props<ItemValue>, 'items'> & {
  items?: readonly ItemValue[] | undefined
}): JSX.Element {
  return (
    <BaseAutocomplete.Root
      inline
      open
      mode="none"
      autoHighlight="always"
      keepHighlight
      {...props}
    />
  )
}

/** The query input row: a search glyph + a borderless input under the panel's top edge. */
export function CommandInput({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.Input>): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 border-b border-border px-3.5 py-3">
      <Search className="size-4 shrink-0 text-muted" aria-hidden />
      <BaseAutocomplete.Input
        data-slot="command-input"
        className={cn(
          'w-full bg-transparent text-[14px] text-text outline-none placeholder:text-faint',
          className,
        )}
        {...props}
      />
    </div>
  )
}

/** The scrolling results region. */
export function CommandList({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.List>): JSX.Element {
  return (
    <BaseAutocomplete.List
      data-slot="command-list"
      className={cn('min-h-0 flex-1 overflow-y-auto not-empty:p-1.5', className)}
      {...props}
    />
  )
}

/** Render-prop bridge over the root's `items` — one call per ranked item. */
export function CommandCollection(
  props: ComponentProps<typeof BaseAutocomplete.Collection>,
): JSX.Element {
  return <BaseAutocomplete.Collection data-slot="command-collection" {...props} />
}

/** The no-results state (renders only when the list is empty). */
export function CommandEmpty({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.Empty>): JSX.Element {
  return (
    <BaseAutocomplete.Empty
      data-slot="command-empty"
      className={cn('not-empty:py-10 text-center text-[13px] text-muted', className)}
      {...props}
    />
  )
}

/** One selectable row: flat flex, accent wash on keyboard/pointer highlight. */
export function CommandItem({
  className,
  ...props
}: ComponentProps<typeof BaseAutocomplete.Item>): JSX.Element {
  return (
    <BaseAutocomplete.Item
      data-slot="command-item"
      className={cn(
        'flex cursor-pointer select-none items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-[13px] outline-none data-[highlighted]:bg-accent/10',
        className,
      )}
      {...props}
    />
  )
}

/** The bottom hint strip (keyboard legend). */
export function CommandFooter({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      data-slot="command-footer"
      className="flex items-center gap-3 border-t border-border px-3.5 py-2 text-[11px] text-faint"
    >
      {children}
    </div>
  )
}
