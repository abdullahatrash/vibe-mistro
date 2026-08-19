import type { JSX } from 'react'
import {
  contextUsageLevel,
  contextUsageNotice,
  contextUsagePercent,
} from '../context-usage'

/**
 * The per-Thread readout under the transcript: context used and turn cost.
 *
 * Context is a HEALTH signal, not just a number (#433) — past 75% of Vibe's
 * compaction threshold the reading colours and names what is about to happen, so
 * a lossy compaction is something the user sees coming rather than discovers.
 */
export function UsageBar({
  state,
}: {
  state: { usage: { used: number; size: number } | null; cost: { amount: number; currency: string } | null }
}): JSX.Element | null {
  if (!state.usage && !state.cost) return null
  const level = state.usage ? contextUsageLevel(state.usage) : 'normal'
  const notice = contextUsageNotice(level)
  const percent = state.usage ? contextUsagePercent(state.usage) : null
  return (
    <div className="usage">
      {state.usage && (
        <span className={`usage__item usage__item--${level}`}>
          context <strong>{state.usage.used.toLocaleString()}</strong> /{' '}
          {state.usage.size.toLocaleString()} tokens
          {percent !== null && level !== 'normal' && <> ({percent}%)</>}
        </span>
      )}
      {state.cost && (
        <span className="usage__item">
          cost <strong>{formatCost(state.cost.amount, state.cost.currency)}</strong>
        </span>
      )}
      {/* `role="status"` so the warning is announced when it appears, not silently
          repainted — this is the one thing on the bar worth interrupting for. */}
      {notice && (
        <span className={`usage__notice usage__notice--${level}`} role="status">
          {notice}
        </span>
      )}
    </div>
  )
}

function formatCost(amount: number, currency: string): string {
  const symbol = currency.toUpperCase() === 'USD' ? '$' : `${currency} `
  return `${symbol}${amount.toFixed(4)}`
}
