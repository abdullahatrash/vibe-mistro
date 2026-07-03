import { useEffect, useState, type JSX } from 'react'
import { RefreshCw } from 'lucide-react'
import type { AppUpdateStatusEvent } from '../../../shared/ipc'
import { updateReadyLabel } from './app-update-view'
import { Button } from '../ui/button'

/**
 * The passive App-update affordance (#270, ADR-0018): a quiet full-width chip in
 * the sidebar's pinned bottom band, rendered ONLY once a downloaded Release is
 * ready (`updateReadyLabel`). Clicking restarts into the new version; ignoring it
 * installs on normal quit — main never force-restarts. Self-contained: seeds from
 * `getAppUpdateStatus` (a window that mounts mid-cycle) and follows the
 * `app-update:status` stream, so Shell passes nothing in.
 */
export function UpdateReadyChip(): JSX.Element | null {
  const [status, setStatus] = useState<AppUpdateStatusEvent | null>(null)

  useEffect(() => {
    let mounted = true
    void window.api.getAppUpdateStatus().then((seed) => {
      // The stream may have delivered a fresher status while the seed was in
      // flight; never let the seed clobber it.
      if (mounted) setStatus((live) => live ?? seed)
    })
    const unsubscribe = window.api.onAppUpdateStatus((event) => setStatus(event))
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  const label = status ? updateReadyLabel(status) : null
  if (label === null) return null
  return (
    <Button
      variant="outline"
      size="xs"
      className="w-full flex-none justify-start gap-2"
      onClick={() => window.api.appUpdateRestart()}
      title="Restart to apply the update (it also installs on quit)"
    >
      <RefreshCw className="size-3.5 flex-none text-accent-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      <span className="flex-none text-muted">Restart</span>
    </Button>
  )
}
