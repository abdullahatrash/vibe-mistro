import { useCallback, useEffect, useState } from 'react'
import type {
  RoutineRecord,
  RoutinesCreateArgs,
  RoutinesUpdateArgs,
  RoutineWriteResult,
} from '../../../shared/ipc'

/**
 * The **Routine** records (#471), read over `routines:list` and refreshed only when
 * one changes — there is no timer, because nothing about a record moves on its own.
 *
 * What DOES move on its own is the last run: the scheduler writes `lastRunAt` and
 * an outcome from main, with no push to the renderer. The Bot form therefore
 * re-reads on mount (this hook's effect) rather than pretending to be live. A row
 * that is a few minutes stale about a run that already happened is a small lie; a
 * push channel for a surface nobody has open would be a large mechanism. If the
 * staleness ever matters, the fix is a push on `recordRun`, not a poll here.
 *
 * Every Bot's routines at once: a Bot holds at most five (ADR-0028 part 1) and a
 * profile holds few Bots, so one read is cheaper than one read per Bot form open.
 */
export interface RoutinesApi {
  routines: RoutineRecord[]
  refreshRoutines: () => void
  /** Create — resolves with main's typed result so `problems` can be shown verbatim. */
  createRoutine: (args: RoutinesCreateArgs) => Promise<RoutineWriteResult>
  /** Edit, including pausing (`active: false`). Same contract. */
  updateRoutine: (args: RoutinesUpdateArgs) => Promise<RoutineWriteResult>
  /** Delete. True when a row was removed; the Bot and its conversation are untouched. */
  deleteRoutine: (id: string) => Promise<boolean>
}

export function useRoutines(): RoutinesApi {
  const [routines, setRoutines] = useState<RoutineRecord[]>([])

  const refreshRoutines = useCallback(() => {
    void window.api
      .routinesList({})
      .then((result) => setRoutines(result.routines))
      .catch((err: unknown) => {
        // Log, don't swallow — but never break the form over it. An empty list is a
        // survivable degradation; a thrown render is not.
        console.error('[vibe-mistro:routines] could not list routines:', err)
      })
  }, [])

  useEffect(() => {
    refreshRoutines()
  }, [refreshRoutines])

  const createRoutine = useCallback(
    async (args: RoutinesCreateArgs) => {
      const result = await window.api.routinesCreate(args)
      // Only on success: the list must never drop something main still holds, and a
      // refusal leaves the form open with everything typed still in it.
      if (result.ok) refreshRoutines()
      return result
    },
    [refreshRoutines],
  )

  const updateRoutine = useCallback(
    async (args: RoutinesUpdateArgs) => {
      const result = await window.api.routinesUpdate(args)
      if (result.ok) refreshRoutines()
      return result
    },
    [refreshRoutines],
  )

  const deleteRoutine = useCallback(
    async (id: string) => {
      const result = await window.api.routinesDelete({ id })
      if (result.ok) refreshRoutines()
      return result.ok
    },
    [refreshRoutines],
  )

  return { routines, refreshRoutines, createRoutine, updateRoutine, deleteRoutine }
}
