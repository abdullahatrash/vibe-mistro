import { describe, it, expect } from 'vitest'
import { describeUpdateStatus } from './update-status'
import type { VibeUpdateResult } from '../../../shared/ipc'

const base: VibeUpdateResult = {
  installedVersion: '2.18.4',
  latestVersion: '2.18.4',
  updateAvailable: false,
  error: null,
}

describe('describeUpdateStatus', () => {
  it('renders nothing before a check has run', () => {
    expect(describeUpdateStatus(null)).toBeNull()
  })

  it('announces an available update with the latest version', () => {
    expect(
      describeUpdateStatus({ ...base, latestVersion: '2.19.0', updateAvailable: true }),
    ).toBe('2.19.0 — update available')
  })

  it('confirms up to date when PyPI matches the installed version', () => {
    expect(describeUpdateStatus(base)).toBe('2.18.4 — up to date')
  })

  it('treats a dev build ahead of PyPI as up to date', () => {
    expect(describeUpdateStatus({ ...base, installedVersion: '2.20.0' })).toBe(
      '2.18.4 — up to date',
    )
  })

  it('surfaces a failed check instead of swallowing it', () => {
    expect(
      describeUpdateStatus({ ...base, latestVersion: null, error: 'network down' }),
    ).toBe('update check failed')
  })

  it('renders nothing when the check produced no version and no error', () => {
    expect(describeUpdateStatus({ ...base, latestVersion: null })).toBeNull()
  })
})
