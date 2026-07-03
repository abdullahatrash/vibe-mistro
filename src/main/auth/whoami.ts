import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { AccountPlan, AccountWhoamiResult } from '../../shared/ipc'

/**
 * Fetch the signed-in account's PLAN from Mistral's console whoami endpoint
 * (ADR-0003 amendment). Vibe stores no identity — its sign-in ends with a bare
 * `MISTRAL_API_KEY` and the console `whoami` reports only the plan tier — so we
 * READ that key exactly where Vibe keeps it and make the same call Vibe's TUI
 * makes (vibe/cli/plan_offer/adapters/http_whoami_gateway.py). The key is used
 * for the one request and NEVER persisted, surfaced over IPC, or logged.
 *
 * Key-resolution order mirrors Vibe's ACTIVE-credential precedence
 * (vibe/setup/auth/auth_state.py `assess_auth_state`): process env, then the
 * `$VIBE_HOME/.env` dotenv, then the OS keyring — Vibe loads the dotenv into
 * its process env and reads env before keyring, so a dotenv entry outranks a
 * keyring one. Our "process env" is the resolved login-shell env we also spawn
 * `vibe-acp` with, so the agent and this lookup agree on the credential.
 */

/** The env key Vibe persists its Mistral credential under (all three stores). */
export const MISTRAL_API_KEY = 'MISTRAL_API_KEY'

/** Vibe's whoami endpoint (console base + WHOAMI_PATH, http_whoami_gateway.py). */
export const WHOAMI_URL = 'https://console.mistral.ai/api/vibe/whoami'

/** Keychain service names Vibe writes (vibe/core/utils/keyring.py; legacy first app). */
const KEYRING_SERVICES = ['ai.mistral.vibe', 'vibe'] as const

const execFileAsync = promisify(execFile)

/**
 * Extract `key`'s value from dotenv-file content (Vibe's `~/.vibe/.env`
 * fallback store, written by python-dotenv's `set_key`). Handles the shapes
 * that writer produces plus hand-edits: optional `export `, single/double
 * quotes, surrounding whitespace, `#` comment lines. Last assignment wins,
 * matching dotenv semantics.
 */
export function parseDotenvValue(content: string, key: string): string | null {
  let value: string | null = null
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const unexported = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line
    const eq = unexported.indexOf('=')
    if (eq <= 0 || unexported.slice(0, eq).trim() !== key) continue
    let raw = unexported.slice(eq + 1).trim()
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      raw = raw.slice(1, -1)
    }
    value = raw
  }
  return value ? value : null
}

/**
 * Parse the whoami response body into an `AccountPlan`. Mirrors Vibe's
 * `WhoAmIResponse.from_payload`: both `plan_type` and `plan_name` must be
 * strings (else the payload is invalid → null), and an unrecognised
 * `plan_type` degrades to `UNKNOWN` rather than failing.
 */
export function parseWhoamiPayload(payload: unknown): AccountPlan | null {
  const planType = (payload as { plan_type?: unknown } | null)?.plan_type
  const planName = (payload as { plan_name?: unknown } | null)?.plan_name
  if (typeof planType !== 'string' || typeof planName !== 'string') return null
  const normalized = planType.trim().toUpperCase()
  const known: readonly AccountPlan['planType'][] = [
    'API',
    'CHAT',
    'MISTRAL_CODE',
    'UNKNOWN',
    'UNAUTHORIZED',
  ]
  return {
    planType: known.includes(normalized as AccountPlan['planType'])
      ? (normalized as AccountPlan['planType'])
      : 'UNKNOWN',
    planName: planName.trim(),
  }
}

/** The IO seams `getAccountWhoami` composes — injectable for tests. */
export interface WhoamiDeps {
  /** The resolved shell env (the same one `vibe-acp` is spawned with). */
  env: NodeJS.ProcessEnv
  /** Read the dotenv-store content, or null when absent/unreadable. */
  readEnvFile: () => Promise<string | null>
  /** Read the keychain-stored key, or null when absent/unsupported. */
  readKeyring: () => Promise<string | null>
  /** The fetch to hit the whoami endpoint with. */
  fetchFn: typeof fetch
}

/**
 * Resolve the Mistral API key the way Vibe would pick its active credential:
 * process env → `$VIBE_HOME/.env` → OS keyring. Returns null when signed out
 * everywhere.
 */
export async function resolveMistralApiKey(
  deps: Pick<WhoamiDeps, 'env' | 'readEnvFile' | 'readKeyring'>,
): Promise<string | null> {
  const fromEnv = deps.env[MISTRAL_API_KEY]
  if (fromEnv) return fromEnv
  const envFile = await deps.readEnvFile()
  const fromDotenv = envFile === null ? null : parseDotenvValue(envFile, MISTRAL_API_KEY)
  if (fromDotenv) return fromDotenv
  return deps.readKeyring()
}

/** Read Vibe's dotenv store at `$VIBE_HOME/.env` (default `~/.vibe/.env`). */
export async function readVibeEnvFile(env: NodeJS.ProcessEnv): Promise<string | null> {
  const vibeHome = env.VIBE_HOME || join(homedir(), '.vibe')
  try {
    return await readFile(join(vibeHome, '.env'), 'utf8')
  } catch {
    return null // absent file = signed out of this store, not an error
  }
}

/**
 * Read the key from the OS keychain the way Vibe stores it. macOS only for
 * now (`security find-generic-password`, the same binary Vibe's python-keyring
 * shells out to); other platforms return null — the env/dotenv stores still
 * work there. Tries the current service name, then the legacy one.
 */
export async function readKeychainApiKey(): Promise<string | null> {
  if (process.platform !== 'darwin') return null
  for (const service of KEYRING_SERVICES) {
    try {
      const { stdout } = await execFileAsync('/usr/bin/security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        MISTRAL_API_KEY,
        '-w',
      ])
      const key = stdout.trim()
      if (key) return key
    } catch {
      // exit 44 = item not found — fall through to the next service name
    }
  }
  return null
}

/**
 * The composed lookup behind the `auth:account-whoami` IPC: resolve the key,
 * hit the whoami endpoint, classify. Every failure is a typed, recoverable
 * result — the account chip degrades to its static label, never an error state
 * that blocks the app.
 */
export async function getAccountWhoami(deps: WhoamiDeps): Promise<AccountWhoamiResult> {
  const key = await resolveMistralApiKey(deps)
  if (!key) return { ok: false, reason: 'no-key', error: 'No Mistral API key found.' }

  let response: Response
  try {
    response = await deps.fetchFn(WHOAMI_URL, {
      headers: { Authorization: `Bearer ${key}` },
    })
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: 'error', error }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'unauthorized', error: 'The stored API key was rejected.' }
  }
  if (!response.ok) {
    return { ok: false, reason: 'error', error: `Unexpected status ${response.status}.` }
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    return { ok: false, reason: 'error', error: 'Whoami response was not JSON.' }
  }
  const plan = parseWhoamiPayload(payload)
  if (!plan) return { ok: false, reason: 'error', error: 'Whoami response shape was invalid.' }
  return { ok: true, plan }
}
