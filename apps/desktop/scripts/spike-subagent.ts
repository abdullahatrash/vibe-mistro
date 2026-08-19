/**
 * Spike probe — LIVE capture of Mistral Vibe **subagent** (`task` tool) traffic over ACP.
 *
 * HITL / LIVE: drives the user's REAL Mistral account (consumes credits). Not part of
 * the test suite. Same infra gotcha as every other probe here — Bun's
 * `node:child_process` does not deliver `stdin.write()` to a piped child, so build to a
 * node target and run under node:
 *
 *   bun build scripts/spike-subagent.ts --target=node --outfile=/tmp/spike-sub.mjs \
 *     && node /tmp/spike-sub.mjs --phase=all
 *
 * Phases
 *   1  auto-approve mode  — one `explore` subagent; capture every frame.
 *   2  default mode       — one `explore` subagent; capture permission behaviour.
 *   3  parallel fan-out   — ask for two subagents in one turn; capture interleaving.
 *   4  session/load       — resume phase-1's session in a FRESH process; does the
 *                           subagent tool_call replay with `_meta` + content intact?
 *
 * Every frame is logged VERBATIM in both directions:
 *   >>> client → agent      <<< agent → client
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { AcpClient, type ChildProcessLike, type SpawnFn } from '../src/main/acp/client'

const PROTOCOL_VERSION = 1
const CLIENT_INFO = { name: 'vibe-mistro', version: '0.0.1' } as const
const DEFAULT_WS = '/tmp/vibe-subagent-ws'
const DEFAULT_LOG = '/tmp/vibe-subagent-capture.log'
const STATE_FILE = '/tmp/vibe-subagent-state.json'

const TIMEOUT = { initialize: 30_000, sessionNew: 30_000, prompt: 300_000, load: 60_000 }

interface Args {
  phase: '1' | '2' | '3' | '4' | 'all'
  ws: string
  log: string
  command: string
}

function parseArgs(argv: string[]): Args {
  const out: Args = { phase: 'all', ws: DEFAULT_WS, log: DEFAULT_LOG, command: 'vibe-acp' }
  for (const arg of argv) {
    if (arg.startsWith('--phase=')) out.phase = arg.slice(8) as Args['phase']
    else if (arg.startsWith('--ws=')) out.ws = arg.slice(5)
    else if (arg.startsWith('--log=')) out.log = arg.slice(6)
    else if (arg.startsWith('--command=')) out.command = arg.slice(10)
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Verbatim both-direction logging
// ---------------------------------------------------------------------------

let LOG_FILE = DEFAULT_LOG

function out(text: string): void {
  console.log(text)
  try {
    appendFileSync(LOG_FILE, text + '\n')
  } catch {
    /* best effort */
  }
}

function banner(text: string): void {
  out(`\n=== ${text} ===`)
}

function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

function logFrame(dir: '>>>' | '<<<', raw: string): void {
  out(`${dir} ${new Date().toISOString()}`)
  out(pretty(raw))
}

/** Wraps the real spawn so every stdin write and stdout line is teed verbatim. */
const loggingSpawn: SpawnFn = (command, args, options) => {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdoutBuf = ''
  const wrapper = {
    stdout: {
      setEncoding: (enc: BufferEncoding) => child.stdout.setEncoding(enc),
      on: (event: 'data', listener: (chunk: string) => void) => {
        child.stdout.on(event, (chunk: string) => {
          stdoutBuf += chunk
          let i: number
          while ((i = stdoutBuf.indexOf('\n')) !== -1) {
            const line = stdoutBuf.slice(0, i).trim()
            stdoutBuf = stdoutBuf.slice(i + 1)
            if (line) logFrame('<<<', line)
          }
          listener(chunk)
        })
      },
    },
    stderr: {
      setEncoding: (enc: BufferEncoding) => child.stderr.setEncoding(enc),
      on: (event: 'data', listener: (chunk: string) => void) => child.stderr.on(event, listener),
    },
    stdin: {
      write: (data: string) => {
        logFrame('>>>', data.trim())
        child.stdin.write(data)
      },
    },
    on: (event: string, listener: (...a: never[]) => void) =>
      child.on(event as 'error', listener as never),
    kill: () => child.kill(),
  }
  return wrapper as unknown as ChildProcessLike
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

class Probe {
  readonly client: AcpClient
  lastActivity = Date.now()
  permissionCount = 0
  /** Answer permission requests automatically? (phase 2 needs to see them first.) */
  autoAllow = true

  constructor(command: string, cwd: string) {
    this.client = new AcpClient({ command, cwd, env: process.env, spawn: loggingSpawn })
    this.client.on('notification', () => {
      this.lastActivity = Date.now()
    })
    this.client.on('serverRequest', (msg: unknown) => {
      this.lastActivity = Date.now()
      this.onServerRequest(msg)
    })
    this.client.on('stderr', (t: string) => {
      const s = t.trimEnd()
      if (s) out(`  [stderr] ${s}`)
    })
    this.client.on('exit', (i: unknown) => out(`  [exit] ${JSON.stringify(i)}`))
  }

  private onServerRequest(msg: unknown): void {
    const req = msg as { id?: number | string; method?: string; params?: unknown }
    if (req.id === undefined) return
    if (req.method === 'fs/read_text_file') {
      const p = (req.params as { path?: string })?.path
      let content = ''
      try {
        if (p && existsSync(p)) content = readFileSync(p, 'utf8')
      } catch {
        /* empty */
      }
      this.client.respond(req.id, { content })
    } else if (req.method === 'fs/write_text_file') {
      const p = req.params as { path?: string; content?: string }
      try {
        if (p?.path) writeFileSync(p.path, p.content ?? '')
      } catch {
        /* empty */
      }
      this.client.respond(req.id, {})
    } else if (req.method === 'session/request_permission') {
      this.permissionCount++
      out(`  [PERMISSION #${this.permissionCount}] answering allow_once`)
      const opts = (req.params as { options?: { optionId: string; kind?: string }[] })?.options ?? []
      const allow =
        opts.find((o) => o.kind === 'allow_once')?.optionId ??
        opts.find((o) => o.optionId.includes('allow'))?.optionId ??
        'allow_once'
      this.client.respond(req.id, { outcome: { outcome: 'selected', optionId: allow } })
    } else {
      this.client.respondError(req.id, { code: -32601, message: 'method not found (probe)' })
    }
  }

  start(): void {
    this.client.start()
  }
  stop(): void {
    this.client.stop()
  }

  async initialize(): Promise<void> {
    banner('initialize')
    await withTimeout(
      this.client.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          _meta: { 'browser-auth-delegated': true },
        },
        clientInfo: CLIENT_INFO,
      }),
      TIMEOUT.initialize,
      'initialize',
    )
    const status = await withTimeout(this.client.request('_auth/status'), 15_000, '_auth/status')
    if ((status as { authenticated?: boolean })?.authenticated === false) {
      out('NOT SIGNED IN — run `vibe` to sign in first.')
      process.exit(2)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const t = new Promise<never>((_r, rej) => {
    timer = setTimeout(() => rej(new Error(`Timed out after ${ms}ms waiting for ${label}`)), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer)) as Promise<T>
}

function describeError(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return JSON.stringify(err)
  if (err instanceof Error) return err.message
  return String(err)
}

// ---------------------------------------------------------------------------
// Scratch workspace
// ---------------------------------------------------------------------------

function makeWorkspace(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'README.md'),
    '# Widget Factory\n\nA tiny demo project that turns orders into widgets.\n',
  )
  writeFileSync(
    join(dir, 'alpha.py'),
    'def build_widget(order):\n    """Build one widget from an order."""\n    return {"id": order["id"], "kind": "widget"}\n',
  )
  writeFileSync(
    join(dir, 'beta.js'),
    'export function shipWidget(widget) {\n  // Hand the widget to the courier.\n  return { ...widget, shipped: true }\n}\n',
  )
  writeFileSync(
    join(dir, 'gamma.txt'),
    'Order pipeline: intake -> build (alpha.py) -> ship (beta.js).\n',
  )
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const SINGLE_PROMPT =
  'Use the task tool to launch the explore subagent with the task ' +
  '"Summarise what this project does by reading README.md, alpha.py and beta.js". ' +
  'Do NOT read any files yourself — you must delegate to the explore subagent via the task tool. ' +
  'When it returns, reply with one sentence.'

const PARALLEL_PROMPT =
  'Call the task tool TWICE IN THE SAME ASSISTANT MESSAGE so both explore subagents run in parallel. ' +
  'First call: agent="explore", task="Read alpha.py and describe what it does". ' +
  'Second call: agent="explore", task="Read beta.js and describe what it does". ' +
  'Do NOT read any files yourself. Emit both task tool calls at once, then summarise both answers.'

async function runPrompt(
  probe: Probe,
  sessionId: string,
  text: string,
  label: string,
): Promise<void> {
  banner(`session/prompt — ${label}`)
  try {
    const res = await withTimeout(
      probe.client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }),
      TIMEOUT.prompt,
      'session/prompt',
    )
    out(`\n[turn end] ${JSON.stringify(res)}`)
  } catch (err) {
    out(`\n[prompt FAILED] ${describeError(err)}`)
  }
  await sleep(1000)
}

async function newSession(probe: Probe, cwd: string): Promise<string> {
  banner('session/new')
  const res = await withTimeout(
    probe.client.request('session/new', { cwd, mcpServers: [] }),
    TIMEOUT.sessionNew,
    'session/new',
  )
  return (res as { sessionId: string }).sessionId
}

async function phaseSingle(args: Args, mode: string, label: string): Promise<string> {
  banner(`PHASE — ${label} (mode=${mode})`)
  makeWorkspace(args.ws)
  const probe = new Probe(args.command, args.ws)
  try {
    probe.start()
    await probe.initialize()
    const sessionId = await newSession(probe, args.ws)
    if (mode !== 'default') {
      banner(`session/set_mode → ${mode}`)
      await withTimeout(
        probe.client.request('session/set_mode', { sessionId, modeId: mode }),
        15_000,
        'set_mode',
      )
    }
    await runPrompt(probe, sessionId, SINGLE_PROMPT, label)
    out(`\n[permission requests seen this phase] ${probe.permissionCount}`)
    out(`[sessionId] ${sessionId}`)
    return sessionId
  } finally {
    probe.stop()
  }
}

async function phaseParallel(args: Args): Promise<string> {
  banner('PHASE 3 — parallel fan-out (mode=auto-approve)')
  makeWorkspace(args.ws)
  const probe = new Probe(args.command, args.ws)
  try {
    probe.start()
    await probe.initialize()
    const sessionId = await newSession(probe, args.ws)
    await withTimeout(
      probe.client.request('session/set_mode', { sessionId, modeId: 'auto-approve' }),
      15_000,
      'set_mode',
    )
    await runPrompt(probe, sessionId, PARALLEL_PROMPT, 'parallel fan-out')
    out(`[sessionId] ${sessionId}`)
    return sessionId
  } finally {
    probe.stop()
  }
}

async function phaseLoad(args: Args, sessionId: string): Promise<void> {
  banner(`PHASE 4 — session/load replay of ${sessionId}`)
  const probe = new Probe(args.command, args.ws)
  try {
    probe.start()
    await probe.initialize()
    try {
      await withTimeout(
        probe.client.request('session/load', { sessionId, cwd: args.ws, mcpServers: [] }),
        TIMEOUT.load,
        'session/load',
      )
    } catch (err) {
      out(`[session/load FAILED] ${describeError(err)}`)
    }
    // Let any post-result replay land.
    const start = Date.now()
    while (Date.now() - probe.lastActivity < 4000 && Date.now() - start < 40_000) await sleep(250)
  } finally {
    probe.stop()
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  LOG_FILE = args.log
  writeFileSync(LOG_FILE, '')
  out(`vibe-acp SUBAGENT capture — phase=${args.phase} ws=${args.ws} log=${args.log}`)

  const state: Record<string, string> = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    : {}

  if (args.phase === '1' || args.phase === 'all') {
    state.phase1 = await phaseSingle(args, 'auto-approve', 'PHASE 1 single subagent, auto-approve')
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  }
  if (args.phase === '2' || args.phase === 'all') {
    state.phase2 = await phaseSingle(args, 'default', 'PHASE 2 single subagent, DEFAULT mode')
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  }
  if (args.phase === '3' || args.phase === 'all') {
    state.phase3 = await phaseParallel(args)
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
  }
  if (args.phase === '4' || args.phase === 'all') {
    const target = state.phase1 ?? state.phase2 ?? state.phase3
    if (!target) throw new Error('no session id to load — run phase 1 first')
    await phaseLoad(args, target)
  }
  banner('CAPTURE COMPLETE')
  out(`log written to ${args.log}`)
  out(`sessions: ${JSON.stringify(state)}`)
}

main().catch((err) => {
  banner('PROBE FAILED')
  console.error(describeError(err))
  process.exit(1)
})
