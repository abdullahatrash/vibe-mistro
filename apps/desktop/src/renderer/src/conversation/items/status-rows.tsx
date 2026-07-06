import { useState, type JSX } from 'react'
import { FoldChevron, FoldableRow } from './foldable-row'
import type { ErrorItem, FallbackItem, NoticeItem } from '../reducer'

export function ErrorRow({ item }: { item: ErrorItem }): JSX.Element {
  return (
    <div className="alert">
      <div className="alert__title">Turn ended</div>
      <div className="alert__message">{item.message}</div>
    </div>
  )
}

export function NoticeRow({ item }: { item: NoticeItem }): JSX.Element {
  return (
    <div className="notice">
      <span className="notice__icon" aria-hidden>
        ↻
      </span>
      <span className="notice__message">{item.message}</span>
    </div>
  )
}

export function FallbackRow({ item }: { item: FallbackItem }): JSX.Element {
  // Unknown session updates, disclosed raw. Migrated from a native `<details>` to
  // the shared FoldableRow (#386) — the design-system chevron replaces the native
  // triangle; the header-zone fold otherwise mirrors the old summary semantics.
  const [open, setOpen] = useState(false)
  return (
    <FoldableRow
      open={open}
      onOpenChange={setOpen}
      toggleZone="header"
      className="fallback"
      headerClassName="fallback__summary flex items-center gap-1"
      header={
        <>
          <FoldChevron open={open} />
          {item.sessionUpdate}
        </>
      }
    >
      <pre className="fallback__body mono">{JSON.stringify(item.raw, null, 2)}</pre>
    </FoldableRow>
  )
}
