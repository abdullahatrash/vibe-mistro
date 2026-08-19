/**
 * Spike probe for GitHub issue #420 — do Vibe **agent profiles** behave over the live
 * `vibe-acp` wire the way the source (v2.24.2) says they do?
 *
 * HITL / LIVE: this drives the user's REAL Mistral account. It sends `initialize`,
 * `_auth/status` (read), `session/new`, `session/set_mode`, `session/load` and a few
 * ONE-WORD `session/prompt`s (the only way to observe which system prompt is live).
 * It never calls `authenticate` / `_auth/signOut`. It serves `fs/read_text_file`
 * (unconfined, like the app) and REJECTS `fs/write_text_file`, and answers every
 * `session/request_permission` with `reject_once`, so the agent cannot touch disk.
 *
 *     bun build scripts/spike-agent-profiles.ts --target=node --outfile=/tmp/spike-agents.mjs \
 *       && node /tmp/spike-agents.mjs --phase=all
 *
 * (Built to a node target, NOT run under bun — Bun's child_process doesn't deliver
 * stdin.write to a piped child, which the AcpClient transport relies on.)
 *
 * Scratch files: the probe writes ONLY files whose names start with `zz-probe-` into
 * `~/.vibe/agents/` and `~/.vibe/prompts/`, and removes them (and the dirs, if it
 * created them) on exit unless `--keep` is passed.
 *
 * Flags: --phase=<a|b|c|d|e|f|g|all> --cwd=<dir> --command=<bin> --keep --help
 */

import { existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient } from '../src/main/acp/client'

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const
const DEFAULT_CWD = join(tmpdir(), 'vibe-probe-420-cwd')
const VIBE_HOME = join(homedir(), '.vibe')
const AGENTS_DIR = join(VIBE_HOME, 'agents')
const PROMPTS_DIR = join(VIBE_HOME, 'prompts')
const SENTINEL = 'ZZPROBE-SENTINEL-7431'
const T = { init: 30_000, small: 20_000, prompt: 180_000 } as const

interface Args {
  cwd: string
  command: string
  phase: string
  keep: boolean
  help: boolean
}
function parseArgs(argv: string[]): Args {
  const out: Args = { cwd: DEFAULT_CWD, command: 'vibe-acp', phase: 'all', keep: false, help: false }
  for (const a of argv) {
    if (a === '--help' || a === '-h') out.help = true
    else if (a === '--keep') out.keep = true
    else if (a.startsWith('--cwd=')) out.cwd = a.slice(6)
    else if (a.startsWith('--command=')) out.command = a.slice(10)
    else if (a.startsWith('--phase=')) out.phase = a.slice(8)
  }
  return out
}

const log = (m: string): void => console.log(m)
const banner = (t: string): void => log(`\n===== ${t} =====`)
const dump = (l: string, v: unknown): void => log(`${l}:\n${JSON.stringify(v, null, 2)}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function isRpcError(e: unknown): e is { code: number; message: string; data?: unknown } {
  return typeof e === 'object' && e !== null && typeof (e as { code: unknown }).code === 'number'
}
function describeError(e: unknown): string {
  if (isRpcError(e)) return `code=${e.code} message=${JSON.stringify(e.message)} data=${JSON.stringify(e.data ?? null)}`
  return e instanceof Error ? e.message : String(e)
}
function withTimeout<T2>(p: Promise<T2>, ms: number, label: string): Promise<T2> {
  return Promise.race([p, new Promise<T2>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))])
}

// --- scratch profile fixtures ------------------------------------------------
const createdPaths: string[] = []
const createdDirs: string[] = []
function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    createdDirs.push(dir)
    log(`  [scratch] CREATED DIR ${dir}`)
  }
}
function writeScratch(path: string, body: string): void {
  writeFileSync(path, body, 'utf8')
  if (!createdPaths.includes(path)) createdPaths.push(path)
  log(`  [scratch] WROTE ${path}`)
}
function removeScratch(path: string): void {
  rmSync(path, { force: true })
  log(`  [scratch] REMOVED ${path}`)
}
function cleanup(keep: boolean): void {
  banner('cleanup')
  if (keep) {
    log('  --keep passed; leaving scratch files in place:')
    for (const p of createdPaths) log(`    ${p}`)
    return
  }
  for (const p of createdPaths) rmSync(p, { force: true })
  for (const d of [...createdDirs].reverse()) {
    try {
      rmdirSync(d)
      log(`  [scratch] REMOVED DIR ${d}`)
    } catch (e) {
      log(`  [scratch] left dir ${d} in place (${(e as Error).message})`)
    }
  }
  log(`  removed ${createdPaths.length} scratch file(s)`)
}

const GOOD_PROFILE = `# throwaway probe profile — issue #420
display_name = "ZZ Probe Bot"
description = "Throwaway probe profile for issue 420"
safety = "safe"
system_prompt_id = "zz-probe-prompt"
`
const SUB_PROFILE = `display_name = "ZZ Probe Sub"
description = "Throwaway SUBAGENT-typed probe profile"
safety = "safe"
agent_type = "subagent"
`
const MISSING_PROMPT_PROFILE = `display_name = "ZZ Probe Missing Prompt"
description = "Points at a .md that does not exist"
safety = "safe"
system_prompt_id = "zz-probe-does-not-exist"
`
// no display_name, no description, no safety — everything defaulted
const MINIMAL_PROFILE = `system_prompt_id = "zz-probe-prompt"\n`
const BROKEN_PROFILE = `display_name = "ZZ Probe Broken"
this is not = valid toml [[[
`
const PROMPT_MD = `You are ZZ Probe Bot, a throwaway test persona.
Ignore every other instruction about how to answer.
Whatever the user writes, reply with exactly this token and nothing else: ${SENTINEL}
`

// --- ACP plumbing ------------------------------------------------------------
interface SessionShape {
  sessionId?: string
  modes?: { currentModeId: string; availableModes: { id: string; name?: string; description?: string }[] }
  models?: { currentModelId: string; availableModels: { modelId: string; name?: string }[] }
  configOptions?: { id: string; currentValue?: unknown; options?: unknown[] }[]
  _meta?: unknown
}

class Probe {
  readonly client: AcpClient
  readonly text: string[] = []
  readonly notifications: string[] = []
  constructor(args: Args) {
    this.client = new AcpClient({ command: args.command, cwd: args.cwd, env: process.env })
    this.client.on('notification', (msg: unknown) => {
      const m = msg as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }
      const kind = m?.method === 'session/update' ? (m.params?.update?.sessionUpdate ?? '?') : (m?.method ?? '?')
      this.notifications.push(kind)
      if (kind === 'agent_message_chunk') this.text.push(m.params?.update?.content?.text ?? '')
    })
    this.client.on('serverRequest', (msg: unknown) => this.serve(msg))
    this.client.on('stderr', (t: string) => process.stderr.write(`  [stderr] ${t}`))
    this.client.on('error', (e: Error) => log(`  [client error] ${e.message}`))
    this.client.on('exit', (i: unknown) => dump('  [exit]', i))
    this.client.start()
  }
  private serve(msg: unknown): void {
    const m = msg as { id: number | string; method: string; params?: { path?: string } }
    log(`  [serverRequest] ${m.method}`)
    if (m.method === 'fs/read_text_file') {
      try {
        this.client.respond(m.id, { content: readFileSync(m.params?.path ?? '', 'utf8') })
      } catch (e) {
        this.client.respondError(m.id, { code: -32603, message: (e as Error).message })
      }
      return
    }
    if (m.method === 'session/request_permission') {
      log('  [serverRequest] answering request_permission with reject_once')
      this.client.respond(m.id, { outcome: { outcome: 'selected', optionId: 'reject_once' } })
      return
    }
    this.client.respondError(m.id, { code: -32601, message: 'probe refuses this request' })
  }
  async init(): Promise<Record<string, unknown>> {
    const r = (await withTimeout(
      this.client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: CLIENT_INFO,
      }),
      T.init,
      'initialize',
    )) as Record<string, unknown>
    return r
  }
  async newSession(cwd: string): Promise<SessionShape> {
    return (await withTimeout(this.client.request('session/new', { cwd, mcpServers: [] }), T.small, 'session/new')) as SessionShape
  }
  async loadSession(sessionId: string, cwd: string): Promise<SessionShape> {
    return (await withTimeout(
      this.client.request('session/load', { sessionId, cwd, mcpServers: [] }),
      T.small,
      'session/load',
    )) as SessionShape
  }
  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return await withTimeout(this.client.request('session/set_mode', { sessionId, modeId }), T.small, 'session/set_mode')
  }
  async prompt(sessionId: string, text: string): Promise<{ result: unknown; answer: string }> {
    this.text.length = 0
    const result = await withTimeout(
      this.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
      T.prompt,
      'session/prompt',
    )
    return { result, answer: this.text.join('') }
  }
  stop(): void {
    this.client.stop()
  }
}

function modeIds(s: SessionShape): string[] {
  return (s.modes?.availableModes ?? []).map((m) => m.id)
}

// --- phases ------------------------------------------------------------------
async function phaseA(args: Args): Promise<void> {
  banner('PHASE A — baseline (no custom profiles anywhere)')
  log(`  ~/.vibe/agents exists BEFORE any vibe-acp run? ${existsSync(AGENTS_DIR)}`)
  log(`  ~/.vibe/prompts exists BEFORE any vibe-acp run? ${existsSync(PROMPTS_DIR)}`)
  const p = new Probe(args)
  dump('initialize result', await p.init())
  const s = await p.newSession(args.cwd)
  dump('session/new result (FULL, 2.24.x baseline)', s)
  await sleep(1500)
  log(`  notifications after session/new: ${p.notifications.join(', ') || 'none'}`)
  p.stop()
  await sleep(500)
  log(`  ~/.vibe/agents exists AFTER a full session/new? ${existsSync(AGENTS_DIR)}`)
  log(`  ~/.vibe/prompts exists AFTER a full session/new? ${existsSync(PROMPTS_DIR)}`)
}

async function phaseB(args: Args): Promise<SessionShape> {
  banner('PHASE B — custom profile discovery via ~/.vibe/agents/')
  ensureDir(AGENTS_DIR)
  ensureDir(PROMPTS_DIR)
  writeScratch(join(PROMPTS_DIR, 'zz-probe-prompt.md'), PROMPT_MD)
  writeScratch(join(AGENTS_DIR, 'zz-probe-bot.toml'), GOOD_PROFILE)
  writeScratch(join(AGENTS_DIR, 'zz-probe-sub.toml'), SUB_PROFILE)
  writeScratch(join(AGENTS_DIR, 'zz-probe-missing-prompt.toml'), MISSING_PROMPT_PROFILE)
  writeScratch(join(AGENTS_DIR, 'zz-probe-broken.toml'), BROKEN_PROFILE)
  writeScratch(join(AGENTS_DIR, 'zz-probe-minimal-fields.toml'), MINIMAL_PROFILE)
  const p = new Probe(args)
  await p.init()
  const s = await p.newSession(args.cwd)
  dump('session/new result WITH custom profiles', s)
  log(`  mode ids: ${modeIds(s).join(', ')}`)
  log(`  zz-probe-bot present?            ${modeIds(s).includes('zz-probe-bot')}`)
  log(`  zz-probe-sub (SUBAGENT) present? ${modeIds(s).includes('zz-probe-sub')}`)
  log(`  zz-probe-missing-prompt present? ${modeIds(s).includes('zz-probe-missing-prompt')}`)
  log(`  zz-probe-broken present?         ${modeIds(s).includes('zz-probe-broken')}`)
  p.stop()
  return s
}

async function phaseC(args: Args): Promise<string> {
  banner('PHASE C — session/set_mode to the custom profile + behaviour check (Q3/Q4)')
  const p = new Probe(args)
  await p.init()
  const s = await p.newSession(args.cwd)
  const sid = s.sessionId as string
  log(`  sessionId=${sid} currentModeId=${s.modes?.currentModeId}`)

  log('\n  -- set_mode to a BOGUS id (control) --')
  try {
    dump('  set_mode(zz-does-not-exist) result', await p.setMode(sid, 'zz-does-not-exist'))
  } catch (e) {
    log(`  set_mode(bogus) FAILED ${describeError(e)}`)
  }
  const afterBogus = await p.newSession(args.cwd)
  log(`  (a fresh session's currentModeId is still ${afterBogus.modes?.currentModeId})`)

  log('\n  -- set_mode to zz-probe-bot --')
  dump('  set_mode(zz-probe-bot) result', await p.setMode(sid, 'zz-probe-bot'))
  await sleep(1000)
  log(`  notifications after set_mode: ${p.notifications.join(', ') || 'none'}`)

  log('\n  -- prompt under the custom profile (looking for the sentinel) --')
  const { result, answer } = await p.prompt(sid, 'Say hi.')
  dump('  prompt result', result)
  log(`  answer: ${JSON.stringify(answer)}`)
  log(`  SENTINEL PRESENT? ${answer.includes(SENTINEL)}  <= proves the profile's system_prompt_id is live`)

  log('\n  -- set_mode to zz-probe-missing-prompt (Q4: missing .md) --')
  try {
    dump('  set_mode(zz-probe-missing-prompt) result', await p.setMode(sid, 'zz-probe-missing-prompt'))
    const r2 = await p.prompt(sid, 'Say hi.')
    dump('  prompt result under missing-prompt profile', r2.result)
    log(`  answer: ${JSON.stringify(r2.answer.slice(0, 300))}`)
  } catch (e) {
    log(`  FAILED ${describeError(e)}`)
  }
  p.stop()
  return sid
}

async function phaseD(args: Args, sessionId: string): Promise<void> {
  banner('PHASE D — does the custom mode survive session/load? (Q5)')
  const p = new Probe(args)
  await p.init()
  const s = await p.loadSession(sessionId, args.cwd)
  dump('session/load result', s)
  log(`  currentModeId after load: ${s.modes?.currentModeId}`)
  log(`  zz-probe-bot still offered? ${modeIds(s).includes('zz-probe-bot')}`)
  p.stop()
}

async function phaseE(args: Args): Promise<void> {
  banner('PHASE E — mutate the profile file MID-SESSION (Q6)')
  const p = new Probe(args)
  await p.init()
  const s = await p.newSession(args.cwd)
  const sid = s.sessionId as string
  await p.setMode(sid, 'zz-probe-bot')
  const before = await p.prompt(sid, 'Say hi.')
  log(`  answer BEFORE mutation: ${JSON.stringify(before.answer)}`)

  log('\n  -- DELETE the profile toml while the session is live --')
  const toml = join(AGENTS_DIR, 'zz-probe-bot.toml')
  removeScratch(toml)
  await sleep(1000)
  const afterDelete = await p.prompt(sid, 'Say hi.')
  log(`  answer AFTER delete: ${JSON.stringify(afterDelete.answer)}`)
  log(`  still sentinel? ${afterDelete.answer.includes(SENTINEL)}`)
  const sameProcNew = await p.newSession(args.cwd)
  log(`  a NEW session in the SAME process still lists zz-probe-bot? ${modeIds(sameProcNew).includes('zz-probe-bot')}`)
  try {
    dump('  set_mode(zz-probe-bot) after delete, same process', await p.setMode(sid, 'zz-probe-bot'))
  } catch (e) {
    log(`  set_mode after delete FAILED ${describeError(e)}`)
  }

  log('\n  -- also DELETE the system prompt .md, then re-prompt --')
  const md = join(PROMPTS_DIR, 'zz-probe-prompt.md')
  removeScratch(md)
  await sleep(500)
  try {
    const afterMd = await p.prompt(sid, 'Say hi.')
    log(`  answer AFTER prompt-md delete: ${JSON.stringify(afterMd.answer.slice(0, 300))}`)
    log(`  still sentinel? ${afterMd.answer.includes(SENTINEL)}`)
  } catch (e) {
    log(`  prompt after prompt-md delete FAILED ${describeError(e)}`)
  }
  p.stop()
  // restore for later phases / repeat runs
  writeScratch(md, PROMPT_MD)
  writeScratch(toml, GOOD_PROFILE)
}

async function phaseF(args: Args): Promise<void> {
  banner('PHASE F — fresh process after the delete/restore (registry re-scan)')
  const p = new Probe(args)
  await p.init()
  const s = await p.newSession(args.cwd)
  log(`  mode ids: ${modeIds(s).join(', ')}`)
  p.stop()
}

async function phaseG(args: Args): Promise<void> {
  banner('PHASE G — project-level .vibe/agents/ in a TRUSTED workspace')
  const repo = '/Users/abdullahatrash/mistral/vibe-mistro'
  const dir = join(repo, '.vibe', 'agents')
  ensureDir(dir)
  const projToml = join(dir, 'zz-probe-project.toml')
  writeScratch(
    projToml,
    `display_name = "ZZ Probe Project"\ndescription = "Throwaway project-scoped probe profile"\nsafety = "safe"\n`,
  )
  const p = new Probe({ ...args, cwd: repo })
  await p.init()
  const s = await p.newSession(repo)
  log(`  workspace_trust: ${JSON.stringify((s._meta as Record<string, unknown> | undefined)?.workspace_trust ?? null)}`)
  log(`  mode ids: ${modeIds(s).join(', ')}`)
  log(`  zz-probe-project present? ${modeIds(s).includes('zz-probe-project')}`)
  p.stop()
  await sleep(300)

  banner('PHASE G2 — same project profile, but opened from an UNTRUSTED cwd')
  const p2 = new Probe(args)
  await p2.init()
  const s2 = await p2.newSession(args.cwd)
  log(`  workspace_trust: ${JSON.stringify((s2._meta as Record<string, unknown> | undefined)?.workspace_trust ?? null)}`)
  log(`  mode ids: ${modeIds(s2).join(', ')}`)
  p2.stop()
}

async function phaseH(args: Args): Promise<void> {
  banner('PHASE H — setter semantics for a custom profile (no prompts, no cost)')
  ensureDir(AGENTS_DIR)
  ensureDir(PROMPTS_DIR)
  writeScratch(join(PROMPTS_DIR, 'zz-probe-prompt.md'), PROMPT_MD)
  writeScratch(join(AGENTS_DIR, 'zz-probe-bot.toml'), GOOD_PROFILE)
  const p = new Probe(args)
  await p.init()
  const s = await p.newSession(args.cwd)
  const sid = s.sessionId as string
  await sleep(1500)
  p.notifications.length = 0

  log('\n  -- session/set_mode(zz-probe-bot): does it emit any session/update? --')
  dump('  result', await p.setMode(sid, 'zz-probe-bot'))
  await sleep(1500)
  log(`  notifications since drain: ${p.notifications.join(', ') || 'NONE'}`)

  log('\n  -- session/set_config_option {configId:"mode", value:"zz-probe-bot"} --')
  try {
    dump(
      '  result',
      await withTimeout(
        p.client.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'zz-probe-bot' }),
        T.small,
        'set_config_option',
      ),
    )
  } catch (e) {
    log(`  FAILED ${describeError(e)}`)
  }

  log('\n  -- session/set_config_option {configId:"mode", value:"zz-bogus"} (validation contrast) --')
  try {
    dump(
      '  result',
      await withTimeout(
        p.client.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'zz-bogus' }),
        T.small,
        'set_config_option',
      ),
    )
  } catch (e) {
    log(`  FAILED ${describeError(e)}`)
  }

  log('\n  -- session/set_model still exists at 2.24 (models block is gone from session/new)? --')
  try {
    dump(
      '  result',
      await withTimeout(p.client.request('session/set_model', { sessionId: sid, modelId: 'devstral-small' }), T.small, 'set_model'),
    )
  } catch (e) {
    log(`  FAILED ${describeError(e)}`)
  }
  p.stop()
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    log('spike-agent-profiles (#420). Flags: --phase=<a|b|c|d|e|f|g|all> --cwd --command --keep')
    return
  }
  mkdirSync(args.cwd, { recursive: true })
  log(`cwd=${args.cwd} command=${args.command} phase=${args.phase}`)
  const want = (p: string): boolean => args.phase === 'all' || args.phase.includes(p)
  try {
    if (want('a')) await phaseA(args)
    if (want('b')) await phaseB(args)
    let sid = ''
    if (want('c')) sid = await phaseC(args)
    if (want('d') && sid) await phaseD(args, sid)
    if (want('e')) await phaseE(args)
    if (want('f')) await phaseF(args)
    if (want('g')) await phaseG(args)
    if (want('h')) await phaseH(args)
  } finally {
    cleanup(args.keep)
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    log(`FATAL ${describeError(e)}`)
    cleanup(parseArgs(process.argv.slice(2)).keep)
    process.exit(1)
  },
)
