import { describe, expect, it } from 'vitest'
import {
  APP_UPDATE_INITIAL,
  describeUpdateCheck,
  describeUpdaterDisabled,
  reduceUpdaterEvent,
  resolveUpdaterMode,
  sameStatus,
  type UpdaterEvent,
} from './app-update'
import type { AppUpdateStatusEvent } from '../shared/ipc'

function run(events: UpdaterEvent[]): AppUpdateStatusEvent {
  return events.reduce(reduceUpdaterEvent, APP_UPDATE_INITIAL)
}

describe('reduceUpdaterEvent', () => {
  it('walks the happy path: checking → downloading → ready', () => {
    expect(run([{ kind: 'checking' }])).toEqual({ phase: 'checking', version: null, error: null })
    expect(run([{ kind: 'checking' }, { kind: 'update-available', version: '0.2.0' }])).toEqual({
      phase: 'downloading',
      version: '0.2.0',
      error: null,
    })
    expect(
      run([
        { kind: 'checking' },
        { kind: 'update-available', version: '0.2.0' },
        { kind: 'update-downloaded', version: '0.2.0' },
      ]),
    ).toEqual({ phase: 'ready', version: '0.2.0', error: null })
  })

  it('returns to idle when the check finds nothing', () => {
    expect(run([{ kind: 'checking' }, { kind: 'update-not-available' }])).toEqual(
      APP_UPDATE_INITIAL,
    )
  })

  it('records an error and lets the next cycle restart from it', () => {
    const errored = run([{ kind: 'checking' }, { kind: 'error', message: 'net::DISCONNECTED' }])
    expect(errored).toEqual({ phase: 'error', version: null, error: 'net::DISCONNECTED' })
    expect(reduceUpdaterEvent(errored, { kind: 'checking' })).toEqual({
      phase: 'checking',
      version: null,
      error: null,
    })
  })

  it('ready is absorbing — later checks, misses, and errors never hide the affordance', () => {
    const ready = run([
      { kind: 'update-available', version: '0.2.0' },
      { kind: 'update-downloaded', version: '0.2.0' },
    ])
    for (const event of [
      { kind: 'checking' },
      { kind: 'update-not-available' },
      { kind: 'error', message: 'offline' },
      { kind: 'update-available', version: '0.3.0' },
    ] satisfies UpdaterEvent[]) {
      expect(reduceUpdaterEvent(ready, event)).toBe(ready)
    }
  })
})

describe('sameStatus', () => {
  it('matches identical payloads and catches any field change', () => {
    const a: AppUpdateStatusEvent = { phase: 'downloading', version: '0.2.0', error: null }
    expect(sameStatus(a, { ...a })).toBe(true)
    expect(sameStatus(a, { ...a, phase: 'ready' })).toBe(false)
    expect(sameStatus(a, { ...a, version: '0.3.0' })).toBe(false)
    expect(sameStatus(a, { ...a, error: 'x' })).toBe(false)
  })
})

describe('resolveUpdaterMode', () => {
  it('packaged builds run against the embedded feed', () => {
    expect(
      resolveUpdaterMode({
        isPackaged: true,
        feedUrlOverride: undefined,
        platform: 'darwin',
        isAppImage: false,
      }),
    ).toEqual({
      enabled: true,
      feedUrl: null,
    })
  })

  it('dev runs are updater-off', () => {
    expect(
      resolveUpdaterMode({
        isPackaged: false,
        feedUrlOverride: undefined,
        platform: 'darwin',
        isAppImage: false,
      }),
    ).toEqual({
      enabled: false,
      feedUrl: null,
    })
    expect(
      resolveUpdaterMode({
        isPackaged: false,
        feedUrlOverride: '   ',
        platform: 'darwin',
        isAppImage: false,
      }),
    ).toEqual({
      enabled: false,
      feedUrl: null,
    })
  })

  it('the mock-feed env forces the updater on with a generic feed (dev AND packaged)', () => {
    expect(
      resolveUpdaterMode({
        isPackaged: false,
        feedUrlOverride: 'http://localhost:8099',
        platform: 'darwin',
        isAppImage: false,
      }),
    ).toEqual({ enabled: true, feedUrl: 'http://localhost:8099' })
    expect(
      resolveUpdaterMode({
        isPackaged: true,
        feedUrlOverride: 'http://localhost:8099 ',
        platform: 'darwin',
        isAppImage: false,
      }),
    ).toEqual({ enabled: true, feedUrl: 'http://localhost:8099' })
  })

  it('packaged Linux runs the updater ONLY for an AppImage (deb/rpm defer to apt)', () => {
    // AppImage self-updates via latest-linux.yml.
    expect(
      resolveUpdaterMode({
        isPackaged: true,
        feedUrlOverride: undefined,
        platform: 'linux',
        isAppImage: true,
      }),
    ).toEqual({ enabled: true, feedUrl: null })
    // A .deb/.rpm install cannot self-update — updater stays off.
    expect(
      resolveUpdaterMode({
        isPackaged: true,
        feedUrlOverride: undefined,
        platform: 'linux',
        isAppImage: false,
      }),
    ).toEqual({ enabled: false, feedUrl: null })
    // The mock-feed override still forces it on for a non-AppImage Linux run.
    expect(
      resolveUpdaterMode({
        isPackaged: true,
        feedUrlOverride: 'http://localhost:8099',
        platform: 'linux',
        isAppImage: false,
      }),
    ).toEqual({ enabled: true, feedUrl: 'http://localhost:8099' })
  })
})

describe('describeUpdateCheck', () => {
  const at = (phase: AppUpdateStatusEvent['phase'], version: string | null = null, error: string | null = null): AppUpdateStatusEvent => ({ phase, version, error })

  it('offers the restart only when a download is staged', () => {
    const ready = describeUpdateCheck(at('ready', '0.2.0'), '0.1.2', 'Vibe Mistro (Beta)')
    expect(ready.offerRestart).toBe(true)
    expect(ready.message).toBe('Vibe Mistro (Beta) 0.2.0 is ready to install')
    for (const phase of ['idle', 'checking', 'downloading', 'error'] as const) {
      expect(describeUpdateCheck(at(phase), '0.1.2', 'X').offerRestart).toBe(false)
    }
  })

  it('reports up-to-date with the running version when nothing is newer', () => {
    const copy = describeUpdateCheck(at('idle'), '0.1.2', 'Vibe Mistro (Beta)')
    expect(copy.message).toBe('Vibe Mistro (Beta) 0.1.2')
    expect(copy.detail).toContain('latest version')
  })

  it('points at the sidebar chip while a download is in flight', () => {
    const copy = describeUpdateCheck(at('downloading', '0.2.0'), '0.1.2', 'V')
    expect(copy.message).toContain('0.2.0')
    expect(copy.detail).toContain('chip')
  })

  it('surfaces the check error, never silently', () => {
    const copy = describeUpdateCheck(at('error', null, 'net::DISCONNECTED'), '0.1.2', 'V')
    expect(copy.message).toBe('Could not check for updates')
    expect(copy.detail).toContain('net::DISCONNECTED')
  })
})

describe('describeUpdaterDisabled', () => {
  it('explains dev builds do not self-update and never offers a restart', () => {
    const copy = describeUpdaterDisabled('0.1.2', 'Vibe Mistro (Beta)')
    expect(copy.offerRestart).toBe(false)
    expect(copy.message).toBe('Vibe Mistro (Beta) 0.1.2')
    expect(copy.detail).toContain('packaged app')
  })
})
