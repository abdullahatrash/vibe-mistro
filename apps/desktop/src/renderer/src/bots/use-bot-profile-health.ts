import { useCallback, useEffect, useRef, useState } from 'react'
import type { BotProfileStatus } from '../../../shared/ipc'

/**
 * Is the open Bot's persona still there, and can it be repaired? (#448)
 *
 * ADR-0027 says failure is LOUD: a Bot whose profile file went missing must open
 * with a banner naming the profile and offering a rebuild — never silently, and
 * never as a plain Thread. Slice 2 answers the same question on a bind, but a
 * bind needs a prompt; this asks on OPEN, before the user has typed a word into
 * what still looks like their teammate.
 *
 * Main does the diffing (`assess-bot-profile.ts`) against the agent's advertised
 * modes; this hook only owns the asking, the repair round-trip, and the
 * stale-answer guard. It is inert for an ordinary Thread (`threadId` null).
 */
export interface BotProfileHealth {
  /** The persona the agent no longer offers, or null when there is nothing to say. */
  missing: { profileId: string; reason: string } | null
  /** A repair landed this session — the banner turns into its confirmation. */
  rebuilt: boolean
  /** A repair is in flight (the button is disabled meanwhile). */
  rebuilding: boolean
  /** The repair itself failed — shown in place of the confirmation. */
  rebuildError: string | null
  /** Rebuild the profile files from the Bot record. */
  rebuild: () => void
  /** Re-ask, e.g. after a bind reported the persona could not be selected. */
  recheck: () => void
}

export function useBotProfileHealth(
  threadId: string | null,
  agentId: string,
): BotProfileHealth {
  const [status, setStatus] = useState<BotProfileStatus>({ kind: 'unknown' })
  const [rebuilt, setRebuilt] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  // Every answer carries the request that asked for it: switching Bots (or a
  // rebuild's re-check) must never be overwritten by a slower earlier reply.
  const askId = useRef(0)

  const recheck = useCallback(() => {
    if (!threadId) return
    const asked = ++askId.current
    void window.api
      .botsProfileStatus({ threadId, agentId })
      .then((next) => {
        if (asked === askId.current) setStatus(next)
      })
      .catch((err: unknown) => {
        // Log, don't swallow — but a failed CHECK is not evidence of a failed
        // persona, so it must not raise a banner accusing one.
        console.error('[vibe-mistro:bots] could not check the Bot persona:', err)
      })
  }, [threadId, agentId])

  useEffect(() => {
    setRebuilt(false)
    setRebuildError(null)
    setStatus({ kind: 'unknown' })
    recheck()
  }, [recheck])

  const rebuild = useCallback(() => {
    if (!threadId) return
    setRebuilding(true)
    setRebuildError(null)
    void window.api
      .botsRebuildProfile({ threadId })
      .then((result) => {
        if (result.ok) {
          setRebuilt(true)
          // The files are back, but a session that is already running resolved its
          // profile when it opened and is unaffected either way (acp-capture
          // §14.6) — so re-checking is how the accusation is withdrawn, not how
          // the persona returns. It returns on the next bind.
          recheck()
        } else {
          setRebuildError(result.problems.join(' ') || 'The persona could not be rebuilt.')
        }
      })
      .catch((err: unknown) => {
        console.error('[vibe-mistro:bots] could not rebuild the Bot persona:', err)
        setRebuildError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setRebuilding(false))
  }, [threadId, recheck])

  return {
    missing: status.kind === 'missing' ? { profileId: status.profileId, reason: status.reason } : null,
    rebuilt,
    rebuilding,
    rebuildError,
    rebuild,
    recheck,
  }
}
