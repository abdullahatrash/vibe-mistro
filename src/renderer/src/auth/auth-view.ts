import type { AuthMethod, AuthState } from '../../../shared/ipc'

/**
 * Pure auth view-state selector (no React, no IPC). Maps the detected
 * `AuthState` plus the agent's advertised `authMethods` to what the renderer
 * renders: a distinct sign-in panel when not signed in, nothing otherwise. Per
 * ADR-0001 the renderer owns this; main classifies + relays the AuthState.
 */

/** Render a sign-in panel — the method name + a (not-yet-wired) Sign-in button. */
export interface SignInView {
  kind: 'sign-in'
  methodId: string
  methodName: string
  description: string | null
}

/** Render nothing auth-related (signed in, or state not yet known). */
export interface NoAuthView {
  kind: 'none'
}

export type AuthView = SignInView | NoAuthView

export interface AuthViewInput {
  authState: AuthState
  authMethods?: AuthMethod[]
}

export function selectAuthView(input: AuthViewInput): AuthView {
  if (input.authState !== 'not-signed-in') return { kind: 'none' }

  const method = input.authMethods?.[0]
  return {
    kind: 'sign-in',
    methodId: method?.id ?? '',
    methodName: method?.name ?? 'Sign in',
    description: method?.description ?? null,
  }
}
