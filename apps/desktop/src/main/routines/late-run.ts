/**
 * **"Late" as the agent has to hear it** (#470, ADR-0028 part 3 / #459 decision 9)
 * — the coverage period, written into the prompt the Routine sends.
 *
 * Late is stated TWICE, deliberately, and this is the second half. We write the
 * fact ourselves as a system notice (a renderer-side constant over the two
 * timestamps, following the `agent-rebound` precedent), because a marker that
 * depends on the model complying is not a marker. But only the agent can ACT on
 * it: "issues opened since 20 Aug" is a different query from "issues opened since
 * yesterday", and a report that silently covers the wrong window is worse than a
 * missing one.
 *
 * Pure, and formatted in the Routine's OWN timezone — the same stored zone the
 * schedule is computed in, so the instants the agent reads are the wall-clock
 * times the user chose rather than wherever the laptop currently is.
 */

/** A run that is starting later than its slot. */
export interface LateRun {
  /** The slot this run is FOR. */
  dueAt: number
  /** When it last ran, or null when it has NEVER run — a different sentence. */
  lastRunAt: number | null
}

/**
 * The Routine's prompt with the coverage period appended, or the prompt verbatim
 * when the run is on time.
 *
 * Appended rather than prepended so the Routine's own instruction still leads —
 * it is the request; this is a qualifier on it.
 */
export function promptWithCoverage(prompt: string, late: LateRun | null, timezone: string, now: number): string {
  if (!late) return prompt
  return `${prompt}\n\n${lateCoverageNote(late, timezone, now)}`
}

/**
 * The coverage sentence itself.
 *
 * Two shapes, because the difference is the whole point of this slice: a Routine
 * that has run before states the period since that run; one that never has says
 * so outright, so the agent does not invent a window.
 */
export function lateCoverageNote(late: LateRun, timezone: string, now: number): string {
  const scheduled = formatInZone(late.dueAt, timezone)
  const starting = formatInZone(now, timezone)
  const period =
    late.lastRunAt === null
      ? 'This routine has never run before, so cover everything relevant rather than assuming a recent window.'
      : `Cover the period since its last run at ${formatInZone(late.lastRunAt, timezone)} — not just since yesterday.`
  return (
    `[Scheduled run — late] This run was due at ${scheduled} and is starting now, at ${starting}. ` +
    `Routines only run while the app is open, so the delay is ours, not yours. ${period}`
  )
}

/**
 * `YYYY-MM-DD HH:MM (Zone)` in the given IANA zone.
 *
 * Built from `formatToParts` rather than a locale style so the string is the same
 * everywhere the app runs — the agent is reading it, and a machine-set locale must
 * not change what period a report covers. An unknown zone degrades to UTC rather
 * than throwing into a turn that is already running late.
 */
function formatInZone(instant: number, timezone: string): string {
  const zone = safeZone(timezone)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instant))
  const field = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '00'
  const hours = field('hour') === '24' ? '00' : field('hour')
  return `${field('year')}-${field('month')}-${field('day')} ${hours}:${field('minute')} (${zone})`
}

/** The zone if `Intl` knows it, else UTC. */
function safeZone(timezone: string): string {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return timezone
  } catch {
    return 'UTC'
  }
}
