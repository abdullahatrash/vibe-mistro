/**
 * Spike probe for GitHub issue #469 — the **Routine permission gate**.
 *
 * Two questions, both of which decide code in `src/main/routines/`:
 *
 *  1. Does a routine-only profile carrying `[tools.*]` blocks (file-writing tools
 *     `never`, shell `ask` with an EMPTY allowlist) actually force `vibe-acp` to
 *     ASK — over a user `config.toml` layer that otherwise auto-approves?
 *  2. What EXACTLY does the `session/request_permission` for a shell command carry,
 *     and what does the preceding `tool_call` update carry? The request itself is
 *     only a `toolCallId` (acp-capture §6/§15F), so the answerer has to recover the
 *     invocation from somewhere — this prints every candidate verbatim.
 *
 * HITL / LIVE: drives the user's REAL Mistral account with two short prompts. It
 * answers EVERY `session/request_permission` with `reject_once` and REFUSES
 * `fs/write_text_file`, so the agent cannot touch disk through us.
 *
 * ISOLATION — nothing of the user's is written:
 *  - `VIBE_HOME` is a scratch dir under `$TMPDIR`; the real `~/.vibe/config.toml` is
 *    only READ, and copied in so the gate is tested against a permissive user layer.
 *  - the workspace `cwd` is a scratch dir under `$TMPDIR`.
 *  - profiles are named `zz-probe-*` and live in the scratch home.
 *
 *     bun build scripts/spike-routine-gate.ts --target=node --outfile=/tmp/spike-gate.mjs \
 *       && node /tmp/spike-gate.mjs
 *
 * (Built to a node target, NOT run under bun — Bun's child_process doesn't deliver
 * stdin.write to a piped child, which the AcpClient transport relies on.)
 *
 * Flags: --keep --command=<bin> --help
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AcpClient } from '../src/main/acp/client'

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const
const T = { init: 30_000, small: 20_000, prompt: 180_000 } as const

const log = (m: string): void => console.log(m)
const banner = (t: string): void => log(`\n===== ${t} =====`)
const dump = (l: string, v: unknown): void => log(`${l}:\n${JSON.stringify(v, null, 2)}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
function withTimeout<T2>(p: Promise<T2>, ms: number, label: string): Promise<T2> {
  return Promise.race([
    p,
    new Promise<T2>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

const keep = process.argv.includes('--keep')
const command = process.argv.find((a) => a.startsWith('--command='))?.slice(10) ?? 'vibe-acp'
if (process.argv.includes('--help')) {
  log('usage: node /tmp/spike-gate.mjs [--keep] [--command=vibe-acp]')
  process.exit(0)
}

// --- scratch home + workspace -------------------------------------------------
const scratchHome = mkdtempSync(join(tmpdir(), 'zz-probe-469-home-'))
const scratchCwd = mkdtempSync(join(tmpdir(), 'zz-probe-469-cwd-'))
const agentsDir = join(scratchHome, 'agents')
const promptsDir = join(scratchHome, 'prompts')
mkdirSync(agentsDir, { recursive: true })
mkdirSync(promptsDir, { recursive: true })

const realConfig = join(homedir(), '.vibe', 'config.toml')
if (existsSync(realConfig)) {
  copyFileSync(realConfig, join(scratchHome, 'config.toml'))
  log(`  [scratch] copied the user's config.toml into ${scratchHome} (read-only on the original)`)
} else {
  log('  [scratch] no ~/.vibe/config.toml to copy — running against a pristine home')
}

const PROMPT_MD = `You are ZZ Probe Bot, a throwaway test persona for issue 469.\n`
writeFileSync(join(promptsDir, 'zz-probe-prompt.md'), PROMPT_MD, 'utf8')

/** The shipped Bot profile shape (slice 1) — no tools block at all. */
const UNGATED = `display_name = "ZZ Probe Ungated"
description = "The Bot profile as slice 1 writes it"
agent_type = "agent"
safety = "neutral"
system_prompt_id = "zz-probe-prompt"
`

/** The candidate ROUTINE profile: the gate this slice writes. */
const GATED = `display_name = "ZZ Probe Routine"
description = "Routine gate candidate for issue 469"
agent_type = "agent"
safety = "neutral"
system_prompt_id = "zz-probe-prompt"

[tools.write_file]
permission = "never"

[tools.edit]
permission = "never"

[tools.bash]
permission = "ask"
allowlist = []
`

writeFileSync(join(agentsDir, 'zz-probe-ungated.toml'), UNGATED, 'utf8')
writeFileSync(join(agentsDir, 'zz-probe-routine.toml'), GATED, 'utf8')

function cleanup(): void {
  banner('cleanup')
  if (keep) {
    log(`  --keep: leaving ${scratchHome} and ${scratchCwd}`)
    return
  }
  rmSync(scratchHome, { recursive: true, force: true })
  rmSync(scratchCwd, { recursive: true, force: true })
  log('  scratch home + cwd removed')
}

// --- ACP plumbing -------------------------------------------------------------
interface SessionShape {
  sessionId?: string
  modes?: { currentModeId?: string; availableModes?: { id: string }[] }
}

class Probe {
  readonly client: AcpClient
  readonly permissions: unknown[] = []
  readonly toolCalls: unknown[] = []
  cancelOnFirstDenial = false
  constructor() {
    this.client = new AcpClient({
      command,
      cwd: scratchCwd,
      env: { ...process.env, VIBE_HOME: scratchHome },
    })
    this.client.on('notification', (msg: unknown) => {
      const m = msg as { method?: string; params?: { update?: { sessionUpdate?: string } } }
      const kind = m?.params?.update?.sessionUpdate
      if (kind === 'tool_call' || kind === 'tool_call_update') {
        this.toolCalls.push(m.params?.update)
        dump(`  [${kind}]`, m.params?.update)
      }
    })
    this.client.on('serverRequest', (msg: unknown) => this.serve(msg))
    this.client.on('stderr', (t: string) => process.stderr.write(`  [stderr] ${t}`))
    this.client.on('error', (e: Error) => log(`  [client error] ${e.message}`))
    this.client.start()
  }
  private serve(msg: unknown): void {
    const m = msg as { id: number | string; method: string; params?: { path?: string } }
    if (m.method === 'fs/read_text_file') {
      try {
        this.client.respond(m.id, { content: readFileSync(m.params?.path ?? '', 'utf8') })
      } catch (e) {
        this.client.respondError(m.id, { code: -32603, message: (e as Error).message })
      }
      return
    }
    if (m.method === 'fs/write_text_file') {
      log('  [serverRequest] fs/write_text_file — probe REFUSES')
      this.client.respondError(m.id, { code: -32603, message: 'probe refuses to write' })
      return
    }
    if (m.method === 'session/request_permission') {
      this.permissions.push(m.params)
      dump(`  >>> PERMISSION #${this.permissions.length} (VERBATIM)`, m.params)
      this.client.respond(m.id, { outcome: { outcome: 'selected', optionId: 'reject_once' } })
      // The behaviour this slice depends on: the FIRST denial cancels the turn.
      if (this.cancelOnFirstDenial) {
        const sessionId = (m.params as { sessionId?: string } | undefined)?.sessionId
        if (sessionId) {
          log('  >>> first denial — sending session/cancel')
          this.client.notify('session/cancel', { sessionId })
        }
      }
      return
    }
    this.client.respondError(m.id, { code: -32601, message: 'probe refuses this request' })
  }
  async init(): Promise<void> {
    await withTimeout(
      this.client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: CLIENT_INFO,
      }),
      T.init,
      'initialize',
    )
  }
  async newSession(): Promise<SessionShape> {
    return (await withTimeout(
      this.client.request('session/new', { cwd: scratchCwd, mcpServers: [] }),
      T.small,
      'session/new',
    )) as SessionShape
  }
  async setMode(sessionId: string, modeId: string): Promise<unknown> {
    return await withTimeout(
      this.client.request('session/set_config_option', { sessionId, configId: 'mode', value: modeId }),
      T.small,
      'session/set_config_option',
    )
  }
  async prompt(sessionId: string, text: string): Promise<unknown> {
    return await withTimeout(
      this.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
      T.prompt,
      'session/prompt',
    )
  }
  stop(): void {
    this.client.stop()
  }
}

const WRITE_TASK =
  'Create a file called probe.txt in the current directory containing the word hello. ' +
  'Use a single shell command. Do not explain, just do it.'
const READ_TASK = 'Run the shell command `ls -la` in the current directory and tell me the first line.'

async function run(profileId: string, task: string, label: string, cancelOnFirstDenial = false): Promise<void> {
  banner(`${label} — profile ${profileId}`)
  const p = new Probe()
  p.cancelOnFirstDenial = cancelOnFirstDenial
  try {
    await p.init()
    const s = await p.newSession()
    const ids = (s.modes?.availableModes ?? []).map((m) => m.id)
    log(`  mode ids: ${ids.join(', ')}`)
    log(`  ${profileId} offered? ${ids.includes(profileId)}`)
    if (!s.sessionId) throw new Error('no sessionId')
    dump('  set_config_option(mode) result', await p.setMode(s.sessionId, profileId))
    const result = await p.prompt(s.sessionId, task)
    dump('  session/prompt result', result)
    log(`  PERMISSION REQUESTS: ${p.permissions.length}`)
    log(`  probe.txt on disk? ${existsSync(join(scratchCwd, 'probe.txt'))}`)
    rmSync(join(scratchCwd, 'probe.txt'), { force: true })
  } catch (e) {
    log(`  FAILED: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    p.stop()
    await sleep(500)
  }
}

async function main(): Promise<void> {
  log(`scratch home: ${scratchHome}`)
  log(`scratch cwd:  ${scratchCwd}`)
  try {
    const phase = process.argv.find((a) => a.startsWith('--phase='))?.slice(8) ?? 'all'
    if (phase === 'all' || phase === 'a') {
      await run('zz-probe-ungated', WRITE_TASK, 'A — UNGATED (slice-1 Bot profile)')
    }
    if (phase === 'all' || phase === 'b') {
      await run('zz-probe-routine', WRITE_TASK, 'B — GATED (routine profile candidate)')
    }
    if (phase === 'all' || phase === 'c') {
      await run('zz-probe-routine', READ_TASK, 'C — GATED, a read-only shell command')
    }
    if (phase === 'all' || phase === 'd') {
      await run('zz-probe-routine', WRITE_TASK, 'D — GATED, cancel on the first denial', true)
    }
  } finally {
    cleanup()
  }
}

void main()
