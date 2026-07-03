import { isProtected } from './agent-protection'

/**
 * The three eviction-protection signals (TB5 #50) as ONE stateful unit — previously a
 * scatter of module globals + free functions in index.ts (`activeAgentId`,
 * `inFlightTurns`, `signingInAgents`, `beginTurn`/`endTurn`/`beginAuth`/`endAuth`),
 * whose invariants lived in prose. The protection DECISION stays the pure
 * `isProtected` (agent-protection.ts); this class only does the bookkeeping and
 * feeds it live state.
 *
 * - ACTIVE: the agentId of the Workspace currently ON SCREEN, reported by the
 *   renderer via `setActiveAgent`. Null when the selection has no warm agent.
 *   Single-window assumption (see index.ts `window-all-closed`).
 * - TURNS: agents with a prompt turn IN FLIGHT, by agentId -> open-turn count. A
 *   count (not a flag) tolerates overlapping prompts; the entry is removed when it
 *   hits zero so the map can't leak.
 * - AUTH: agents with a sign-in flow IN PROGRESS. A delegated browser OAuth can pend
 *   longer than `IDLE_EVICT_MS` while the user is on another Workspace, so the agent
 *   is shielded for the flow's whole duration (a one-shot `touch` wouldn't suffice).
 */
export class AgentActivity {
  private active: string | null = null
  private readonly inFlightTurns = new Map<string, number>()
  private readonly signingIn = new Set<string>()

  setActive(agentId: string | null): void {
    this.active = agentId
  }

  beginTurn(agentId: string): void {
    this.inFlightTurns.set(agentId, (this.inFlightTurns.get(agentId) ?? 0) + 1)
  }

  endTurn(agentId: string): void {
    const next = (this.inFlightTurns.get(agentId) ?? 0) - 1
    if (next > 0) this.inFlightTurns.set(agentId, next)
    else this.inFlightTurns.delete(agentId)
  }

  beginAuth(agentId: string): void {
    this.signingIn.add(agentId)
  }

  endAuth(agentId: string): void {
    this.signingIn.delete(agentId)
  }

  /** An evicted/stopped agent holds no turn count (mirrors the eviction cleanup). */
  evict(agentId: string): void {
    this.inFlightTurns.delete(agentId)
  }

  /** The pool's eviction-protection predicate: NEVER evict on-screen / mid-turn / mid-sign-in. */
  isProtected(agentId: string): boolean {
    return isProtected(agentId, {
      activeAgentId: this.active,
      inFlightTurns: this.inFlightTurns,
      signingInAgents: this.signingIn,
    })
  }
}
