import { createContext, useContext } from 'react'
import type { AcpCommand, PermissionItem, PermissionOption } from './reducer'

/**
 * Cross-cutting inputs for transcript rows (#386), split into TWO contexts by
 * volatility so the memoized `Item` rows (keyed on the reducer's preserved item
 * identity) actually bail out during streaming:
 *
 * - `TimelineHandlers` — identity-STABLE per mounted view: the permission answer
 *   relay and the session's slash-command list. Providers must memoize the value;
 *   it may only churn when the command list itself changes (rare), never per chunk.
 * - `TimelineActivity` — the LIVE turn flags every row's `streaming` derives from.
 *   It changes on turn open/close and on each sent prompt (the last-user boundary),
 *   NOT per streamed chunk, so context propagation stays off the token hot path.
 *
 * Rows receive only their item (+ index) as props and subscribe to exactly the
 * shared state they use — no more drilling `onPermission`/`availableCommands`
 * through every row that ignores them.
 */
export interface TimelineHandlers {
  /** Answer a pending permission request (relayed to the agent by the provider). */
  onPermission: (item: PermissionItem, option: PermissionOption) => void
  /** The session's slash commands/skills — user rows chip a leading `/name` match. */
  availableCommands: readonly AcpCommand[]
}

/** The live-turn state rows derive `streaming` from (see `isRowStreaming`). */
export interface TimelineActivity {
  /** True while this Thread's turn is in flight (#115). */
  isProcessing: boolean
  /** Index of the last user message — the current turn starts after it (#115 review S1). */
  lastUserIndex: number
}

const TimelineHandlersContext = createContext<TimelineHandlers | null>(null)
const TimelineActivityContext = createContext<TimelineActivity | null>(null)

export const TimelineHandlersProvider = TimelineHandlersContext.Provider
export const TimelineActivityProvider = TimelineActivityContext.Provider

/** A settled, read-only view's activity (ColdThread): nothing ever streams. */
export const SETTLED_ACTIVITY: TimelineActivity = { isProcessing: false, lastUserIndex: -1 }

export function useTimelineHandlers(): TimelineHandlers {
  const handlers = useContext(TimelineHandlersContext)
  if (handlers === null) {
    throw new Error('useTimelineHandlers requires a TimelineHandlersProvider above the transcript')
  }
  return handlers
}

export function useTimelineActivity(): TimelineActivity {
  const activity = useContext(TimelineActivityContext)
  if (activity === null) {
    throw new Error('useTimelineActivity requires a TimelineActivityProvider above the transcript')
  }
  return activity
}

/**
 * Pure: a row belongs to the streaming turn iff a turn is in flight AND the row
 * sits AFTER the last user message — so sending a new prompt doesn't re-expand
 * the whole history's "Thinking" blocks (they belong to prior, settled turns).
 * With no user message yet (`lastUserIndex` -1) every row of the live turn streams.
 */
export function isRowStreaming(activity: TimelineActivity, index: number): boolean {
  return activity.isProcessing && index > activity.lastUserIndex
}

/** This row's live `streaming` flag, derived from the activity context. */
export function useRowStreaming(index: number): boolean {
  return isRowStreaming(useTimelineActivity(), index)
}
