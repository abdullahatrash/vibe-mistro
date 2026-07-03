/**
 * Pure view logic for the App-update affordance (#270): the chip is PASSIVE and
 * appears only once a downloaded Release is ready to install — checking,
 * downloading, and errors stay invisible (errors are main-log diagnostics; the
 * next periodic check retries). See CONTEXT.md "App update".
 */
import type { AppUpdateStatusEvent } from '../../../shared/ipc'

/** The chip's label, or null when nothing should render. */
export function updateReadyLabel(status: AppUpdateStatusEvent): string | null {
  if (status.phase !== 'ready') return null
  return status.version ? `Update ready · v${status.version}` : 'Update ready'
}
