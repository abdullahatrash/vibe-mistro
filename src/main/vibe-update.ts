import type { VibeUpdateResult } from '../shared/ipc'

/**
 * The same source of truth Vibe's own update notifier polls (mistral-vibe's
 * `PyPIUpdateGateway`): PyPI's JSON API for the `mistral-vibe` distribution.
 * `info.version` is the latest non-yanked release.
 */
export const VIBE_PYPI_JSON_URL = 'https://pypi.org/pypi/mistral-vibe/json'

const FETCH_TIMEOUT_MS = 10_000

/** Pull the dotted version out of a raw `vibe --version` line (e.g. `vibe 2.18.4`). */
export function parseVibeVersion(raw: string | null): string | null {
  if (!raw) return null
  const match = raw.match(/\d+(?:\.\d+)+/)
  return match ? match[0] : null
}

/**
 * Compare dotted versions numerically per segment (missing segments count as 0);
 * a non-numeric suffix on a segment (`2.19.0rc1`) keeps its leading digits.
 * Negative when `a` is older than `b`, 0 when equal, positive when newer.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v.split('.').map((seg) => Number.parseInt(seg, 10) || 0)
  const as = parse(a)
  const bs = parse(b)
  const len = Math.max(as.length, bs.length)
  for (let i = 0; i < len; i++) {
    const diff = (as[i] ?? 0) - (bs[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * Check PyPI for a newer `mistral-vibe` than the installed CLI. Best-effort like
 * detection: every failure path resolves with `error` set, never a rejection.
 * `fetchImpl` is injectable for tests only.
 */
export async function checkVibeUpdate(
  rawInstalledVersion: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<VibeUpdateResult> {
  const installedVersion = parseVibeVersion(rawInstalledVersion)
  const result: VibeUpdateResult = {
    installedVersion,
    latestVersion: null,
    updateAvailable: false,
    error: null,
  }

  try {
    const response = await fetchImpl(VIBE_PYPI_JSON_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
      result.error = `PyPI responded ${response.status}`
      return result
    }
    const body: unknown = await response.json()
    const latest = extractLatestVersion(body)
    if (!latest) {
      result.error = 'PyPI response had no version'
      return result
    }
    result.latestVersion = latest
    result.updateAvailable =
      installedVersion !== null && compareVersions(installedVersion, latest) < 0
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }

  return result
}

function extractLatestVersion(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const info = (body as { info?: unknown }).info
  if (typeof info !== 'object' || info === null) return null
  const version = (info as { version?: unknown }).version
  return typeof version === 'string' && version.length > 0 ? version : null
}
