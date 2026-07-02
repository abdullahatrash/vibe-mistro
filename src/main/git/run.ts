import { execFile, type ExecFileException } from 'node:child_process'
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
