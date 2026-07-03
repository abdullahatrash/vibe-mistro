/**
 * ToolRow status mapping (#115) — the PURE bridge from OUR ACP tool `status`
 * string (docs/acp-capture §4/§7: `pending` → `in_progress` → `completed`, or
 * `failed`) to the compact right-hand status glyph the row renders. Kept DOM-free
 * so it's unit-tested as data (`tool-status.test.ts`); the tsx just switches the
 * returned `glyph` to a lucide component.
 *
 * `state` collapses the protocol lifecycle to five display buckets; `glyph`
 * selects the trailing indicator — a spinner while the call is live (pending or
 * in-progress: "absence of a terminal check"), a `Check` once completed, a
 * destructive `X` on failure. An unknown/missing status defaults to `pending`
 * (spinner) — a freshly-created `tool_call` with no status yet is still "live".
 *
 * `streaming` (#164) carries the current-turn liveness so a non-terminal status
 * doesn't spin forever if ACP omits a terminal `tool_call_update`: once the turn
 * is no longer streaming, any non-terminal status SETTLES to a neutral static
 * `dot` — not a spinner (no live work) and not a `check` (don't claim success).
 * Terminal statuses (`completed`/`failed`) are unaffected by the flag.
 */
export type ToolDisplayState = 'pending' | 'running' | 'done' | 'failed' | 'settled'

export type ToolStatusGlyph = 'spinner' | 'check' | 'x' | 'dot'

export interface ToolStatusDisplay {
  state: ToolDisplayState
  glyph: ToolStatusGlyph
}

export function describeToolStatus(
  status: string | null | undefined,
  streaming = true,
): ToolStatusDisplay {
  switch (status) {
    case 'completed':
      return { state: 'done', glyph: 'check' }
    case 'failed':
      return { state: 'failed', glyph: 'x' }
    case 'in_progress':
      return streaming ? { state: 'running', glyph: 'spinner' } : settled()
    case 'pending':
      return streaming ? { state: 'pending', glyph: 'spinner' } : settled()
    default:
      // Unknown or missing status (e.g. a just-minted `tool_call`) is treated as
      // still-live while streaming: show the spinner, never a false "done".
      return streaming ? { state: 'pending', glyph: 'spinner' } : settled()
  }
}

/** A non-terminal status once the turn has stopped streaming (#164): neutral,
 *  static — neither a live spinner nor a success check. */
function settled(): ToolStatusDisplay {
  return { state: 'settled', glyph: 'dot' }
}
