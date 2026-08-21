import { describe, expect, it } from 'vitest'
import { lateCoverageNote, promptWithCoverage } from './late-run'

/**
 * The half of "late" the AGENT is told (#470, ADR-0028 part 3): the coverage
 * period, inside the prompt, because "issues opened since 20 Aug" is a different
 * query from "issues opened since yesterday" and only the agent can act on it.
 */

const SLOT_21 = Date.UTC(2026, 7, 21, 7, 0) // 09:00 Europe/Berlin
const SLOT_20 = Date.UTC(2026, 7, 20, 7, 0)
const NOW = Date.UTC(2026, 7, 21, 10, 30) // 12:30 Europe/Berlin

describe('lateCoverageNote', () => {
  it('states the slot, the actual start and the period since the last run', () => {
    const note = lateCoverageNote({ dueAt: SLOT_21, lastRunAt: SLOT_20 }, 'Europe/Berlin', NOW)
    expect(note).toContain('due at 2026-08-21 09:00 (Europe/Berlin)')
    expect(note).toContain('starting now, at 2026-08-21 12:30 (Europe/Berlin)')
    expect(note).toContain('since its last run at 2026-08-20 09:00 (Europe/Berlin)')
  })

  it('says outright when the Routine has NEVER run, rather than implying a window', () => {
    const note = lateCoverageNote({ dueAt: SLOT_21, lastRunAt: null }, 'Europe/Berlin', NOW)
    expect(note).toContain('never run before')
    expect(note).not.toContain('last run at')
  })

  it('reads the wall clock in the Routine\'s OWN zone, not the machine\'s', () => {
    const note = lateCoverageNote({ dueAt: SLOT_21, lastRunAt: null }, 'Asia/Tokyo', NOW)
    expect(note).toContain('due at 2026-08-21 16:00 (Asia/Tokyo)')
  })

  it('degrades to UTC for a zone this ICU does not know, rather than throwing', () => {
    const note = lateCoverageNote({ dueAt: SLOT_21, lastRunAt: null }, 'Mars/Olympus', NOW)
    expect(note).toContain('(UTC)')
  })
})

describe('promptWithCoverage', () => {
  it('leaves an on-time prompt exactly as the user wrote it', () => {
    expect(promptWithCoverage('Triage the repo.', null, 'Europe/Berlin', NOW)).toBe('Triage the repo.')
  })

  it('appends the note, so the Routine\'s own instruction still leads', () => {
    const text = promptWithCoverage(
      'Triage the repo.',
      { dueAt: SLOT_21, lastRunAt: SLOT_20 },
      'Europe/Berlin',
      NOW,
    )
    expect(text.startsWith('Triage the repo.\n\n[Scheduled run — late]')).toBe(true)
  })
})
