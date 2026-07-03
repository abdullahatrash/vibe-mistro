import { describe, it, expect } from 'vitest'
import { checkVibeUpdate, compareVersions, parseVibeVersion } from './vibe-update'

describe('parseVibeVersion', () => {
  it('extracts the dotted version from a `vibe --version` line', () => {
    expect(parseVibeVersion('vibe 2.18.4')).toBe('2.18.4')
  })

  it('handles uv-tool-style lines with a v prefix', () => {
    expect(parseVibeVersion('mistral-vibe v2.18.4')).toBe('2.18.4')
  })

  it('returns the bare version unchanged', () => {
    expect(parseVibeVersion('2.18.4')).toBe('2.18.4')
  })

  it('returns null for null, empty, or version-free input', () => {
    expect(parseVibeVersion(null)).toBeNull()
    expect(parseVibeVersion('')).toBeNull()
    expect(parseVibeVersion('vibe')).toBeNull()
  })
})

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('2.18.4', '2.19.0')).toBeLessThan(0)
    expect(compareVersions('2.19.0', '2.18.4')).toBeGreaterThan(0)
    expect(compareVersions('2.18.4', '2.18.4')).toBe(0)
    expect(compareVersions('1.9.9', '2.0.0')).toBeLessThan(0)
    expect(compareVersions('2.18.4', '2.18.10')).toBeLessThan(0)
  })

  it('treats missing segments as zero', () => {
    expect(compareVersions('2.18', '2.18.0')).toBe(0)
    expect(compareVersions('2.18', '2.18.1')).toBeLessThan(0)
  })

  it('reads the leading digits of a suffixed segment', () => {
    expect(compareVersions('2.19.0rc1', '2.19.0')).toBe(0)
    expect(compareVersions('2.18.4', '2.19.0rc1')).toBeLessThan(0)
  })
})

/** A minimal fetch stub returning the given response once. */
function fetchStub(response: { ok: boolean; status?: number; json?: () => Promise<unknown> }): typeof fetch {
  return (() =>
    Promise.resolve({
      ok: response.ok,
      status: response.status ?? 200,
      json: response.json ?? (() => Promise.resolve({})),
    })) as unknown as typeof fetch
}

const pypiBody = (version: string): (() => Promise<unknown>) =>
  () => Promise.resolve({ info: { version } })

describe('checkVibeUpdate', () => {
  it('reports an update when PyPI is ahead of the installed version', async () => {
    const result = await checkVibeUpdate('vibe 2.18.4', fetchStub({ ok: true, json: pypiBody('2.19.0') }))
    expect(result).toEqual({
      installedVersion: '2.18.4',
      latestVersion: '2.19.0',
      updateAvailable: true,
      error: null,
    })
  })

  it('reports no update when versions match', async () => {
    const result = await checkVibeUpdate('vibe 2.18.4', fetchStub({ ok: true, json: pypiBody('2.18.4') }))
    expect(result.updateAvailable).toBe(false)
    expect(result.latestVersion).toBe('2.18.4')
    expect(result.error).toBeNull()
  })

  it('reports no update when the installed build is ahead of PyPI', async () => {
    const result = await checkVibeUpdate('vibe 2.20.0', fetchStub({ ok: true, json: pypiBody('2.19.0') }))
    expect(result.updateAvailable).toBe(false)
  })

  it('still reports the latest version when the installed one is unknown', async () => {
    const result = await checkVibeUpdate(null, fetchStub({ ok: true, json: pypiBody('2.19.0') }))
    expect(result.installedVersion).toBeNull()
    expect(result.latestVersion).toBe('2.19.0')
    expect(result.updateAvailable).toBe(false)
  })

  it('sets error on a non-2xx response instead of rejecting', async () => {
    const result = await checkVibeUpdate('vibe 2.18.4', fetchStub({ ok: false, status: 503 }))
    expect(result.error).toBe('PyPI responded 503')
    expect(result.latestVersion).toBeNull()
    expect(result.updateAvailable).toBe(false)
  })

  it('sets error on a malformed body instead of rejecting', async () => {
    const result = await checkVibeUpdate(
      'vibe 2.18.4',
      fetchStub({ ok: true, json: () => Promise.resolve({ info: {} }) }),
    )
    expect(result.error).toBe('PyPI response had no version')
  })

  it('sets error when fetch itself throws (offline)', async () => {
    const offline = (() => Promise.reject(new Error('network down'))) as unknown as typeof fetch
    const result = await checkVibeUpdate('vibe 2.18.4', offline)
    expect(result.error).toBe('network down')
    expect(result.updateAvailable).toBe(false)
  })
})
