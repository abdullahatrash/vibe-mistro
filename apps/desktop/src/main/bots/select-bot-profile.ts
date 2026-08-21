import type { ThreadAgentControls } from '../../shared/ipc'

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
   * on every `session/new`, so an absent profile means the FILE is gone or unreadable
   * — not a timing race. Sending it anyway would earn a `-32602`; reporting it is
   * strictly more useful, and slice 4 turns this into the rebuild banner.
   */
  | { kind: 'missing'; profileId: string; reason: string }

/**
 * Decide what this bind owes the Bot's persona.
 *
 * `controls` are the session's REPORTED agent controls — non-null whenever the bind
 * produced a fresh `session/new` / `session/load` result, and null on a plain reuse
 * of an already-hosted session. A reuse is `satisfied`: the session was bound
 * earlier in this same run, which is precisely when the persona was already
 * selected on it.
 */
export function planBotProfileSelection(
  profileId: string | null,
  controls: ThreadAgentControls | null,
): BotProfilePlan {
  if (!profileId) return { kind: 'satisfied' } // an ordinary Thread
  if (!controls) return { kind: 'satisfied' } // reuse — selected on the earlier bind
  const modes = controls.modes
  if (!modes) {
    return {
      kind: 'missing',
      profileId,
      reason: 'this session advertises no modes, so no agent profile can be selected',
    }
  }
  if (modes.currentModeId === profileId) return { kind: 'satisfied' }
  if (!modes.availableModes.some((mode) => mode.id === profileId)) {
    return {
      kind: 'missing',
      profileId,
      reason: 'Vibe does not list it as an agent profile — its profile file is missing or unreadable',
    }
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
