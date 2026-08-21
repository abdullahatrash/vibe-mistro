import { isMistroBotProfileId } from '../../../shared/bot-profile-id'
import type { ThreadModes } from '../../../shared/ipc'

/**
 * Keep Mistro Bot personas out of an ordinary Thread's Mode picker (#448,
 * ADR-0027 / the ADR-0007 amendment).
 *
 * A Bot's persona is a Vibe agent profile, and every profile is published over
 * ACP as a selectable mode — so without this every Bot a user owns would appear
 * in every Thread's approval-posture list, beside `ask` and `plan`. Hiding them
 * Vibe-side is impossible: `_is_primary_mode` re-derives from `build_mode_state`,
 * so the presentation filter IS the authorization gate (#424). The filter is
 * therefore client-side and deliberate.
 *
 * It is a departure from display-from-session-state, recorded in ADR-0007: the
 * principle forbids INVENTING or STALING state, not presenting a known subset.
 * Nothing here fabricates a mode, and the ids removed are only ever ones we
 * minted ourselves — `mistro-bot-<uuid>` is a mechanical test, not a heuristic,
 * so a hand-written profile of the user's is never touched.
 *
 * A Bot's OWN conversation never reaches this: it is handed no modes at all
 * (`ConnectedWorkspace`), because a Bot's behaviour is its profile.
 */
export function modesWithoutBotProfiles(modes: ThreadModes | null): ThreadModes | null {
  if (!modes) return null
  const availableModes = modes.availableModes.filter((mode) => !isMistroBotProfileId(mode.id))
  // Nothing was filtered — the overwhelmingly common case, a user with no Bots.
  // Hand back the SAME object rather than a copy: a cheap fast path, not a
  // memoization guarantee (a user WITH Bots does get a fresh object per call).
  if (availableModes.length === modes.availableModes.length) return modes
  // Everything was filtered: a picker with nothing to pick is not a control, so
  // report the axis as unadvertised rather than rendering an empty menu. Only
  // reachable if an agent ever advertises no builtins at all — the function is
  // total either way.
  if (availableModes.length === 0) return null
  return { ...modes, availableModes }
}
