import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import {
  IPC,
  type RoutinesCreateArgs,
  type RoutinesDeleteArgs,
  type RoutinesDeleteResult,
  type RoutinesListArgs,
  type RoutinesListResult,
  type RoutinesUpdateArgs,
  type RoutineWriteResult,
} from '../../shared/ipc'
import type { BotStoreApi } from '../persistence/bot-store-api'
import type { RoutineStoreApi } from '../persistence/routine-store-api'
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  updateRoutine,
  type RoutineLifecycleDeps,
} from './routine-lifecycle'
import {
  runRoutineTurn,
  type RoutineTurnDeps,
  type RoutineTurnResult,
  type RunRoutineOptions,
} from './run-routine-turn'

/**
 * The Routine CRUD handlers (#467, ADR-0028), registered beside their modules
 * like the bots / git / files registrars. Thin wrappers: every decision lives in
 * `routine-lifecycle.ts` and the pure validator under it.
 *
 * Nothing here FIRES anything, and no handler runs a turn. What this registrar
 * also does since #468 is ASSEMBLE the headless turn from the main-side seams the
 * caller passes in, and hand the assembled entry point back — so the scheduler
 * (#470) has exactly one thing to reach for, and everything the run needs stays
 * injected rather than reached for through module state.
 */

export interface RoutinesIpcDeps {
  routines: RoutineStoreApi
  /** Read-only Bot access: a Routine can only ever be attached to a Bot. */
  bots: Pick<BotStoreApi, 'get'>
  /**
   * The main-side half of a headless turn (#468) — the pool, the busy claim, the
   * eviction protection and the turn itself. Only `index.ts` holds these, which is
   * why they arrive as seams; `run-routine-turn.ts` documents each one.
   */
  turn: Omit<RoutineTurnDeps, 'routines' | 'bots'>
}

/** What the registrar hands back: the ONE way to run a Routine's turn. */
export interface RoutinesRegistration {
  /**
   * Run this Routine's prompt into its Bot's conversation NOW, with nobody
   * watching, and record how it went. Resolves with the outcome; never rejects.
   *
   * The scheduler (#470) is the caller: it decides WHEN, this decides nothing
   * about time. `options.late` carries a slot the run is starting after, which the
   * turn states twice — as a notice we write, and inside the agent's own prompt.
   */
  runRoutineNow(routineId: string, options?: RunRoutineOptions): Promise<RoutineTurnResult>
}

export function registerRoutinesIpc(deps: RoutinesIpcDeps): RoutinesRegistration {
  const lifecycle: RoutineLifecycleDeps = {
    routines: deps.routines,
    bots: deps.bots,
    mintRoutineId: () => randomUUID(),
  }
  const turn: RoutineTurnDeps = { ...deps.turn, routines: deps.routines, bots: deps.bots }

  ipcMain.handle(
    IPC.routinesList,
    (_event, args: RoutinesListArgs = {}): RoutinesListResult => ({
      routines: listRoutines(lifecycle, args),
    }),
  )

  ipcMain.handle(
    IPC.routinesCreate,
    (_event, args: RoutinesCreateArgs): RoutineWriteResult => createRoutine(lifecycle, args),
  )

  ipcMain.handle(
    IPC.routinesUpdate,
    (_event, args: RoutinesUpdateArgs): RoutineWriteResult => updateRoutine(lifecycle, args),
  )

  ipcMain.handle(
    IPC.routinesDelete,
    (_event, args: RoutinesDeleteArgs): RoutinesDeleteResult => deleteRoutine(lifecycle, args),
  )

  return { runRoutineNow: (routineId, options) => runRoutineTurn(turn, routineId, options) }
}
