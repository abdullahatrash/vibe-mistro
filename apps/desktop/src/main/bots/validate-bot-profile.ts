import {
  BOT_COLOUR_MAX_LENGTH,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  hasBotControlCharacter,
} from '../../shared/bot-limits'
import type { BotProfileFiles, BotProfileSource } from './bot-profile'
import { isMistroBotProfileId } from './profile-id'

/**
 * The validation Vibe will not do for us (#424, #445; ADR-0027).
 *
 * **Vibe validates nothing we write.** `AgentProfile.from_toml` pops the four
 * keys it knows and sweeps every remaining key into `overrides` — so an unknown
 * or misspelled key is silently ignored: the profile loads, appears as a mode,
 * "works", and quietly lacks the setting. The one thing Vibe DOES reject
 * (`system_prompt_id` naming a `.md` that isn't there) it rejects by dropping
 * the profile entirely, with no error over ACP and only a `WARNING` in
 * `~/.vibe/logs/vibe.log`. A bad profile is indistinguishable from an absent
 * one on the wire.
 *
 * So we validate BEFORE writing, and refuse to write at all on a problem. Two
 * layers, both pure:
 *
 * - `validateBotProfileSource` — the record: is this something a profile can be
 *   made of, and is the profile id ours?
 * - `validateBotProfileFiles` — the rendered output: does every emitted key
 *   exist in Vibe's schema, is `agent_type` still `agent`, and does
 *   `system_prompt_id` name the very `.md` we are about to write beside it?
 *
 * The second layer is the one that catches US: the record cannot introduce a
 * TOML key, but a future edit to the projection can, and this is the only thing
 * standing between that typo and a Bot that silently has no persona.
 */

/** One reason a record or its projection was refused, addressed to the user. */
export interface BotProfileProblem {
  /** The record field or TOML key at fault (`name`, `system_prompt_id`, …). */
  field: string
  message: string
}

export type BotProfileValidation = { ok: true } | { ok: false; problems: BotProfileProblem[] }

/**
 * The keys `AgentProfile.from_toml` consumes itself. Anything else lands in
 * `overrides` and is validated against `VibeConfigSchema` instead.
 */
const PROFILE_OWN_KEYS = new Set(['display_name', 'description', 'safety', 'agent_type'])

/**
 * The `VibeConfigSchema` override keys a Bot profile is allowed to set. An
 * allow-list, not a deny-list: the schema has ~80 fields and we deliberately
 * touch exactly one, because Model and reasoning effort write THROUGH to the
 * user's global `~/.vibe/config.toml` (#434) and a Bot must not do that.
 */
const PROFILE_OVERRIDE_KEYS = new Set(['system_prompt_id'])

/** `AgentSafety` (vibe/agents.py). Anything else raises on load and drops the profile. */
const PROFILE_SAFETY_VALUES = new Set(['safe', 'neutral', 'destructive', 'yolo'])

// The bounds and the control-character rule live in `shared/bot-limits` (#447) so
// the renderer's Bot form applies exactly what this validator enforces. Read them
// from there — deliberately NOT re-exported here, so there is one import path.

/** `#abc` … `#aabbccdd`. */
const BOT_COLOUR_HEX = /^#[0-9a-fA-F]{3,8}$/
/** A design-token / CSS colour keyword: `accent-orange`, `tomato`. */
const BOT_COLOUR_TOKEN = /^[a-z][a-z0-9-]*$/

/**
 * Validate the Bot's `colour` — the one field of the record that is purely OURS.
 * It never reaches Vibe, so neither profile layer above sees it; it goes into a
 * `NOT NULL` column and, from slice 3, into the sidebar mark's style. In a
 * module whose whole thesis is "we validate because nobody else will", leaving
 * the one field we fully own unbounded would be the odd one out. Bounded to a
 * hex colour or a lowercase token name, so it can never carry markup, break out
 * of a CSS declaration, or arrive as unbounded text.
 *
 * Kept separate from `validateBotProfileSource` because it is not part of the
 * profile projection at all — the split follows what the value is for.
 */
export function validateBotColour(colour: string): BotProfileValidation {
  if (typeof colour !== 'string' || !colour) {
    return { ok: false, problems: [{ field: 'colour', message: 'A Bot needs a colour.' }] }
  }
  if (colour.length > BOT_COLOUR_MAX_LENGTH) {
    return {
      ok: false,
      problems: [
        { field: 'colour', message: `A colour can be at most ${BOT_COLOUR_MAX_LENGTH} characters.` },
      ],
    }
  }
  if (!BOT_COLOUR_HEX.test(colour) && !BOT_COLOUR_TOKEN.test(colour)) {
    return {
      ok: false,
      problems: [
        {
          field: 'colour',
          message: `"${colour}" is not a hex colour (#rrggbb) or a colour token.`,
        },
      ],
    }
  }
  return { ok: true }
}

/**
 * Validate the RECORD. An empty `instructions` is deliberately allowed: the
 * writer still creates the `.md`, so `system_prompt_id` resolves and the profile
 * loads — a Bot with nothing to say is a product question, not a broken profile.
 */
export function validateBotProfileSource(source: BotProfileSource): BotProfileValidation {
  const problems: BotProfileProblem[] = []

  if (!isMistroBotProfileId(source.profileId)) {
    // The ownership gate. A foreign id here would mean writing over a profile
    // the user hand-wrote, which we never do — see `profile-id.ts`.
    problems.push({
      field: 'profileId',
      message: `"${source.profileId}" is not a Vibe Mistro profile id (mistro-bot-<uuid>).`,
    })
  }

  const name = source.name.trim()
  if (!name) {
    problems.push({ field: 'name', message: 'A Bot needs a name.' })
  } else if (name.length > BOT_NAME_MAX_LENGTH) {
    problems.push({
      field: 'name',
      message: `A name can be at most ${BOT_NAME_MAX_LENGTH} characters.`,
    })
  } else if (hasBotControlCharacter(name)) {
    problems.push({ field: 'name', message: 'A name cannot contain line breaks or control characters.' })
  }

  const description = source.description.trim()
  if (description.length > BOT_DESCRIPTION_MAX_LENGTH) {
    problems.push({
      field: 'description',
      message: `A description can be at most ${BOT_DESCRIPTION_MAX_LENGTH} characters.`,
    })
  } else if (hasBotControlCharacter(description)) {
    // It becomes the mode's one-line `description` over ACP; a newline there
    // would break the line the picker renders.
    problems.push({
      field: 'description',
      message: 'A description cannot contain line breaks or control characters.',
    })
  }

  if (source.instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    problems.push({
      field: 'instructions',
      message: `Instructions can be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters.`,
    })
  }

  return problems.length ? { ok: false, problems } : { ok: true }
}

/**
 * Validate the RENDERED files — the layer that catches a typo in the projection
 * itself. Parses the emitted TOML's top-level keys (our own single-line output,
 * so a line scan is exact) and checks:
 *
 * 1. every key is one Vibe actually reads — no silently-ignored setting;
 * 2. `agent_type` is `agent` — a `subagent` profile is dropped from
 *    `availableModes` with no signal whatsoever;
 * 3. `safety` is a real `AgentSafety` value — anything else fails the load;
 * 4. `system_prompt_id` is a BARE STEM naming the very `.md` we write beside it —
 *    Vibe appends the extension, and a missing target drops the whole profile.
 */
export function validateBotProfileFiles(files: BotProfileFiles): BotProfileValidation {
  const problems: BotProfileProblem[] = []
  const keys = parseTomlTopLevelKeys(files.agentToml)

  for (const [key, value] of keys) {
    if (!PROFILE_OWN_KEYS.has(key) && !PROFILE_OVERRIDE_KEYS.has(key)) {
      problems.push({
        field: key,
        message: `"${key}" is not a key Vibe reads — it would be silently ignored.`,
      })
      continue
    }
    if (key === 'agent_type' && unquote(value) !== 'agent') {
      problems.push({
        field: 'agent_type',
        message: 'A Bot profile must be agent_type = "agent"; a subagent is never offered as a mode.',
      })
    }
    if (key === 'safety' && !PROFILE_SAFETY_VALUES.has(unquote(value))) {
      problems.push({ field: 'safety', message: `"${unquote(value)}" is not a Vibe safety value.` })
    }
  }

  const promptId = keys.get('system_prompt_id')
  if (promptId === undefined) {
    problems.push({
      field: 'system_prompt_id',
      message: 'The profile names no system prompt, so the Bot would have no persona.',
    })
  } else {
    const stem = unquote(promptId)
    if (stem !== files.promptFileName.replace(/\.md$/, '')) {
      problems.push({
        field: 'system_prompt_id',
        message: `system_prompt_id "${stem}" does not name ${files.promptFileName}; Vibe would drop the profile.`,
      })
    }
    if (stem.endsWith('.md') || stem.includes('/') || stem.includes('\\')) {
      problems.push({
        field: 'system_prompt_id',
        message: 'system_prompt_id must be a bare file stem — Vibe adds the .md itself.',
      })
    }
  }

  if (!isMistroBotProfileId(files.profileId)) {
    problems.push({
      field: 'profileId',
      message: `"${files.profileId}" is not a Vibe Mistro profile id (mistro-bot-<uuid>).`,
    })
  }
  if (files.agentFileName !== `${files.profileId}.toml`) {
    // The ACP mode id IS the file stem, so a mismatch means the Bot's persisted
    // profileId would select a mode that doesn't exist.
    problems.push({
      field: 'agentFileName',
      message: `${files.agentFileName} does not match the profile id ${files.profileId}.`,
    })
  }

  return problems.length ? { ok: false, problems } : { ok: true }
}

/** Both layers at once — what the writer runs. */
export function validateBotProfile(
  source: BotProfileSource,
  files: BotProfileFiles,
): BotProfileValidation {
  const problems = [
    ...collectProblems(validateBotProfileSource(source)),
    ...collectProblems(validateBotProfileFiles(files)),
  ]
  return problems.length ? { ok: false, problems } : { ok: true }
}

/** The problems of a validation, or none. Handy for merging + for messages. */
export function collectProblems(result: BotProfileValidation): BotProfileProblem[] {
  return result.ok ? [] : result.problems
}

/** Render a validation's problems as the `problems: string[]` the IPC reply carries. */
export function describeProblems(problems: BotProfileProblem[]): string[] {
  return problems.map((p) => `${p.field}: ${p.message}`)
}

/**
 * The top-level `key = value` pairs of OUR emitted TOML. Not a general TOML
 * parser and not trying to be: the projection emits one flat key per line with
 * no tables or arrays, so anything else in this text is itself a defect worth
 * failing on. Comment and blank lines are skipped.
 */
function parseTomlTopLevelKeys(toml: string): Map<string, string> {
  const keys = new Map<string, string>()
  for (const raw of toml.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) {
      keys.set(line, '')
      continue
    }
    keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  return keys
}

/** Strip the surrounding quotes of a TOML basic string (and unescape the pairs we emit). */
function unquote(value: string): string {
  const inner = value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  return inner.replace(/\\(["\\])/g, '$1')
}

