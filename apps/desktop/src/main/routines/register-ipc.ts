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

/**
 * The Routine CRUD handlers (#467, ADR-0028), registered beside their modules
 * like the bots / git / files registrars. Thin wrappers: every decision lives in
 * `routine-lifecycle.ts` and the pure validator under it.
 *
 * Nothing here fires anything. The scheduler, the headless turn and the
 * missed-run detector are later slices; this registrar only lets a Routine be
 * written down.
 */

export interface RoutinesIpcDeps {
  routines: RoutineStoreApi
  /** Read-only Bot access: a Routine can only ever be attached to a Bot. */
  bots: Pick<BotStoreApi, 'get'>
}

export function registerRoutinesIpc(deps: RoutinesIpcDeps): void {
  const lifecycle: RoutineLifecycleDeps = {
    routines: deps.routines,
    bots: deps.bots,
    mintRoutineId: () => randomUUID(),
  }

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
}
