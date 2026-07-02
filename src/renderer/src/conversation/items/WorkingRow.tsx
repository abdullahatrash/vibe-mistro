import { useEffect, useRef, type JSX } from 'react'
import { formatElapsed } from '../working-time'

/**
 * Working indicator (#115): a self-ticking "Working for 12s" label that SHIMMERS
 * through the Mistral "M" palette — a web port of the vibe CLI's LoadingWidget (which
 * sweeps yellow→orange→red across its status text). The `.vm-shimmer` class rides a
 * background-clip:text gradient (styles.css); the whole label lives in ONE text node
 * (clip:text doesn't span nested colored children), updated via `setInterval` so the
 * timer never triggers a React re-render. The row mounts only while a turn is in
 * flight, so mount ≈ turn start.
 */
export function WorkingRow(): JSX.Element {
  const startRef = useRef(Date.now())
  const textRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const tick = (): void => {
      if (textRef.current) {
        textRef.current.textContent = `Working for ${formatElapsed((Date.now() - startRef.current) / 1000)}`
      }
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [])
  return (
    <div className="flex items-center px-0.5 py-0.5 text-[12px] tabular-nums">
      <span ref={textRef} className="vm-shimmer font-medium">
        Working for 0s
      </span>
    </div>
  )
}
