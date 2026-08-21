import { BOT_PROFILE_HEADER, BOT_PROFILE_SAFETY, tomlString } from '../bots/bot-profile'
import { routineProfileIdFor } from '../../shared/bot-profile-id'

/**
 * The **routine-only profile** projection (#469, ADR-0028 part 4). PURE: a Bot's
 * profile id and name in, the exact text of one file out.
 *
 * A Bot already owns a Vibe agent profile — its persona. This is its second one,
 * worn only by a scheduled turn: the SAME system prompt, plus a `[tools.*]` block
 * whose entire job is to make Vibe **ask**.
 *
 * Why the gate has to be in a profile at all, and why this exact shape (all of it
 * measured, none of it preference — #458, re-verified at vibe-acp 2.24.3 in
 * `docs/acp-capture.md` §17):
 *
 *  - **A profile's `safety` enforces nothing.** It is presentation in Vibe's own
 *    TUI. A profile declaring itself safe ran shell commands and file writes with
 *    zero approval requests.
 *  - **The user's own config layer decides the baseline, and it only ever
 *    loosens.** One click on "Always allow" for a write, ever, in any thread,
 *    writes a permanent allow into `~/.vibe/config.toml` (#464). So a gate must be
 *    ASSERTED, never inherited — and an agent-profile layer sits above the user
 *    layer, which is what lets this repair an already-permissive machine.
 *  - **Denying the write TOOLS does not deny writing.** Permissions are scoped to
 *    tool names and Vibe has no effect-level notion of "writes", so with
 *    `write_file`/`edit` set to `never` the agent simply shells out. Hence the
 *    second half: shell set to `ask` with an **empty allowlist**, because emptying
 *    the list is what removes the schema defaults that let `echo … > file`
 *    through. Verified: under this profile `ls -la` — a schema-default allowlisted
 *    command — raised a permission request.
 *  - **The profile makes Vibe ask; `allowed-commands.ts` is the answer.** Neither
 *    half is sufficient: we can only refuse what we are asked about, and a list of
 *    allowed commands is worthless if nothing consults it.
 *
 * There is no second `.md`: `system_prompt_id` names the Bot's existing prompt
 * file, so a routine turn keeps the persona exactly. That also gives the gate a
 * free integrity check — if the Bot's `.md` is missing, Vibe drops this profile
 * whole (acp-capture §14.2), the mode cannot be selected, and the run refuses.
 */

/** The `[tools.*]` entries the gate consists of — the posture, as data. */
export interface RoutineGateEntry {
  /** The TOML table, e.g. `tools.bash`. */
  table: string
  key: string
  /** The exact TOML value text, so rendering and confirming compare identically. */
  value: string
}

/**
 * The gate, verbatim and in emission order.
 *
 * `never` on the two file-writing tools is the belt — those die inside Vibe with
 * no round trip. `ask` + `allowlist = []` on the shell is the braces, and the
 * empty list is the load-bearing half: a list from a higher config layer REPLACES
 * the lower one rather than merging into it, so `[]` wipes both the user's
 * allowlist and the class defaults.
 *
 * The tool names are Vibe's, read off the wire and off its own builtin profiles;
 * a name Vibe does not know would be ignored in silence (#424), which is exactly
 * what `confirmRoutineGate` refuses to let happen unnoticed. Re-verify them
 * against each Vibe minor by running `scripts/spike-routine-gate.ts`.
 */
export const ROUTINE_GATE: readonly RoutineGateEntry[] = [
  { table: 'tools.write_file', key: 'permission', value: '"never"' },
  { table: 'tools.edit', key: 'permission', value: '"never"' },
  { table: 'tools.bash', key: 'permission', value: '"ask"' },
  { table: 'tools.bash', key: 'allowlist', value: '[]' },
]

/** What the projection reads. A subset of `BotRecord`, so tests need no row. */
export interface RoutineProfileSource {
  /** The Bot's OWN profile id (`mistro-bot-<uuid>`) — the persona this gate wears. */
  botProfileId: string
  /** The Bot's display name, for a mode label a human can recognise. */
  botName: string
}

/** The rendered projection: one file name and its exact contents. */
export interface RoutineProfileFile {
  /** `mistro-routine-<uuid>` — the file stem AND the ACP mode id. */
  profileId: string
  /** The Bot profile id this gate belongs to. */
  botProfileId: string
  /** File name inside the user agents dir (`~/.vibe/agents/`). */
  agentFileName: string
  /** The complete profile TOML. */
  agentToml: string
}

/**
 * Render a Bot's routine profile, or null when the argument is not a Bot profile
 * id of ours. Pure — confirm the result before trusting it.
 */
export function projectRoutineProfile(source: RoutineProfileSource): RoutineProfileFile | null {
  const profileId = routineProfileIdFor(source.botProfileId)
  if (!profileId) return null
  return {
    profileId,
    botProfileId: source.botProfileId,
    agentFileName: `${profileId}.toml`,
    agentToml: renderRoutineProfileToml(source),
  }
}

/**
 * The profile TOML. Emitted one flat `key = value` per line under at most one
 * table header, which is what lets `parseRoutineProfileToml` read it back
 * exactly — the read-back is the only thing that can prove the gate is really on
 * disk in the shape we believe.
 */
export function renderRoutineProfileToml(source: RoutineProfileSource): string {
  const lines = [
    `# ${BOT_PROFILE_HEADER}`,
    `display_name = ${tomlString(`${source.botName.trim()} (routine)`)}`,
    `description = ${tomlString('Scheduled runs of this Bot. Every command is asked about.')}`,
    `agent_type = "agent"`,
    `safety = "${BOT_PROFILE_SAFETY}"`,
    // The Bot's OWN prompt stem: a routine turn is the same teammate, gated.
    `system_prompt_id = ${tomlString(source.botProfileId)}`,
  ]
  let table = ''
  for (const entry of ROUTINE_GATE) {
    if (entry.table !== table) {
      table = entry.table
      lines.push('', `[${table}]`)
    }
    lines.push(`${entry.key} = ${entry.value}`)
  }
  return `${lines.join('\n')}\n`
}
