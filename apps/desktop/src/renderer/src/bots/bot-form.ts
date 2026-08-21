import type { BotRecord, BotsCreateArgs, BotsUpdateArgs } from '../../../shared/ipc'
import {
  BOT_COLOUR_MAX_LENGTH,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  hasBotControlCharacter,
} from '../../../shared/bot-limits'

/**
 * The Bot create/edit form, as data (#447, ADR-0027). Pure — no React, no IPC — so
 * what the form ACCEPTS, what it REFUSES and what it SENDS are settled in a unit
 * test rather than by clicking through the app.
 *
 * The division of labour with main is deliberate. Main is the validator: it refuses
 * a record that would project a profile Vibe silently ignores, and its `problems`
 * are shown verbatim. This module applies the rules BOTH sides share
 * (`shared/bot-limits` — the four bounds and the control-character rule) one step
 * earlier, so the user learns about a 61-character name while typing it instead of
 * after a round trip. Main still checks more than this does — `validateBotColour`'s
 * hex/token pattern has no counterpart here, because the form only ever emits
 * palette entries — so a refusal it alone catches lands in the `problems` strip.
 *
 * Two things it will not do:
 * - **Move a Bot between Projects.** `BotsUpdateArgs` has no `workspaceId` and that
 *   is not an oversight: the live ACP session is bound to one `cwd`, so a Bot that
 *   changed Project mid-conversation would be answering about files it has never
 *   seen. The Project is chosen once, at creation.
 * - **Change the profile id.** It is not a form field at all — a rename rewrites
 *   `display_name` only, because the running session has that id selected as its
 *   mode (ADR-0027).
 */

/** Which shape the outlet's form is in — and, for an edit, whose Bot it is. */
export type BotFormTarget =
  | { mode: 'create'; workspaceId: string | null }
  | { mode: 'edit'; threadId: string }

/** The four fields the form edits, plus the Project a create must pick. */
export interface BotFormValues {
  name: string
  colour: string
  /** The Project. Fixed after creation — see the module note. */
  workspaceId: string
  description: string
  instructions: string
}

/** Per-field messages, keyed by the field that is at fault. Empty = submittable. */
export type BotFormErrors = Partial<Record<keyof BotFormValues, string>>

/**
 * The default mark colour for a new Bot, and the palette the form offers. Hex, so
 * it renders identically wherever the mark appears and passes `validateBotColour`.
 * Six is enough to tell teammates apart at a glance without turning the form into
 * a colour picker.
 */
export const BOT_COLOURS = ['#e8734a', '#4a90d9', '#3fa87a', '#b26bd6', '#d94a6a', '#c9a227'] as const

export const DEFAULT_BOT_COLOUR = BOT_COLOURS[0]

/**
 * The form's starting values. A create seeds the Project from the current
 * selection (the Bot you are most likely to want is one for the project you are
 * looking at) and picks the colour least recently used, so two Bots made in a row
 * do not look alike. An edit seeds every field from the record.
 */
export function initialBotFormValues(args: {
  target: BotFormTarget
  bots: readonly BotRecord[]
}): BotFormValues {
  const target = args.target
  if (target.mode === 'edit') {
    const bot = args.bots.find((b) => b.threadId === target.threadId)
    if (bot) {
      return {
        name: bot.name,
        colour: bot.colour,
        workspaceId: bot.workspaceId,
        description: bot.description,
        instructions: bot.instructions,
      }
    }
    // A record that vanished under the form (deleted in another window): fall
    // through to an empty create-shaped form rather than rendering stale values.
    return emptyValues('')
  }
  return {
    ...emptyValues(target.workspaceId ?? ''),
    colour: nextBotColour(args.bots),
  }
}

/**
 * The colour a new Bot gets: the first palette entry no existing Bot is using, so
 * two Bots made in a row never look alike. Once every colour is taken it falls back
 * to the default and colours simply repeat — a duplicate is a cosmetic collision
 * between teammates you can already tell apart by name, and the user can pick any
 * other swatch in the form.
 */
export function nextBotColour(bots: readonly BotRecord[]): string {
  const taken = new Set(bots.map((bot) => bot.colour))
  return BOT_COLOURS.find((colour) => !taken.has(colour)) ?? DEFAULT_BOT_COLOUR
}

/**
 * What is wrong with these values, per field. The bounds are `shared/bot-limits`,
 * the same ones main enforces.
 *
 * `description` and `instructions` are optional by design: a Bot with nothing to
 * say is a product question, not a broken profile (the writer still creates the
 * `.md`, so the profile loads). `workspaceId` is not optional — a Bot cannot exist
 * without a Project (ADR-0027 decision 2).
 */
export function validateBotForm(values: BotFormValues): BotFormErrors {
  const errors: BotFormErrors = {}
  const name = values.name.trim()
  if (!name) errors.name = 'A Bot needs a name.'
  else if (name.length > BOT_NAME_MAX_LENGTH) {
    errors.name = `A name can be at most ${BOT_NAME_MAX_LENGTH} characters.`
  } else if (hasBotControlCharacter(name)) {
    errors.name = 'A name cannot contain line breaks.'
  }

  if (!values.workspaceId) errors.workspaceId = 'A Bot lives in a project — pick one.'

  if (!values.colour) errors.colour = 'A Bot needs a colour.'
  else if (values.colour.length > BOT_COLOUR_MAX_LENGTH) {
    errors.colour = `A colour can be at most ${BOT_COLOUR_MAX_LENGTH} characters.`
  }

  const description = values.description.trim()
  if (description.length > BOT_DESCRIPTION_MAX_LENGTH) {
    errors.description = `A description can be at most ${BOT_DESCRIPTION_MAX_LENGTH} characters.`
  } else if (hasBotControlCharacter(description)) {
    // It becomes the mode's one-line `description` over ACP.
    errors.description = 'A description is one line — no line breaks.'
  }

  if (values.instructions.length > BOT_INSTRUCTIONS_MAX_LENGTH) {
    errors.instructions = `Instructions can be at most ${BOT_INSTRUCTIONS_MAX_LENGTH} characters.`
  }
  return errors
}

/** Whether the form may be submitted at all. */
export function canSubmitBotForm(values: BotFormValues): boolean {
  return Object.keys(validateBotForm(values)).length === 0
}

/** The `bots:create` payload for these values. Trimmed exactly as main will store it. */
export function botCreateArgs(values: BotFormValues): BotsCreateArgs {
  return {
    workspaceId: values.workspaceId,
    name: values.name.trim(),
    colour: values.colour,
    description: values.description.trim(),
    instructions: values.instructions,
  }
}

/**
 * The `bots:update` payload for these values. Carries every editable field (main
 * merges by presence, and sending all four keeps the record and the profile files
 * one write apart) — but never `workspaceId` and never a profile id, neither of
 * which the contract accepts.
 */
export function botUpdateArgs(threadId: string, values: BotFormValues): BotsUpdateArgs {
  return {
    threadId,
    name: values.name.trim(),
    colour: values.colour,
    description: values.description.trim(),
    instructions: values.instructions,
  }
}

/**
 * Whether an edit changed anything worth writing. Used to keep Save honest: a
 * no-op edit should not rewrite the profile files (and so should not claim the
 * "takes effect on your next message" promise either).
 */
export function isBotFormDirty(values: BotFormValues, bot: BotRecord): boolean {
  return (
    values.name.trim() !== bot.name ||
    values.colour !== bot.colour ||
    values.description.trim() !== bot.description ||
    values.instructions !== bot.instructions
  )
}

function emptyValues(workspaceId: string): BotFormValues {
  return {
    name: '',
    colour: DEFAULT_BOT_COLOUR,
    workspaceId,
    description: '',
    instructions: '',
  }
}
