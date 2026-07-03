import { describe, expect, it } from 'vitest'
import {
  APP_UPDATE_INITIAL,
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
    expect(resolveUpdaterMode({ isPackaged: true, feedUrlOverride: undefined })).toEqual({
      enabled: true,
      feedUrl: null,
    })
  })

  it('dev runs are updater-off', () => {
    expect(resolveUpdaterMode({ isPackaged: false, feedUrlOverride: undefined })).toEqual({
      enabled: false,
      feedUrl: null,
    })
    expect(resolveUpdaterMode({ isPackaged: false, feedUrlOverride: '   ' })).toEqual({
      enabled: false,
      feedUrl: null,
    })
  })

  it('the mock-feed env forces the updater on with a generic feed (dev AND packaged)', () => {
    expect(
      resolveUpdaterMode({ isPackaged: false, feedUrlOverride: 'http://localhost:8099' }),
    ).toEqual({ enabled: true, feedUrl: 'http://localhost:8099' })
    expect(
      resolveUpdaterMode({ isPackaged: true, feedUrlOverride: 'http://localhost:8099 ' }),
    ).toEqual({ enabled: true, feedUrl: 'http://localhost:8099' })
  })
})
