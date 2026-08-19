/**
 * Reading the `usage_update {used, size}` gauge as a HEALTH signal rather than a
 * pair of numbers (#433).
 *
 * `size` is Vibe's `auto_compact_threshold` (default 200_000), so `used/size` is
 * how close this conversation is to being compacted — and compaction is lossy:
 * assistant turns, tool calls and reasoning are discarded, only user prose and a
 * summary survive. A user who can see that coming can finish the thought, start a
 * fresh Thread, or `/compact` deliberately instead of being surprised.
 *
 * Vibe already injects its own one-shot `<vibe_warning>` at 50%, so warning that
 * early here would just double up on a message the user has already read. We speak
 * later, and only twice.
 */

/** How close a conversation is to its compaction threshold. */
export type ContextUsageLevel = 'normal' | 'warn' | 'critical'

/** Fraction of the threshold at which we first say something. */
export const CONTEXT_WARN_RATIO = 0.75
/** Fraction at which compaction is imminent enough to name the consequence. */
export const CONTEXT_CRITICAL_RATIO = 0.9

export interface ContextUsage {
  used: number
  size: number
}

/**
 * Classify a usage reading. A non-positive or non-finite `size` yields `normal`:
 * an unusable denominator must not render as an alarm (we would rather under-warn
 * than cry wolf on a garbled reading).
 */
export function contextUsageLevel(usage: ContextUsage): ContextUsageLevel {
  const ratio = contextUsageRatio(usage)
  if (ratio === null) return 'normal'
  if (ratio >= CONTEXT_CRITICAL_RATIO) return 'critical'
  if (ratio >= CONTEXT_WARN_RATIO) return 'warn'
  return 'normal'
}

/**
 * `used / size`, or null when the reading cannot be trusted (non-finite, negative,
 * or a zero denominator). Not clamped: a ratio above 1 is real and means Vibe is
 * past its own threshold — see the compaction-thrash case in #433.
 */
export function contextUsageRatio(usage: ContextUsage): number | null {
  const { used, size } = usage
  if (!Number.isFinite(used) || !Number.isFinite(size)) return null
  if (size <= 0 || used < 0) return null
  return used / size
}

/** Whole-percent reading for display. Null whenever the ratio is untrustworthy. */
export function contextUsagePercent(usage: ContextUsage): number | null {
  const ratio = contextUsageRatio(usage)
  return ratio === null ? null : Math.round(ratio * 100)
}

/**
 * The short line shown beside the numbers once we have something to say. Null at
 * `normal` — the gauge stays silent for most of a conversation's life, so that
 * when it does speak the user has reason to read it.
 */
export function contextUsageNotice(level: ContextUsageLevel): string | null {
  if (level === 'critical') return 'compacting soon — older turns will be summarised'
  if (level === 'warn') return 'approaching the context limit'
  return null
}
