import { useEffect, useState, type JSX } from 'react'
import type { VibeDetectResult, VibeUpdateResult } from '../../../shared/ipc'
import { INSTALL_DOCS_URL } from '../../../shared/install-guidance'
import { Button } from '../ui/button'
import { CodeText } from '../ui/code-text'
import { describeUpdateStatus } from './update-status'

/** The environment check: whether `vibe` / `vibe-acp` are installed + reachable. */
export function Environment({
  detect,
  loading,
  onRecheck,
}: {
  detect: VibeDetectResult | null
  loading: boolean
  onRecheck: () => void
}): JSX.Element {
  const update = useVibeUpdate(detect)
  const updateStatus = describeUpdateStatus(update)
  return (
    <div className="flex flex-col gap-2.5 rounded-[9px] border border-border p-3">
      <div className="flex items-center justify-between text-[13px] font-semibold text-text-strong">
        <span>Environment</span>
        <Button variant="ghost" size="xs" onClick={onRecheck} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </Button>
      </div>
      {detect && (
        <ul className="status">
          <StatusRow ok={detect.vibeFound} label="vibe CLI" />
          <StatusRow ok={detect.vibeAcpFound} label="vibe-acp (ACP server)" />
          <li className="status__row">
            <span className="status__label">version</span>
            <span className="status__value">{detect.vibeVersion ?? '—'}</span>
          </li>
          {updateStatus && (
            <li className="status__row">
              <span className="status__label">latest</span>
              <span className="status__value">{updateStatus}</span>
            </li>
          )}
          {update?.updateAvailable && (
            <li className="text-[13px] leading-normal text-faint">
              Update with <CodeText text="uv tool upgrade mistral-vibe" /> (or{' '}
              <CodeText text="brew upgrade mistral-vibe" />), then Re-check.
            </li>
          )}
          {detect.error && (
            <li className="status__error">
              <CodeText text={detect.error} />{' '}
              <a className="underline" href={INSTALL_DOCS_URL} target="_blank" rel="noreferrer">
                Install guide
              </a>
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

/**
 * Check PyPI (via main) for a newer `mistral-vibe` once per detection result —
 * a Re-check mints a fresh `detect` object, so it also re-runs this. Skipped
 * until the CLI is actually found; a check failure renders as its own row copy.
 */
function useVibeUpdate(detect: VibeDetectResult | null): VibeUpdateResult | null {
  const [update, setUpdate] = useState<VibeUpdateResult | null>(null)
  useEffect(() => {
    if (!detect?.vibeFound) {
      setUpdate(null)
      return
    }
    let cancelled = false
    void window.api.checkVibeUpdate({ vibeVersion: detect.vibeVersion }).then((result) => {
      if (!cancelled) setUpdate(result)
    })
    return () => {
      cancelled = true
    }
  }, [detect])
  return update
}

function StatusRow({ ok, label }: { ok: boolean; label: string }): JSX.Element {
  return (
    <li className="status__row">
      <span className={ok ? 'dot dot--ok' : 'dot dot--bad'} aria-hidden />
      <span className="status__label">{label}</span>
      <span className="status__value">{ok ? 'found' : 'missing'}</span>
    </li>
  )
}
