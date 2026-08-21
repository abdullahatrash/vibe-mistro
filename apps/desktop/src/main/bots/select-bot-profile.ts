import type { ThreadAgentControls } from '../../shared/ipc'
import { BOT_PROFILE_ABSENT_REASON } from './assess-bot-profile'

/**
 * Selecting a Mistro Bot's persona on the session its Thread just bound to (#446,
 * ADR-0027 decision 3): "a Vibe agent profile ... selected on bind via the mode
 * axis".
 *
 * This has to happen on EVERY bind, not once at creation: Mode does not survive
 * `session/load`, and ADR-0007's re-assert cache is in-memory by design — so a Bot
 * reopened after a restart would answer as a nameless agent with no persona if the
 * profile weren't re-selected here.
 *
 * The plan is pure so the interesting question — *when is a persona missing rather
 * than merely unselected?* — is decided in a unit test rather than against a live
 * binary. The applier is the thin half.
 */

/** What a bind must do about a Bot's persona. */
export type BotProfilePlan =
  /** Nothing to do: not a Bot, or the session already has the persona selected. */
  | { kind: 'satisfied' }
  /** Select `profileId` on the mode axis. */
  | { kind: 'select'; profileId: string }
  /**
   * The session does not offer this profile as a mode. Vibe re-scans `~/.vibe/agents/`
   * on every `session/new` AND every `session/load` (acp-capture §14.6), so a profile
   * absent from a FRESH session result means the FILE is gone or unreadable — not a
   * timing race. Sending it anyway would earn a `-32602`; reporting it is strictly
   * more useful, and it is what raises the rebuild banner (#448).
   */
  | { kind: 'missing'; profileId: string; reason: string }

/**
 * May a Bot's first prompt bind to the Workspace's eager PRIMARY session (ADR-0012),
 * or must it mint a fresh one?
 *
 * ADR-0012 opens one `session/new` at connect and lets a draft's first prompt claim
 * it instead of minting a second. That is right for every ordinary Thread and wrong
 * for a Bot created AFTER the connect: the primary session's mode list was built by
 * a registry scan that predates the profile, so the persona can never be selected on
 * it — and the Bot would answer its whole first conversation as a plain agent, which
 * is exactly the silent failure ADR-0027 forbids. A fresh `session/new` re-scans
 * (acp-capture §14.6), so minting one is the fix, at the cost of one extra session in
 * the one case that needs it.
 *
 * Null `primaryControls` (no primary session opened, or a best-effort failure) also
 * declines: we cannot show the persona is selectable there, and for a Bot the safe
 * direction is the fresh scan.
 */
export function mayClaimPreopenedSession(
  profileId: string | null,
  primaryControls: ThreadAgentControls | null,
): boolean {
  if (!profileId) return true // an ordinary Thread always takes ADR-0012's session
  return primaryControls?.modes?.availableModes.some((mode) => mode.id === profileId) ?? false
}

/**
 * Decide what this bind owes the Bot's persona.
 *
 * `controls` are the session's REPORTED agent controls — non-null whenever the bind
 * produced a fresh `session/new` / `session/load` result, and null on a plain reuse
 * of an already-hosted session. A reuse is `satisfied`: the session was bound
 * earlier in this same run, which is precisely when the persona was already
 * selected on it. That holds because `mayClaimPreopenedSession` above keeps a Bot
 * off any session that could not host its persona in the first place.
 */
export function planBotProfileSelection(
  profileId: string | null,
  controls: ThreadAgentControls | null,
): BotProfilePlan {
  if (!profileId) return { kind: 'satisfied' } // an ordinary Thread
  if (!controls) return { kind: 'satisfied' } // reuse — selected on the earlier bind
  const modes = controls.modes
  if (!modes) {
    // DELIBERATE divergence from the open-path check (`assess-bot-profile.ts`),
    // which reads the same condition as `unknown` and stays quiet. The difference
    // is what each side is holding: here we have a session result in hand and are
    // about to prompt it, so "this session cannot carry the persona" is a fact
    // about the turn the user is starting. There, an agent that has reported no
    // modes has told us nothing about which profiles exist.
    return {
      kind: 'missing',
      profileId,
      reason: 'this session advertises no modes, so no agent profile can be selected',
    }
  }
  if (modes.currentModeId === profileId) return { kind: 'satisfied' }
  if (!modes.availableModes.some((mode) => mode.id === profileId)) {
    // The SAME condition the banner reports, so it uses the same words — one
    // broken profile must not be described two ways by the notice and the banner
    // the notice raises.
    return { kind: 'missing', profileId, reason: BOT_PROFILE_ABSENT_REASON }
  }
  return { kind: 'select', profileId }
}

/** The one agent call this needs: the VALIDATING mode setter. */
export interface BotProfileModeAgent {
  /**
   * `session/set_config_option` with `configId: "mode"` where the session advertises
   * it — which VALIDATES (`-32602` on an unknown id), unlike `session/set_mode`,
   * which answers a bogus id with `{}`: a silent no-op indistinguishable from
   * success (#427). `WorkspaceAgent.setMode` already routes this way.
   */
  setMode(sessionId: string, modeId: string): Promise<void>
}

/** The outcome of {@link applyBotProfile} — a failure is a message, never a throw. */
export type BotProfileOutcome =
  | { ok: true; selected: string | null }
  | { ok: false; message: string }

/**
 * Carry out a plan. Never rejects: a Bot whose persona could not be selected must
 * still get its turn, but it must NOT get it silently — the message is surfaced to
 * the renderer on `thread:bound` and logged in main.
 */
export async function applyBotProfile(
  agent: BotProfileModeAgent,
  sessionId: string,
  plan: BotProfilePlan,
): Promise<BotProfileOutcome> {
  if (plan.kind === 'satisfied') return { ok: true, selected: null }
  if (plan.kind === 'missing') {
    return { ok: false, message: botProfileMissingMessage(plan.profileId, plan.reason) }
  }
  try {
    await agent.setMode(sessionId, plan.profileId)
    return { ok: true, selected: plan.profileId }
  } catch (err) {
    return {
      ok: false,
      message:
        `This Bot's persona (${plan.profileId}) was rejected by the agent: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        'It is answering with its default instructions.',
    }
  }
}

/** The copy for a persona the session never offered — one place, so it stays honest. */
function botProfileMissingMessage(profileId: string, reason: string): string {
  return (
    `This Bot's persona (${profileId}) could not be selected: ${reason}. ` +
    'It is answering with its default instructions.'
  )
}
