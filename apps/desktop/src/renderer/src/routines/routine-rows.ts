import type { RoutineOutcome, RoutineRecord } from '../../../shared/ipc'
import { nextRunAfter, type RoutineSchedule } from '../../../shared/schedule'
import { formatRelativeTime } from '../shell/relative-time'

/**
 * The **Routines** list inside the Bot form, as data (#471, ADR-0028 part 7).
 * Pure — no React, no IPC, no `Date.now()` — so the four decisions a row makes are
 * settled in a unit test rather than by watching a clock:
 *
 *  - what ORDER the rows are in;
 *  - how a schedule reads in plain words;
 *  - when the routine will next run — **derived here, never stored** (ADR-0028
 *    part 6: a stored next-fire is a value somebody must remember to rewrite);
 *  - what the row says about the last run, INCLUDING the run that never happened.
 *
 * That last one is the reason the whole epic exists. "Never run yet" and "ran and
 * found nothing" must never read alike, so they are different sentences here rather
 * than the same sentence with a missing timestamp.
 *
 * Both times are rendered in the routine's OWN stored timezone, because that is the
 * clock the schedule is written against (ADR-0028 part 2). A routine authored in
 * Berlin still says 09:00 after you land in Boston — with the zone printed beside
 * it, so 09:00 is never quietly the wrong 09:00.
 */

/** How a row's last-run line should read — the tone the surface colours it with. */
export type RoutineRowTone = 'neutral' | 'ok' | 'warn' | 'error'

/** One row of the list. Everything it renders, already decided. */
export interface RoutineRow {
  routine: RoutineRecord
  /** "Weekdays at 09:00" — plus the zone when it is not this machine's. */
  scheduleText: string
  /**
   * The next fire instant, or null when the routine is paused or its schedule can
   * no longer be computed (a zone this ICU does not know, a malformed time).
   */
  nextRunAt: number | null
  /** "Next run tomorrow at 09:00" / "Paused" / "This schedule cannot be read". */
  nextRunText: string
  /** "Never run yet" / "Ran 2h ago" / "Blocked 2h ago". */
  lastRunText: string
  /** The failure detail behind a `failed` or `blocked` last run; null otherwise. */
  lastErrorText: string | null
  tone: RoutineRowTone
  /**
   * The exact invocation the allowed-commands gate refused on the last run — the
   * repair affordance's payload (#469 stores it structured for precisely this).
   * Null unless the last run was `blocked` on a command it could name.
   */
  repairCommand: string | null
  paused: boolean
}

/**
 * The list, ordered.
 *
 * ACTIVE routines first, then paused ones: a paused routine is not going to do
 * anything, so it must never sit above the one that will. Within each group, the
 * one that runs SOONEST is first — the list answers "what is this Bot about to do?"
 * before it answers anything else — with un-schedulable rows last (they will never
 * run, so they cannot be next), and ties broken by name so the order is stable
 * between renders rather than by insertion accident.
 */
export function routineRows(
  routines: readonly RoutineRecord[],
  now: number,
  machineZone = localTimezone(),
): RoutineRow[] {
  return routines
    .map((routine) => routineRow(routine, now, machineZone))
    .sort((a, b) => {
      if (a.paused !== b.paused) return a.paused ? 1 : -1
      if (a.nextRunAt !== b.nextRunAt) {
        // Null = never; it sorts last within its group whichever side it is on.
        if (a.nextRunAt === null) return 1
        if (b.nextRunAt === null) return -1
        return a.nextRunAt - b.nextRunAt
      }
      return a.routine.name.localeCompare(b.routine.name)
    })
}

/** One row. Exported for the surface that renders a single routine on its own. */
export function routineRow(
  routine: RoutineRecord,
  now: number,
  machineZone = localTimezone(),
): RoutineRow {
  const paused = !routine.active
  // Computed even for a paused routine: the editor shows "it would next run…" so
  // that resuming it is an informed act rather than a hopeful one.
  const nextRunAt = nextRunAfter(routine.schedule, now)
  return {
    routine,
    scheduleText: describeSchedule(routine.schedule, machineZone),
    nextRunAt: paused ? null : nextRunAt,
    nextRunText: paused
      ? 'Paused — it will not run until you resume it'
      : describeNextRun(routine.schedule, nextRunAt, now, machineZone),
    lastRunText: describeLastRun(routine, now),
    lastErrorText: routine.lastOutcome === 'ok' ? null : routine.lastError,
    tone: toneOf(routine),
    repairCommand: routine.lastOutcome === 'blocked' ? (routine.lastBlockedCommand ?? null) : null,
    paused,
  }
}

/** `0` = Sunday … `6` = Saturday, in the order a weekday picker offers them. */
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

/**
 * A schedule in plain words: "Every day at 09:00", "Weekdays at 09:00", "Every
 * Tuesday at 09:00" — with the zone appended when the routine's stored zone is not
 * the one this machine is in, which is the only case where the bare time could
 * mislead.
 */
export function describeSchedule(schedule: RoutineSchedule, machineZone = localTimezone()): string {
  const when =
    schedule.kind === 'daily'
      ? `Every day at ${schedule.at}`
      : schedule.kind === 'weekdays'
        ? `Weekdays at ${schedule.at}`
        : `Every ${WEEKDAY_NAMES[schedule.weekday]} at ${schedule.at}`
  return schedule.timezone === machineZone ? when : `${when} (${schedule.timezone})`
}

/**
 * "Next run tomorrow at 09:00", said in the routine's own zone.
 *
 * The TIME comes from the resolved instant rather than from `schedule.at`, so a
 * routine whose 02:30 does not exist on the morning the clocks go forward says the
 * time it will actually fire (ADR-0028 part 2, rule 2) instead of a time that will
 * not happen.
 */
export function describeNextRun(
  schedule: RoutineSchedule,
  nextRunAt: number | null,
  now: number,
  machineZone = localTimezone(),
): string {
  if (nextRunAt === null) {
    // A stored zone this ICU no longer knows, or a hand-edited time. The routine
    // stays listable, editable and deletable — it simply computes no next run,
    // which is a far better failure than a row that cannot be drawn.
    return 'This schedule cannot be read — edit it to set a new time'
  }
  return `Next run ${describeInstant(nextRunAt, now, schedule.timezone, machineZone)}`
}

/**
 * What the row says about the last run.
 *
 * A routine that has NEVER run gets its own sentence, and that is the distinction
 * the whole design turns on: silence must never be readable as "ran and found
 * nothing". The rest name the outcome, because an outcome nobody watched is only
 * as good as the word used for it.
 */
export function describeLastRun(routine: RoutineRecord, now: number): string {
  if (routine.lastRunAt === null || routine.lastOutcome === null) return 'Never run yet'
  const ago = formatRelativeTime(routine.lastRunAt, now)
  const when = ago === 'now' ? 'just now' : /^\d/.test(ago) ? `${ago} ago` : ago
  switch (routine.lastOutcome) {
    case 'ok':
      return `Ran ${when}`
    case 'failed':
      return `Failed ${when}`
    case 'blocked':
      return `Blocked ${when}`
    case 'deferred':
      // "Deferred", never "skipped": CONTEXT.md reserves a skip for a PAUSED
      // routine, and the two are opposite facts — one was given up after waiting
      // out a busy Bot, the other was never due at all.
      return `Deferred ${when} — the Bot was busy`
  }
}

/** The row's colour, from the same outcome the sentence above is built on. */
export function toneOf(routine: RoutineRecord): RoutineRowTone {
  if (routine.lastOutcome === null) return 'neutral'
  return TONE_BY_OUTCOME[routine.lastOutcome]
}

const TONE_BY_OUTCOME: Record<RoutineOutcome, RoutineRowTone> = {
  ok: 'ok',
  failed: 'error',
  // A block is not a breakage: the routine did exactly what it was told to do with
  // a command nobody allowed it. It is repairable in one click, hence `warn`.
  blocked: 'warn',
  deferred: 'warn',
}

/**
 * An instant, said the way a person would: "today at 09:00", "tomorrow at 09:00",
 * "Friday at 09:00", "on 12 Sep at 09:00" — in `timezone`, with the zone named when
 * it is not this machine's.
 *
 * The day words are computed from the two CIVIL dates in that zone, never from the
 * millisecond gap, so a run 20 hours away is "tomorrow" when it falls on the next
 * calendar day and "today" when it does not — which is what the reader means.
 */
export function describeInstant(
  instant: number,
  now: number,
  timezone: string,
  machineZone = localTimezone(),
): string {
  const time = formatIn(instant, timezone, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const days = civilDaysBetween(now, instant, timezone)
  const day =
    days === 0
      ? 'today'
      : days === 1
        ? 'tomorrow'
        : days > 1 && days < 7
          ? `on ${formatIn(instant, timezone, { weekday: 'long' })}`
          : `on ${formatIn(instant, timezone, { month: 'short', day: 'numeric' })}`
  const zone = timezone === machineZone ? '' : ` (${timezone})`
  return `${day} at ${time}${zone}`
}

/** This machine's IANA zone — the only thing a routine's stored zone is compared with. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** Whole CALENDAR days from `from` to `to`, counted in `timezone`. */
function civilDaysBetween(from: number, to: number, timezone: string): number {
  const a = civilDate(from, timezone)
  const b = civilDate(to, timezone)
  if (!a || !b) return 0
  return Math.round((b - a) / 86_400_000)
}

/** An instant's civil date in a zone, as a comparable UTC-midnight key. */
function civilDate(instant: number, timezone: string): number | null {
  // `en-CA` renders a date as YYYY-MM-DD, which is the shortest honest way to read
  // a zone's civil date back out of `Intl` without walking the parts by hand.
  const iso = format(instant, timezone, 'en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) return null
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

/** Format one instant in one zone, in the reading order this surface uses. */
function formatIn(instant: number, timezone: string, options: Intl.DateTimeFormatOptions): string {
  // `en-US` throughout, matching the sidebar's own timestamps (`relative-time.ts`).
  return format(instant, timezone, 'en-US', options)
}

/**
 * `Intl.DateTimeFormat`, tolerating a zone it rejects — a stored zone this ICU no
 * longer knows must degrade to the machine's clock rather than throw inside a
 * render. The row says so in words either way, because `nextRunAfter` returns null
 * for that routine and the surface reads THAT, not this fallback.
 */
function format(
  instant: number,
  timezone: string,
  locale: string,
  options: Intl.DateTimeFormatOptions,
): string {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(new Date(instant))
  } catch {
    return new Intl.DateTimeFormat(locale, options).format(new Date(instant))
  }
}
