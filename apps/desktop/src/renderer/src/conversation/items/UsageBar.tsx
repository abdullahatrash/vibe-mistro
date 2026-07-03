import type { JSX } from 'react'

export function UsageBar({
  state,
}: {
  state: { usage: { used: number; size: number } | null; cost: { amount: number; currency: string } | null }
}): JSX.Element | null {
  if (!state.usage && !state.cost) return null
  return (
    <div className="usage">
      {state.usage && (
        <span className="usage__item">
          context <strong>{state.usage.used.toLocaleString()}</strong> /{' '}
          {state.usage.size.toLocaleString()} tokens
        </span>
      )}
      {state.cost && (
        <span className="usage__item">
          cost <strong>{formatCost(state.cost.amount, state.cost.currency)}</strong>
        </span>
      )}
    </div>
  )
}

function formatCost(amount: number, currency: string): string {
  const symbol = currency.toUpperCase() === 'USD' ? '$' : `${currency} `
  return `${symbol}${amount.toFixed(4)}`
}
