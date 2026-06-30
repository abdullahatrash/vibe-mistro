import { describe, it, expect } from 'vitest'
import { firstRunState } from './first-run'
import type { ListMetadataResult, VibeDetectResult, WorkspaceThreads } from '../../../shared/ipc'

/**
 * Pure first-run derivation: decide what the outlet foregrounds when nothing is
 * connected/selected, driving where the environment status is surfaced (prominent
 * on a fresh machine vs tucked into settings once it's all installed — #49).
 */

const FOUND: VibeDetectResult = {
  vibeFound: true,
  vibeAcpFound: true,
  vibeVersion: '0.1.0',
  vibeAcpPath: '/abs/vibe-acp',
  error: null,
}

const WS: WorkspaceThreads = {
  id: 'w1',
  dir: '/abs/ws',
  displayName: 'ws',
  lastOpenedAt: 0,
  threads: [],
}

const RECENTS: ListMetadataResult = [WS]

describe('firstRunState', () => {
  it('is needs-install when vibe-acp is missing (the blocking dependency)', () => {
    expect(firstRunState({ ...FOUND, vibeAcpFound: false }, RECENTS)).toBe('needs-install')
  })

  it('is needs-install when the vibe CLI is missing', () => {
    expect(firstRunState({ ...FOUND, vibeFound: false }, [])).toBe('needs-install')
  })

  it('needs-install wins over no-workspaces (missing toolchain blocks regardless)', () => {
    expect(firstRunState({ ...FOUND, vibeAcpFound: false }, [])).toBe('needs-install')
  })

  it('is no-workspaces when everything is detected but no Workspaces exist', () => {
    expect(firstRunState(FOUND, [])).toBe('no-workspaces')
  })

  it('is idle when detected and Workspaces exist', () => {
    expect(firstRunState(FOUND, RECENTS)).toBe('idle')
  })

  it('does not flash needs-install while detection is still pending', () => {
    expect(firstRunState(null, RECENTS)).toBe('idle')
    expect(firstRunState(null, [])).toBe('no-workspaces')
  })
})
