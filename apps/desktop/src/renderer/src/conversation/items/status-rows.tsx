import type { JSX } from 'react'
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
  return (
    <details className="fallback">
      <summary className="fallback__summary">{item.sessionUpdate}</summary>
      <pre className="fallback__body mono">{JSON.stringify(item.raw, null, 2)}</pre>
    </details>
  )
}
