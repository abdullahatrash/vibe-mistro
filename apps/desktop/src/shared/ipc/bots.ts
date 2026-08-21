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
  /**
   * List every Bot, most-recently-EDITED first — see {@link BotsListResult}.
   * NOT conversation activity: this orders by the record's own `updatedAt`, which
   * moves on a rename and never on a turn. The sidebar's "which Bot I spoke to
   * most recently" (PRD user story 5) needs the Thread's `lastActiveAt` instead;
   * slice 3 must join, not reuse this ordering.
   */
  botsList: 'bots:list',
  /** Create a Bot: mint its Thread + profile id, write its profile, insert the record. */
  botsCreate: 'bots:create',
  /** Edit a Bot in place and rewrite its profile files. NEVER changes `profileId`. */
  botsUpdate: 'bots:update',
  /** Delete a Bot: destroy the identity + its profile files, ARCHIVE its Thread. */
  botsDelete: 'bots:delete',
  /**
   * "Start over" (#447): retire the Bot's ACP session so its NEXT prompt mints a
   * fresh one. A pressure valve, not a delete — the record, both profile files and
   * the whole transcript are untouched, so the Bot keeps its name, its persona and
   * a readable history of everything it has already said.
   */
  botsStartOver: 'bots:start-over',
  /**
   * Is this Bot's persona still there? (#448) Asked when the Bot is OPENED —
   * before any prompt — because "the profile file went missing" must never be
   * discovered by the Bot silently answering as a plain agent. See
   * {@link BotProfileStatus}.
   */
  botsProfileStatus: 'bots:profile-status',
  /**
   * Re-write a Bot's profile files from its record — the banner's repair action.
   * The record is the source of truth and the files are a projection (ADR-0027),
   * so a rebuild is just that projection run again.
   */
  botsRebuildProfile: 'bots:rebuild-profile',
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
 * Bot reopened after a restart is a nameless Thread with no persona and no signal.
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
  /**
   * The sidebar mark's colour: a hex colour (`#e8734a`) or a lowercase colour
   * token. Validated in main (`validateBotColour`) — it never reaches Vibe, so
   * it is the one field of the record only WE bound.
   */
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

/** Args for `bots:start-over`. Addressed by the Bot's durable Thread, like every Bot op. */
export interface BotsStartOverArgs {
  threadId: string
}

/**
 * Why a "Start over" was refused. `notFound` = that Thread is not a Bot;
 * `streaming` = a turn is in flight, and retiring the session under a running turn
 * would strand it; `io` = the session cursor could not be cleared.
 */
export type BotStartOverFailure = 'notFound' | 'streaming' | 'io'

/**
 * The reply to `bots:start-over`. Typed failure rather than a throw, like every
 * other Bot write — the header shows what happened instead of the Bot silently
 * continuing on the session the user asked to leave behind.
 */
export type BotsStartOverResult = { ok: true } | { ok: false; reason: BotStartOverFailure }

/** Args for `bots:profile-status`: which Bot, and on which Workspace agent. */
export interface BotsProfileStatusArgs {
  threadId: string
  /** The Workspace agent whose advertised modes answer the question. */
  agentId: string
}

/**
 * Whether a Bot's persona is still selectable on its Workspace's agent (#448).
 *
 * Answered by DIFFING the Bot's expected `profileId` against the modes the agent
 * last advertised, never by waiting for an error: a broken profile (hand-deleted
 * TOML, malformed TOML, missing prompt `.md`) is indistinguishable from an absent
 * one over the wire — Vibe drops it at registry scan with only a log line (#424,
 * acp-capture §14.6). The absence IS the signal.
 *
 * `unknown` is the deliberate third answer, and the reason this is not a boolean:
 * the app must not accuse a profile it has no fresh reading for. No agent, no
 * session yet, or a profile WRITTEN since the last registry scan (creating a Bot
 * on an already-warm agent) all land here, and say nothing to the user.
 */
export type BotProfileStatus =
  | { kind: 'healthy' }
  | { kind: 'unknown' }
  | { kind: 'missing'; profileId: string; reason: string }

/** Args for `bots:rebuild-profile`: the Bot whose files to re-project. */
export interface BotsRebuildProfileArgs {
  threadId: string
}
