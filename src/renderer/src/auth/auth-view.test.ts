import { describe, it, expect } from 'vitest'
import { selectAuthView } from './auth-view'
import type { AuthMethod } from '../../../shared/ipc'

/**
 * Seam 3: the pure auth view-state selector. It maps the detected `AuthState`
 * (+ the agent's advertised `authMethods`) to what the renderer shows — a
 * sign-in panel when not signed in, nothing otherwise. Per ADR-0001 the
 * renderer owns this view state; main only classifies + relays.
 */

const BROWSER_AUTH: AuthMethod = {
  id: 'browser-auth',
  name: 'Sign in through Mistral AI Studio',
  description: 'Sign into Mistral Vibe through your Mistral AI Studio account.',
}

describe('selectAuthView', () => {
  it('shows a sign-in panel with the advertised method name when not signed in', () => {
    const view = selectAuthView({ authState: 'not-signed-in', authMethods: [BROWSER_AUTH] })
    expect(view).toEqual({
      kind: 'sign-in',
      methodId: 'browser-auth',
      methodName: 'Sign in through Mistral AI Studio',
      description: 'Sign into Mistral Vibe through your Mistral AI Studio account.',
    })
  })

  it('shows no auth panel when signed in (incl. BYOK)', () => {
    expect(selectAuthView({ authState: 'signed-in', authMethods: [BROWSER_AUTH] })).toEqual({
      kind: 'none',
    })
  })

  it('shows no auth panel while the state is still unknown', () => {
    expect(selectAuthView({ authState: 'unknown' })).toEqual({ kind: 'none' })
  })

  it('falls back to a generic sign-in label when no authMethods are advertised', () => {
    // Defensive: never strand the user without a way back in if authMethods is empty.
    expect(selectAuthView({ authState: 'not-signed-in', authMethods: [] })).toEqual({
      kind: 'sign-in',
      methodId: '',
      methodName: 'Sign in',
      description: null,
    })
  })
})
