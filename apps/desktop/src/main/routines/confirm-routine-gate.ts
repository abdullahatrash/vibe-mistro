import { isMistroBotProfileId, isMistroRoutineProfileId } from '../../shared/bot-profile-id'
import { ROUTINE_GATE, type RoutineProfileFile } from './routine-profile'

/**
 * **Verify the gate took** (#469, ADR-0028: "a routine whose gate cannot be
 * confirmed must refuse to run, and say why").
 *
 * This is the most important module in the slice, and the reason it exists is a
 * measured property of Vibe rather than caution: **a profile key Vibe does not
 * recognise is ignored in silence** (#424) — no error, no warning, nothing on the
 * wire. Misspell `permission` as `permisson` and you get a profile that loads,
 * appears in every mode picker, "works", and gates nothing. The routine then runs
 * unattended with a posture nobody has, and looks correctly configured while it
 * does it.
 *
 * So the gate is never assumed from the fact that a write returned. It is read
 * back off disk and CONFIRMED, key by key and value by value, against
 * `ROUTINE_GATE`. Three things this catches that nothing else does:
 *
 *  1. a typo introduced by a future edit to the projection (the case #424 makes
 *     invisible);
 *  2. a file that is not the one we think we wrote — hand-edited, half-written, or
 *     the write silently landing somewhere else;
 *  3. an extra key that crept in and would be ignored, which is how a gate erodes
 *     one well-meaning addition at a time.
 *
 * It is deliberately NOT a TOML parser. Our projection emits one flat
 * `key = value` per line under at most one table header, so a line scan is exact
 * over the input it is fed — and anything more exotic in that text is itself the
 * defect, which is why an unparseable line is a refusal rather than a skip.
 *
 * Pure and total: text in, problems out.
 */

/** One reason a gate was refused, addressed to whoever has to fix it. */
export interface RoutineGateProblem {
  /** The dotted key path at fault (`tools.bash.allowlist`), or the file itself. */
  field: string
  message: string
}

export type RoutineGateValidation = { ok: true } | { ok: false; problems: RoutineGateProblem[] }

/**
 * The top-level keys a routine profile may set. `display_name` / `description` /
 * `safety` / `agent_type` are the four Vibe consumes itself; `system_prompt_id`
 * is the ONE `VibeConfigSchema` override the Bots slice already allows.
 */
const ALLOWED_TOP_LEVEL = new Set([
  'display_name',
  'description',
  'safety',
  'agent_type',
  'system_prompt_id',
])

/**
 * The widening this slice makes to that allow-list, stated as the exact dotted
 * paths rather than as "the `tools` table" (#469: *by exactly the keys needed*).
 * `tools` is `dict[str, dict[str, Any]]` on Vibe's side and validated by nothing,
 * so an allow-list of four paths is the only thing standing between a future edit
 * and a silently ignored setting.
 */
const ALLOWED_GATE_PATHS = new Set(ROUTINE_GATE.map((entry) => `${entry.table}.${entry.key}`))

/** `AgentSafety`. Anything else raises on load and drops the profile whole. */
const SAFETY_VALUES = new Set(['safe', 'neutral', 'destructive', 'yolo'])

/**
 * Read our own emitted TOML back into dotted paths. Returns null for a line it
 * cannot account for — see the module note: unparseable means refuse, never skip.
 */
export function parseRoutineProfileToml(toml: string): Map<string, string> | null {
  const keys = new Map<string, string>()
  let table = ''
  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      if (!line.endsWith(']')) return null
      table = line.slice(1, -1).trim()
      if (!table) return null
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) return null
    const key = line.slice(0, eq).trim()
    if (!key) return null
    keys.set(table ? `${table}.${key}` : key, line.slice(eq + 1).trim())
  }
  return keys
}

/**
 * Confirm that this TOML text IS the gate for `expected`.
 *
 * Every check is stated as a refusal, because the caller's only correct response
 * to any of them is to refuse the run:
 *
 * 1. the file parses as our own flat emission;
 * 2. every key in it is one Vibe reads AND one we meant to write — an unknown key
 *    is the silent-ignore case, and an unexpected known key means this is not the
 *    file we think it is;
 * 3. every `ROUTINE_GATE` entry is present with EXACTLY its value — a gate with
 *    three of its four entries is not three-quarters of a gate;
 * 4. `agent_type` is `agent` (a subagent profile is filtered out of the mode list
 *    with no wire signal at all, so the routine could never select it);
 * 5. `safety` is a real value (anything else fails the load and drops the file);
 * 6. `system_prompt_id` names the BOT's prompt, so a routine turn wears the same
 *    persona a person talks to — and so a routine can never be pointed at somebody
 *    else's system prompt.
 */
export function confirmRoutineGate(
  toml: string,
  expected: { profileId: string; botProfileId: string },
): RoutineGateValidation {
  const problems: RoutineGateProblem[] = []

  if (!isMistroRoutineProfileId(expected.profileId)) {
    problems.push({
      field: 'profileId',
      message: `"${expected.profileId}" is not a routine profile id (mistro-routine-<uuid>).`,
    })
  }
  if (!isMistroBotProfileId(expected.botProfileId)) {
    problems.push({
      field: 'system_prompt_id',
      message: `"${expected.botProfileId}" is not a Bot profile id (mistro-bot-<uuid>).`,
    })
  }

  const keys = parseRoutineProfileToml(toml)
  if (!keys) {
    return {
      ok: false,
      problems: [
        ...problems,
        {
          field: 'file',
          message: 'The routine profile on disk is not the flat TOML this app writes.',
        },
      ],
    }
  }

  for (const key of keys.keys()) {
    if (ALLOWED_TOP_LEVEL.has(key) || ALLOWED_GATE_PATHS.has(key)) continue
    problems.push({
      field: key,
      message: `"${key}" is not a key this app writes — Vibe would ignore it in silence.`,
    })
  }

  for (const entry of ROUTINE_GATE) {
    const path = `${entry.table}.${entry.key}`
    const actual = keys.get(path)
    if (actual === undefined) {
      problems.push({ field: path, message: `The permission gate is missing ${path}.` })
    } else if (actual !== entry.value) {
      problems.push({
        field: path,
        message: `${path} is ${actual}, not ${entry.value} — the permission gate would not hold.`,
      })
    }
  }

  const agentType = unquote(keys.get('agent_type') ?? '')
  if (agentType !== 'agent') {
    problems.push({
      field: 'agent_type',
      message: 'A routine profile must be agent_type = "agent"; a subagent is never offered as a mode.',
    })
  }

  const safety = unquote(keys.get('safety') ?? '')
  if (!SAFETY_VALUES.has(safety)) {
    problems.push({ field: 'safety', message: `"${safety}" is not a Vibe safety value.` })
  }

  const promptId = keys.get('system_prompt_id')
  if (promptId === undefined) {
    problems.push({
      field: 'system_prompt_id',
      message: 'The routine profile names no system prompt, so the Bot would have no persona.',
    })
  } else if (unquote(promptId) !== expected.botProfileId) {
    problems.push({
      field: 'system_prompt_id',
      message:
        `system_prompt_id "${unquote(promptId)}" is not this Bot's prompt ` +
        `(${expected.botProfileId}).`,
    })
  }

  return problems.length ? { ok: false, problems } : { ok: true }
}

/** Confirm a projection before it is written — the same rules, one call earlier. */
export function validateRoutineProfileFile(file: RoutineProfileFile): RoutineGateValidation {
  const problems = gateProblems(
    confirmRoutineGate(file.agentToml, {
      profileId: file.profileId,
      botProfileId: file.botProfileId,
    }),
  )
  if (file.agentFileName !== `${file.profileId}.toml`) {
    // The ACP mode id IS the file stem, so a mismatch means the routine would
    // select a mode that does not exist.
    problems.push({
      field: 'agentFileName',
      message: `${file.agentFileName} does not match the profile id ${file.profileId}.`,
    })
  }
  return problems.length ? { ok: false, problems } : { ok: true }
}

/** The problems of a validation, or none. */
export function gateProblems(result: RoutineGateValidation): RoutineGateProblem[] {
  return result.ok ? [] : result.problems
}

/** Render problems as the `string[]` a failure message carries. */
export function describeGateProblems(problems: RoutineGateProblem[]): string[] {
  return problems.map((problem) => `${problem.field}: ${problem.message}`)
}

/** Strip the surrounding quotes of a TOML basic string (and unescape the pairs we emit). */
function unquote(value: string): string {
  const inner = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return inner.replace(/\\(["\\])/g, '$1')
}
