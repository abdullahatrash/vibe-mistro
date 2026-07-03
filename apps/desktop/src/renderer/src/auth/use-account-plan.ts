import { useEffect, useState } from 'react'
import type { AccountPlan } from '../../../shared/ipc'

/**
 * Fetch the signed-in account's plan tier once per mount (best-effort). Null
 * while loading, on any failure, or when no key is stored — callers render
 * their static fallback, never an error state; the network round-trip fills
 * the tier in when it lands. The sidebar chip mounts once per app launch and
 * the Settings page remounts per open, so each surface refreshes on its own
 * natural cadence without a shared cache.
 */
export function useAccountPlan(): AccountPlan | null {
  const [plan, setPlan] = useState<AccountPlan | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.api.accountWhoami().then((result) => {
      if (!cancelled && result.ok) setPlan(result.plan)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return plan
}
