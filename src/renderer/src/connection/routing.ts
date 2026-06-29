import type { AuthMethod, StartThreadResult, ThreadConnection } from '../../../shared/ipc'

/**
 * Pure connection routing (no React, no IPC). Maps a `startThread` /
 * `openThread` result to the next ConnectState — including consulting auth
 * state to route to the sign-in panel instead of a raw error dead-end. Per
 * ADR-0001 the renderer owns this view routing.
 */
export type ConnectState =
  | { status: 'idle' }
  | { status: 'connecting'; workspaceDir: string }
  | { status: 'connected'; thread: ThreadConnection }
  | { status: 'not-signed-in'; agentId: string; workspaceDir: string; authMethods: AuthMethod[] }
  | { status: 'error'; message: string; hint: string | null }

/** Route a thread-open result (start or open-on-existing) to a ConnectState. */
export function routeThreadResult(result: StartThreadResult): ConnectState {
  if (result.ok) return { status: 'connected', thread: result.thread }
  if (result.kind === 'not-signed-in') {
    return {
      status: 'not-signed-in',
      agentId: result.agentId,
      workspaceDir: result.workspaceDir,
      authMethods: result.authMethods,
    }
  }
  return { status: 'error', message: result.error, hint: result.hint }
}
