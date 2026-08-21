/**
 * The **Routine** schedule value and the arithmetic over it (#467, ADR-0028
 * part 2 + part 6) — a structured `when`, never a cron string, and the ONE pure
 * module the firer and the missed-run detector both compute with.
 *
 * Two directions, and the second is the reason this file exists. ADR-0028 makes
 * *missed / late / never* **derived** rather than stored, so the detector has to
 * answer a question schedulers usually never ask — *when was this last due,
 * before now?* — from the stored schedule alone, sharing no code with the thing
 * that failed to fire. Forwards is `nextRunAfter`; backwards is
 * `expectedLastDue`; they are each other's inverse over the fire instants, which
 * is what makes the firer and the detector agree about time (see the round-trip
 * property in `schedule.test.ts`).
 *
 * **No date or cron dependency, deliberately.** Electron ships full ICU, so IANA
 * zones are `Intl`'s job; the PRD rejects adding a library to do arithmetic that
 * is a few lines here.
 *
 * The three DST rules of ADR-0028 part 2, which both functions obey because they
 * resolve every fire instant through the same `fireInstantOn`:
 *
 * 1. the scheduled hour happens TWICE (a fall-back) → fire at the **first**
 *    occurrence;
 * 2. the scheduled hour does NOT exist (a spring-forward) → fire at the **next
 *    valid local time** that day;
 * 3. a Routine fires **at most once per scheduled slot** — one instant per
 *    matching local date, by construction.
 *
 * Node/DOM-free like everything under `shared/`, so main, preload and the
 * renderer all compute the same answer.
 */

/** The schedule shapes a Routine can carry today. */
export type RoutineScheduleKind = 'daily' | 'weekdays' | 'weekly'

/** `0` = Sunday … `6` = Saturday — `Date.prototype.getDay`'s numbering. */
export type RoutineWeekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/**
 * A Routine's `when`, as a value.
 *
 * A DISCRIMINATED UNION on `kind`, which is the whole point (ADR-0028 part 2): a
 * `cron` variant can be added later as one more branch, with no migration and no
 * rewrite of the branches here — the stored JSON of the existing kinds does not
 * change shape. `weekly` requires its `weekday` at the type level, so a weekly
 * schedule with nothing to key on cannot be constructed.
 *
 * `at` is local wall-clock `HH:MM` (24-hour) **in `timezone`**, an IANA name
 * STORED with the Routine and defaulted to the machine's at creation. Following
 * the machine instead would make the same stored data mean different instants in
 * different places, which destroys the one property the detector needs.
 */
export type RoutineSchedule =
  | { kind: 'daily'; at: string; timezone: string }
  | { kind: 'weekdays'; at: string; timezone: string }
  | { kind: 'weekly'; at: string; weekday: RoutineWeekday; timezone: string }

/** `HH:MM`, 24-hour, zero-padded. Nothing else is a time of day here. */
const TIME_OF_DAY = /^([01][0-9]|2[0-3]):([0-5][0-9])$/

/**
 * How many local days either function will scan before giving up. A weekly
 * schedule needs 8; the headroom costs nothing (the scan stops at the first
 * match) and bounds the loop for a schedule whose kind can never match.
 */
const SCAN_DAY_LIMIT = 366

/** A civil date in some zone — no instant attached, no zone attached. */
interface CivilDate {
  year: number
  /** 1-12, not `Date`'s 0-11. */
  month: number
  day: number
}

/** A wall-clock reading in some zone: a civil date plus hours and minutes. */
interface LocalReading extends CivilDate {
  hours: number
  minutes: number
}

/** `HH:MM` → its parts, or null when it is not a time of day. */
export function parseTimeOfDay(at: string): { hours: number; minutes: number } | null {
  const match = typeof at === 'string' ? TIME_OF_DAY.exec(at) : null
  if (!match) return null
  return { hours: Number(match[1]), minutes: Number(match[2]) }
}

/**
 * Does `Intl` know this IANA zone? The validator's timezone check and the guard
 * both arithmetic functions open with — an unknown zone makes every instant
 * unanswerable, so it is refused at the door rather than thrown mid-flow.
 */
export function isSupportedTimezone(timezone: string): boolean {
  return zoneFormatter(timezone) !== null
}

/**
 * Is this parsed JSON a schedule we can carry? The guard the store reads rows
 * through, so a hand-edited or half-written row cannot enter the app as a
 * `RoutineSchedule` that then fails somewhere with no clue where it came from.
 *
 * STRUCTURAL only: it checks the shape and that `at` is a time of day, and it
 * deliberately does NOT ask `Intl` about the zone. Timezone acceptance is the
 * validator's job at write time; a stored zone this ICU no longer knows leaves a
 * readable, deletable, editable Routine that simply computes no next run —
 * which is a far better failure than a row that cannot be listed.
 */
export function isRoutineSchedule(value: unknown): value is RoutineSchedule {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { kind?: unknown; at?: unknown; timezone?: unknown; weekday?: unknown }
  if (typeof candidate.at !== 'string' || parseTimeOfDay(candidate.at) === null) return false
  if (typeof candidate.timezone !== 'string' || !candidate.timezone) return false
  switch (candidate.kind) {
    case 'daily':
    case 'weekdays':
      return true
    case 'weekly':
      return (
        typeof candidate.weekday === 'number' &&
        Number.isInteger(candidate.weekday) &&
        candidate.weekday >= 0 &&
        candidate.weekday <= 6
      )
    default:
      return false
  }
}

/**
 * The machine's IANA zone, for defaulting a NEW Routine's `timezone`. Read once
 * at creation and then stored — never consulted again for an existing Routine.
 */
export function machineTimezone(): string {
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
  return resolved && isSupportedTimezone(resolved) ? resolved : 'UTC'
}

/**
 * The first instant this schedule is due STRICTLY AFTER `from` — what the firer
 * asks, and what the UI shows as "next run".
 *
 * Null when the schedule cannot be computed with (a malformed `at`, a zone
 * `Intl` does not know, or no matching day inside {@link SCAN_DAY_LIMIT}):
 * best-effort per ADR-0019, so a corrupt row makes a Routine inert and loudly
 * un-schedulable rather than throwing into the tick.
 */
export function nextRunAfter(schedule: RoutineSchedule, from: number): number | null {
  return scan(schedule, from, 1)
}

/**
 * The most recent instant this schedule was due, AT OR BEFORE `now` — the
 * backwards computation ADR-0028 part 6 is built on. Compare it with the
 * Routine's `lastRunAt` and a missed run is a comparison rather than a flag
 * somebody had to remember to set.
 *
 * Inclusive of `now` on purpose: a fire instant is its own last-due, which is
 * exactly the round-trip property that makes the detector and the firer agree.
 *
 * Null for the same reasons as {@link nextRunAfter}.
 */
export function expectedLastDue(schedule: RoutineSchedule, now: number): number | null {
  return scan(schedule, now, -1)
}

/**
 * Walk local days from `pivot`'s own local date in `direction`, resolving each
 * matching day's fire instant, and answer with the first one on the right side
 * of `pivot`. ONE traversal for both directions so the two functions can never
 * disagree about a day, a kind or a DST rule.
 */
function scan(schedule: RoutineSchedule, pivot: number, direction: 1 | -1): number | null {
  const time = parseTimeOfDay(schedule.at)
  if (!time || !Number.isFinite(pivot)) return null
  const formatter = zoneFormatter(schedule.timezone)
  if (!formatter) return null

  let date: CivilDate = readLocal(pivot, formatter)
  for (let scanned = 0; scanned < SCAN_DAY_LIMIT; scanned += 1) {
    if (matchesKind(schedule, date)) {
      const instant = fireInstantOn(date, time.hours, time.minutes, formatter)
      if (instant !== null && (direction === 1 ? instant > pivot : instant <= pivot)) return instant
    }
    date = addDays(date, direction)
  }
  return null
}

/** Is this local date one the schedule fires on? */
function matchesKind(schedule: RoutineSchedule, date: CivilDate): boolean {
  switch (schedule.kind) {
    case 'daily':
      return true
    case 'weekdays':
      // Monday-Friday in the schedule's OWN zone, which is why the weekday is
      // read off the local civil date and never off the instant.
      return weekdayOf(date) >= 1 && weekdayOf(date) <= 5
    case 'weekly':
      return weekdayOf(date) === schedule.weekday
  }
}

/**
 * The instant a routine scheduled at `hours:minutes` fires on this local date —
 * where the three DST rules live.
 *
 * A wall-clock reading maps to **two** instants across a fall-back and to
 * **none** across a spring-forward, so:
 *
 * - two candidates → the EARLIER (rule 1). The later occurrence is never
 *   returned, which is also what gives rule 3: the second pass of a repeated
 *   hour is not a second slot.
 * - none → walk the local clock forward a minute at a time to the next reading
 *   that exists (rule 2), stopping at the end of the local day. A whole
 *   remaining day with no valid local time (a date-line shift, not a DST
 *   transition) yields null and the day is skipped, which keeps one instant per
 *   local date and keeps the day sequence strictly increasing.
 */
function fireInstantOn(
  date: CivilDate,
  hours: number,
  minutes: number,
  formatter: Intl.DateTimeFormat,
): number | null {
  for (let minuteOfDay = hours * 60 + minutes; minuteOfDay < 24 * 60; minuteOfDay += 1) {
    const candidates = instantsForLocal(
      { ...date, hours: Math.floor(minuteOfDay / 60), minutes: minuteOfDay % 60 },
      formatter,
    )
    if (candidates.length > 0) return Math.min(...candidates)
  }
  return null
}

/**
 * Every instant whose wall clock in this zone reads exactly `reading` — 1
 * normally, 2 inside a repeated hour, 0 inside a skipped one.
 *
 * The offset at the sought instant is unknown before we have the instant, so
 * every offset in force AROUND it is tried — a day either side, which brackets
 * any transition, plus the naive instant's own — and each resulting candidate is
 * VERIFIED by reading its wall clock back. Verification, not arithmetic, is what
 * makes the gap and the overlap answer honestly: probing only one side finds
 * just one of a repeated hour's two instants, and which one it finds depends on
 * the direction the zone shifted.
 */
function instantsForLocal(reading: LocalReading, formatter: Intl.DateTimeFormat): number[] {
  const naive = utcKey(reading)
  const candidates = new Set<number>()
  for (const probe of [naive - DAY_MS, naive, naive + DAY_MS]) {
    candidates.add(naive - offsetAt(probe, formatter))
  }
  const found: number[] = []
  for (const candidate of candidates) {
    if (utcKey(readLocalReading(candidate, formatter)) === naive) found.push(candidate)
  }
  return found
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The zone's offset from UTC at `instant`, in milliseconds: read the wall clock
 * there and measure how far it is from the same reading in UTC.
 */
function offsetAt(instant: number, formatter: Intl.DateTimeFormat): number {
  return utcKey(readLocalReading(instant, formatter)) - Math.floor(instant / 60_000) * 60_000
}

/**
 * A wall-clock reading as a comparable number: the same civil fields read as if
 * they were UTC. Only ever compared with another key from this function — it is
 * an ordering, not an instant.
 */
function utcKey(reading: LocalReading): number {
  return Date.UTC(reading.year, reading.month - 1, reading.day, reading.hours, reading.minutes)
}

/** The local civil date of an instant. */
function readLocal(instant: number, formatter: Intl.DateTimeFormat): CivilDate {
  const reading = readLocalReading(instant, formatter)
  return { year: reading.year, month: reading.month, day: reading.day }
}

/** The local wall-clock reading of an instant. */
function readLocalReading(instant: number, formatter: Intl.DateTimeFormat): LocalReading {
  const parts = formatter.formatToParts(new Date(instant))
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type)
    return part ? Number(part.value) : 0
  }
  const era = parts.find((part) => part.type === 'era')?.value
  const year = field('year')
  return {
    // `formatToParts` renders a BC year unsigned; nothing schedules there, but a
    // silently-positive year would make the ordering lie.
    year: era === 'B' ? 1 - year : year,
    month: field('month'),
    day: field('day'),
    // Some ICU builds render midnight as hour 24 of the previous day; h23 asks
    // for 0-23 and this is the belt to that pair of braces.
    hours: field('hour') % 24,
    minutes: field('minute'),
  }
}

/** The day after (or before) a civil date, carrying month and year properly. */
function addDays(date: CivilDate, delta: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + delta))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

/** A civil date's day of the week, 0 = Sunday — pure calendar, no zone involved. */
function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

/**
 * One `Intl.DateTimeFormat` per zone, cached — the scan reads a wall clock
 * several times per day it considers, and constructing a formatter is the
 * expensive half. Null (and cached as such) for a zone `Intl` rejects.
 */
const FORMATTERS = new Map<string, Intl.DateTimeFormat | null>()

function zoneFormatter(timezone: string): Intl.DateTimeFormat | null {
  if (typeof timezone !== 'string' || !timezone) return null
  const cached = FORMATTERS.get(timezone)
  if (cached !== undefined) return cached
  let formatter: Intl.DateTimeFormat | null
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      era: 'narrow',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    formatter = null // not a zone this ICU knows
  }
  FORMATTERS.set(timezone, formatter)
  return formatter
}
