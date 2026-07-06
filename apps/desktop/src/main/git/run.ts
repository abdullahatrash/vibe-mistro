import { execFile, spawn, type ExecFileException } from 'node:child_process'
import { getShellEnv } from '../shell-env'

/**
 * The ONE command-runner seam for the git slices (#84-#88). Every git/gh module runs
 * its binary through this factory — resolve-never-reject with `{stdout, stderr, code}`,
 * PATH from the shell env (so a Finder/Dock launch still finds the binary), injectable
 * per call for tests (Seam, mirroring `AcpClient.spawn`). Previously `status.ts` owned
 * the git runner and `github.ts` copy-pasted its own for `gh`; this is the canonical home.
 */

/**
 * Run a git command and capture its stdout + exit code (+ stderr). `stderr` is OPTIONAL
 * in the TYPE so read-path test fakes need only `{stdout, code}`; the default runner
 * always provides it — the WRITE path (#86 `gitCommit`) needs it, since git puts a
 * failed pre-commit hook / lock error on STDERR (and "nothing to commit" on stdout).
 */
export type GitRun = (args: string[], cwd: string) => Promise<{ stdout: string; stderr?: string; code: number }>

/**
 * Build a resolve-never-reject runner for `bin`. `spawnFailureCode` is what a SPAWN
 * failure (`err.code` a string like 'ENOENT' — binary missing — rather than a numeric
 * exit) resolves as: git callers map any non-zero to a degraded result so `1` suffices,
 * while `gh` uses a negative sentinel to distinguish "gh missing" from a real gh exit.
 */
export function makeCommandRunner(
  bin: string,
  opts: { maxBuffer: number; spawnFailureCode?: number },
): (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }> {
  const spawnFailureCode = opts.spawnFailureCode ?? 1
  return (args, cwd) =>
    new Promise((resolve) => {
      execFile(
        bin,
        args,
        { cwd, env: getShellEnv(), encoding: 'utf8', maxBuffer: opts.maxBuffer },
        (err: ExecFileException | null, stdout: string, stderr: string) => {
          const code = err == null ? 0 : typeof err.code === 'number' ? err.code : spawnFailureCode
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code })
        },
      )
    })
}

export const defaultGitRun: GitRun = makeCommandRunner('git', { maxBuffer: 64 * 1024 * 1024 })

/**
 * A STREAMING git read (#390, PRD #387): the diff-body seam for the Review surface,
 * where a buffered `execFile` (which reads the whole subprocess output into memory
 * before we can slice it) is exactly wrong — a pathological diff would balloon main's
 * heap before we ever cap it. `capBytes` is the byte budget for THIS invocation: the
 * runner reads stdout incrementally and STOPS consuming past `capBytes` (destroying the
 * pipe + killing the child), so a 2 GB generated file costs us `capBytes`, not 2 GB.
 * `truncated` reports whether the cap cut the output short. `capBytes = Infinity` reads
 * to completion (used for the small enumeration / base-resolution calls). Resolve-never
 * -reject like {@link GitRun}: a spawn failure resolves `{code:1}` with empty output.
 */
export interface GitStreamResult {
  stdout: string
  stderr: string
  code: number
  truncated: boolean
}

/** The injectable streaming-read seam (#390) — the diff-body analogue of {@link GitRun}. */
export type GitStreamRun = (args: string[], cwd: string, capBytes: number) => Promise<GitStreamResult>

/** Cap on captured STDERR (a failing git puts its reason here) — small; we only need the message. */
const STDERR_CAP_BYTES = 64 * 1024

/**
 * The default streaming git runner (#390). Spawns `git` with the resolved shell-env PATH
 * (like every other git call) and reads stdout by chunk, cutting off at `capBytes`. When
 * the cap is hit we set `truncated`, `destroy()` the stdout pipe, and `kill()` the child
 * — SIGPIPE would eventually stop it anyway, but killing is prompt and deterministic —
 * then resolve `code:0` (a cap-hit means we got a full cap-worth of real diff output; a
 * genuine git error yields little stdout + a stderr reason, never a cap hit). Guards a
 * double-resolve so the later `close` after our `kill` is a no-op.
 */
export const defaultGitStreamRun: GitStreamRun = (args, cwd, capBytes) =>
  new Promise((resolve) => {
    const out: Buffer[] = []
    let outLen = 0
    let truncated = false
    const err: Buffer[] = []
    let errLen = 0
    let settled = false

    function finish(code: number): void {
      if (settled) return
      settled = true
      const full = Buffer.concat(out)
      const stdout = (truncated && Number.isFinite(capBytes) ? full.subarray(0, capBytes) : full).toString('utf8')
      resolve({ stdout, stderr: Buffer.concat(err).toString('utf8'), code, truncated })
    }

    let child
    try {
      child = spawn('git', args, { cwd, env: getShellEnv() })
    } catch {
      resolve({ stdout: '', stderr: '', code: 1, truncated: false })
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return
      out.push(chunk)
      outLen += chunk.byteLength
      if (outLen >= capBytes) {
        truncated = true
        child.stdout?.destroy()
        child.kill()
        finish(0)
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      if (errLen >= STDERR_CAP_BYTES) return
      err.push(chunk)
      errLen += chunk.byteLength
    })
    // A spawn failure (ENOENT etc.) degrades to the empty result — never a throw.
    child.on('error', () => finish(1))
    child.on('close', (code) => finish(code ?? 0))
  })

/**
 * The failure reason of a non-zero step. git/gh put refusals, hook failures, and lock
 * errors on STDERR but "nothing to commit" on STDOUT, so prefer stderr and fall back to
 * stdout — never collapse to a generic message (#78/#86 style).
 */
export function failReason(res: { stdout: string; stderr?: string }): string {
  return (res.stderr ?? '').trim() || res.stdout.trim() || 'git command failed'
}

/** Coerce an unexpected throw (a runner that rejects) to a message for `{ok:false}` results. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
