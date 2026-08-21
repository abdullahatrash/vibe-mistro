/**
 * Bots domain of the shared IPC contract (#445, ADR-0027): the CRUD surface over
 * the **Mistro Bot** record — a named, continuing teammate that is ONE durable
 * Thread inside a Workspace, whose persona is a Vibe agent profile we generate.
 *
 * The record here is the SOURCE OF TRUTH; the two files under `~/.vibe/agents/`
 * and `~/.vibe/prompts/` are a projection of it that main writes on every
 * create/update and destroys on delete. Keep this file free of Node/DOM imports
 * so both sides can consume it.
 */

/** The bots channel entries, merged into the single `IPC` const in `./index`. */
export const botsChannels = {
  /** List every Bot, newest-active first — see {@link BotsListResult}. */
  botsList: 'bots:list',
  /** Create a Bot: mint its Thread + profile id, write its profile, insert the record. */
  botsCreate: 'bots:create',
  /** Edit a Bot in place and rewrite its profile files. NEVER changes `profileId`. */
  botsUpdate: 'bots:update',
  /** Delete a Bot: destroy the identity + its profile files, ARCHIVE its Thread. */
  botsDelete: 'bots:delete',
} as const

/**
 * One Mistro Bot, as persisted (ADR-0027). `threadId` IS the Bot's identity — a
 * Bot is one continuing Thread, so there is no second id — and `workspaceId` is
 * the Project it cannot exist without.
 *
 * `profileId` is the load-bearing field: `mistro-bot-<uuid>`, minted ONCE and
 * **immutable across renames** (the live session has it selected as a mode id,
 * so changing it would break a running Bot), prefixed so it can never shadow a
 * Vibe builtin mode. It is DURABLE because Mode does not survive `session/load`
 * and ADR-0007's re-assert cache is in-memory by design — without persistence a
 * Bot reopened after a restart is a nameless agent with no persona.
 */
export interface BotRecord {
  /** The Bot's durable Thread — its identity and primary key. */
  threadId: string
  /** The Project the Bot lives in. A Bot cannot exist without one. */
  workspaceId: string
  /** `mistro-bot-<uuid>`. Minted once; never rewritten by an edit. */
  profileId: string
  /** The teammate's name, shown in the sidebar and written as `display_name`. */
  name: string
  /** The sidebar mark's colour, as authored by the user (e.g. `#e8734a`). */
  colour: string
  /** One line about the Bot; becomes the profile's `description`. */
  description: string
  /** The persona proper — rendered verbatim into the Bot's system-prompt `.md`. */
  instructions: string
  createdAt: number
  updatedAt: number
}

/** The `bots:list` reply. */
export interface BotsListResult {
  bots: BotRecord[]
}

/**
 * Args for `bots:create`. Main mints the `threadId` and the `profileId` — the
 * renderer never supplies either, so a Bot can only ever carry an id we made.
 */
export interface BotsCreateArgs {
  workspaceId: string
  name: string
  colour: string
  description?: string
  instructions?: string
}

/**
 * Args for `bots:update`. Omitted fields are left alone. `profileId` is absent by
 * design: a rename rewrites `display_name` only, never the id the live session
 * has selected.
 */
export interface BotsUpdateArgs {
  threadId: string
  name?: string
  colour?: string
  description?: string
  instructions?: string
}

/** Args for `bots:delete`. The conversation survives as an archived Thread. */
export interface BotsDeleteArgs {
  threadId: string
}

/**
 * Why a Bot write was refused. `invalid` = the record would produce a profile
 * Vibe silently ignores (we validate because Vibe never will — #424); `notFound`
 * = no such Bot; `io` = the profile files or the record could not be written.
 */
export type BotWriteFailure = 'invalid' | 'notFound' | 'io'

/**
 * The reply to `bots:create` / `bots:update`. Failure is LOUD and typed rather
 * than thrown — `problems` carries the human-readable validation messages so the
 * form (slice 2) can show exactly what Vibe would have swallowed.
 */
export type BotWriteResult =
  | { ok: true; bot: BotRecord }
  | { ok: false; reason: BotWriteFailure; problems: string[] }

/** The reply to `bots:delete`. Best-effort: `ok:false` means nothing was removed. */
export interface BotsDeleteResult {
  ok: boolean
}
