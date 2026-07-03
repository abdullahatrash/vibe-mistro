/**
 * The pure core of the composer's unified autocomplete (quality-review slice 4a): the
 * `/` slash-command and `@` file-path popovers were once two mirrored state machines
 * (twin trigger/index/dismiss state, twin refresh/accept fns, two keyboard blocks). They
 * are ONE machine over an ordered list of {@link CompletionSource}s — this module owns the
 * DOM-free heart of it: given each source's live trigger detection plus its per-source
 * Esc-dismiss latch, pick the single open source (priority = array order) and report which
 * sources just opened (their lazy `onOpen` should fire) and the next latch array.
 *
 * Mutual exclusion falls out of the priority scan: two sources CAN both detect a trigger
 * (e.g. `/foo@bar` at a line start matches both), and the earlier source in the array wins
 * — replacing the old hand-rolled `showPaths = !showCommands && …` gate. A source whose
 * latch equals its current trigger start stays closed (Esc stays dismissed as you keep
 * typing), so a later source can win in its place.
 *
 * Kept side-effect-free so it unit-tests as plain data (`autocomplete-machine.test.ts`)
 * while `use-composer-autocomplete.tsx` keeps the React state + DOM wiring.
 */

/** A source's live trigger: where its token starts and the query up to the caret. `null`
 *  when the source doesn't detect an active token at the current value + caret. */
export interface Detection {
  start: number
  query: string
}

/** The single open source the machine picked, or null when none qualifies. */
export interface ActiveTrigger {
  sourceIndex: number
  start: number
  query: string
}

export interface Resolution {
  /** The one source to open (first eligible by priority), or null. */
  winner: ActiveTrigger | null
  /** The next per-source Esc-dismiss latch array (parallel to `detections`). */
  dismissed: Array<number | null>
  /** Indices of every source that became eligible this pass — fire their `onOpen`. */
  opened: number[]
}

/**
 * Resolve the machine for one edit/caret move. Walks the sources in priority (array) order:
 *
 * - No detection → clear that source's latch (a later `/` or `@` reopens fresh).
 * - Detected but its latch still equals the token start → stay dismissed (Esc holds as the
 *   query grows), latch untouched; the source neither opens nor wins.
 * - Detected on a new/different token → clear the latch, mark it opened, and take it as the
 *   winner if none earlier claimed the slot.
 *
 * Every eligible source is reported in `opened` (not just the winner) so a source hidden
 * behind a higher-priority one still fires its lazy `onOpen` — matching the old code, where
 * the `@` listing fetch kicked off even when the `/` popover was the visible one.
 */
export function resolveAutocomplete(
  detections: ReadonlyArray<Detection | null>,
  dismissed: ReadonlyArray<number | null>,
): Resolution {
  const nextDismissed: Array<number | null> = []
  const opened: number[] = []
  let winner: ActiveTrigger | null = null
  for (let i = 0; i < detections.length; i++) {
    const detection = detections[i]
    if (!detection) {
      nextDismissed[i] = null
      continue
    }
    if (dismissed[i] === detection.start) {
      // Still the Esc-dismissed token — stay closed as the query grows, latch held.
      nextDismissed[i] = dismissed[i] ?? null
      continue
    }
    nextDismissed[i] = null
    opened.push(i)
    if (winner === null) {
      winner = { sourceIndex: i, start: detection.start, query: detection.query }
    }
  }
  return { winner, dismissed: nextDismissed, opened }
}
