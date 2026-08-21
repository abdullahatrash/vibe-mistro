import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { BotRecord } from '../../shared/ipc'
import type { BotInsert, BotPatch, BotStoreApi } from '../persistence/bot-store-api'
import {
  createBot,
  deleteBot,
  listBots,
  rebuildBotProfile,
  updateBot,
  type BotLifecycleDeps,
} from './bot-lifecycle'
import type { BotProfileSource } from './bot-profile'
import type { WriteBotProfileResult } from './write-bot-profile'

const PROFILE_ID = 'mistro-bot-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

/** An in-memory `BotStoreApi` — the lifecycle never needs a database to be tested. */
class FakeBotStore implements BotStoreApi {
  readonly rows = new Map<string, BotRecord>()
  failInsert = false
  failUpdate = false

  list(): BotRecord[] {
    return [...this.rows.values()]
  }
  listByWorkspace(workspaceId: string): BotRecord[] {
    return this.list().filter((b) => b.workspaceId === workspaceId)
  }
  get(threadId: string): BotRecord | null {
    return this.rows.get(threadId) ?? null
  }
  insert(input: BotInsert): BotRecord | null {
    if (this.failInsert) return null
    const record: BotRecord = { ...input, createdAt: 1, updatedAt: 1 }
    this.rows.set(record.threadId, record)
    return record
  }
  update(threadId: string, patch: BotPatch): BotRecord | null {
    if (this.failUpdate) return null
    const existing = this.rows.get(threadId)
    if (!existing) return null
    const next: BotRecord = { ...existing, ...patch, updatedAt: 2 }
    this.rows.set(threadId, next)
    return next
  }
  delete(threadId: string): boolean {
    return this.rows.delete(threadId)
  }
}

interface Harness {
  deps: BotLifecycleDeps
  bots: FakeBotStore
  written: BotProfileSource[]
  removed: string[]
  threads: { created: string[]; flags: Array<[string, { archived?: boolean }]> }
  writeResult: WriteBotProfileResult
  threadFailure: boolean
}

function harness(): Harness {
  const bots = new FakeBotStore()
  const h: Harness = {
    bots,
    written: [],
    removed: [],
    threads: { created: [], flags: [] },
    writeResult: { ok: true, profileId: PROFILE_ID },
    threadFailure: false,
    deps: {} as BotLifecycleDeps,
  }
  let threadSeq = 0
  h.deps = {
    bots,
    threads: {
      upsertThread: async ({ workspaceId }) => {
        if (h.threadFailure) throw new Error('FK violation')
        const id = `thread-${++threadSeq}-${workspaceId}`
        h.threads.created.push(id)
        return { id }
      },
      setThreadFlags: async (id, flags) => {
        h.threads.flags.push([id, flags])
      },
    },
    profiles: {
      write: async (source) => {
        if (h.writeResult.ok) h.written.push(source)
        return h.writeResult
      },
      remove: async (profileId) => {
        h.removed.push(profileId)
        return true
      },
    },
    mintProfileId: () => PROFILE_ID,
  }
  return h
}

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
})

describe('createBot', () => {
  it('mints a Thread + profile id, writes the profile, and persists the record', async () => {
    const h = harness()
    const result = await createBot(h.deps, {
      workspaceId: 'ws-1',
      name: 'Rex',
      colour: '#e8734a',
      description: 'Reviews my diffs',
      instructions: 'Read the diff first.',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bot).toMatchObject({
      workspaceId: 'ws-1',
      profileId: PROFILE_ID,
      name: 'Rex',
      colour: '#e8734a',
    })
    expect(result.bot.threadId).toBe(h.threads.created[0])
    expect(h.written).toHaveLength(1)
    expect(h.bots.get(result.bot.threadId)).not.toBeNull()
  })

  it('defaults an absent description/instructions rather than refusing', async () => {
    const h = harness()
    const result = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.bot.description).toBe('')
  })

  it('refuses an invalid record BEFORE anything is written or persisted', async () => {
    const h = harness()
    const result = await createBot(h.deps, { workspaceId: 'ws-1', name: '   ', colour: '#fff' })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.written).toHaveLength(0)
    expect(h.threads.created).toHaveLength(0)
    expect(h.bots.list()).toHaveLength(0)
  })

  it('refuses an out-of-shape colour, the one field only we bound', async () => {
    const h = harness()
    const result = await createBot(h.deps, {
      workspaceId: 'ws-1',
      name: 'Rex',
      colour: 'red; background: url(x)',
    })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(result.ok === false && result.problems.join(' ')).toContain('colour')
    expect(h.written).toHaveLength(0)
    expect(h.threads.created).toHaveLength(0)
  })

  it('refuses a Bot with no Project — a Bot cannot exist without one', async () => {
    const h = harness()
    const result = await createBot(h.deps, { workspaceId: '', name: 'Rex', colour: '#fff' })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.written).toHaveLength(0)
  })

  it('persists NOTHING when the profile files could not be written', async () => {
    const h = harness()
    h.writeResult = { ok: false, reason: 'io', problems: ['ENOSPC'] }
    const result = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })

    expect(result).toMatchObject({ ok: false, reason: 'io' })
    expect(h.threads.created).toHaveLength(0)
    expect(h.bots.list()).toHaveLength(0)
  })

  it('cleans up the files it just wrote when the record cannot be saved', async () => {
    const h = harness()
    h.bots.failInsert = true
    const result = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })

    expect(result).toMatchObject({ ok: false, reason: 'io' })
    expect(h.removed).toEqual([PROFILE_ID])
    expect(h.bots.list()).toHaveLength(0)
  })

  it('cleans up the files when the Thread cannot be created', async () => {
    const h = harness()
    h.threadFailure = true
    const result = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })

    expect(result).toMatchObject({ ok: false, reason: 'io' })
    expect(h.removed).toEqual([PROFILE_ID])
  })

  it('reports a foreign profile id as invalid, never as a silent success', async () => {
    const h = harness()
    h.deps.mintProfileId = () => 'ask'
    const result = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
  })
})

describe('updateBot', () => {
  async function created(h: Harness): Promise<BotRecord> {
    const result = await createBot(h.deps, {
      workspaceId: 'ws-1',
      name: 'Rex',
      colour: '#e8734a',
      description: 'Reviews my diffs',
      instructions: 'Read the diff first.',
    })
    if (!result.ok) throw new Error('setup failed')
    return result.bot
  }

  it('NEVER changes the profile id on a rename — the live session has it selected', async () => {
    const h = harness()
    const bot = await created(h)
    h.deps.mintProfileId = () => 'mistro-bot-11111111-2222-3333-4444-555555555555'

    const result = await updateBot(h.deps, { threadId: bot.threadId, name: 'Rexina' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bot.profileId).toBe(bot.profileId)
    expect(result.bot.name).toBe('Rexina')
    expect(h.written.at(-1)?.profileId).toBe(bot.profileId)
  })

  it('rewrites the profile files from the MERGED record, leaving untouched fields alone', async () => {
    const h = harness()
    const bot = await created(h)
    await updateBot(h.deps, { threadId: bot.threadId, instructions: 'Now also read the tests.' })

    expect(h.written.at(-1)).toMatchObject({
      name: 'Rex',
      description: 'Reviews my diffs',
      instructions: 'Now also read the tests.',
    })
  })

  it('refuses an out-of-shape colour on an edit, leaving the record untouched', async () => {
    const h = harness()
    const bot = await created(h)
    const result = await updateBot(h.deps, { threadId: bot.threadId, colour: 'javascript:alert(1)' })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.bots.get(bot.threadId)?.colour).toBe('#e8734a')
  })

  it('reports an unknown Bot as notFound', async () => {
    const h = harness()
    expect(await updateBot(h.deps, { threadId: 'nope', name: 'x' })).toMatchObject({
      ok: false,
      reason: 'notFound',
    })
  })

  it('refuses an edit that would produce a dud profile, leaving the record untouched', async () => {
    const h = harness()
    const bot = await created(h)
    const result = await updateBot(h.deps, { threadId: bot.threadId, name: '' })

    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(h.bots.get(bot.threadId)?.name).toBe('Rex')
  })

  it('does not claim a persona it never wrote when the file rewrite fails', async () => {
    const h = harness()
    const bot = await created(h)
    h.writeResult = { ok: false, reason: 'io', problems: ['ENOSPC'] }

    const result = await updateBot(h.deps, { threadId: bot.threadId, name: 'Rexina' })

    expect(result).toMatchObject({ ok: false, reason: 'io' })
    expect(h.bots.get(bot.threadId)?.name).toBe('Rex')
  })
})

describe('deleteBot', () => {
  it('drops the record, destroys both files, and ARCHIVES the conversation', async () => {
    const h = harness()
    const created = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })
    if (!created.ok) throw new Error('setup failed')

    const result = await deleteBot(h.deps, { threadId: created.bot.threadId })

    expect(result).toEqual({ ok: true })
    expect(h.bots.get(created.bot.threadId)).toBeNull()
    expect(h.removed).toEqual([PROFILE_ID])
    expect(h.threads.flags).toEqual([[created.bot.threadId, { archived: true }]])
  })

  it('is a no-op for an unknown Bot', async () => {
    const h = harness()
    expect(await deleteBot(h.deps, { threadId: 'nope' })).toEqual({ ok: false })
    expect(h.removed).toHaveLength(0)
  })

  it('still archives when the profile removal fails — a failure never wedges the delete', async () => {
    const h = harness()
    const created = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })
    if (!created.ok) throw new Error('setup failed')
    h.deps.profiles.remove = async () => {
      throw new Error('EPERM')
    }

    const result = await deleteBot(h.deps, { threadId: created.bot.threadId })
    expect(result).toEqual({ ok: true })
    expect(h.threads.flags).toEqual([[created.bot.threadId, { archived: true }]])
  })
})

describe('listBots', () => {
  it('reads straight through to the store', async () => {
    const h = harness()
    await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })
    expect(listBots(h.deps).map((b) => b.name)).toEqual(['Rex'])
  })
})

describe('rebuildBotProfile', () => {
  it('re-writes the profile files from the record, persona and id intact', async () => {
    const h = harness()
    const created = await createBot(h.deps, {
      workspaceId: 'ws-1',
      name: 'Rex',
      colour: '#fff',
      instructions: 'You know this project.',
    })
    if (!created.ok) throw new Error('setup failed')
    h.written.length = 0

    const rebuilt = await rebuildBotProfile(h.deps, { threadId: created.bot.threadId })

    expect(rebuilt.ok).toBe(true)
    expect(h.written).toEqual([
      {
        // The id the live session selected as a mode is NEVER re-minted.
        profileId: created.bot.profileId,
        name: 'Rex',
        description: '',
        instructions: 'You know this project.',
      },
    ])
  })

  it('re-stamps updatedAt, so the open-path check stops accusing the profile', async () => {
    // `assessBotProfile` only calls a profile missing when the agent's registry
    // reading is NEWER than the last write — so a rebuild must move that stamp.
    const h = harness()
    const created = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })
    if (!created.ok) throw new Error('setup failed')

    const rebuilt = await rebuildBotProfile(h.deps, { threadId: created.bot.threadId })

    if (!rebuilt.ok) throw new Error('rebuild failed')
    expect(rebuilt.bot.updatedAt).toBeGreaterThan(created.bot.updatedAt)
  })

  it('reports a write failure instead of claiming a repair', async () => {
    const h = harness()
    const created = await createBot(h.deps, { workspaceId: 'ws-1', name: 'Rex', colour: '#fff' })
    if (!created.ok) throw new Error('setup failed')
    h.writeResult = { ok: false, reason: 'io', problems: ['EACCES'] }

    const rebuilt = await rebuildBotProfile(h.deps, { threadId: created.bot.threadId })

    expect(rebuilt).toEqual({ ok: false, reason: 'io', problems: ['EACCES'] })
  })

  it('refuses an unknown Bot — there is no record to rebuild from', async () => {
    const h = harness()
    expect(await rebuildBotProfile(h.deps, { threadId: 'nope' })).toEqual({
      ok: false,
      reason: 'notFound',
      problems: ['No such Bot.'],
    })
  })
})
