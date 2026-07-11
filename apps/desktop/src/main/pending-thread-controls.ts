import type { ThreadAgentControls, ThreadControlIntent } from '../shared/ipc'
import {
  controlsWithCurrentValue,
  validatedThreadControlChanges,
} from '../shared/thread-control-intent'

export interface PendingThreadControlAgent {
  setMode(sessionId: string, modeId: string): Promise<void>
  setModel(sessionId: string, modelId: string): Promise<void>
  setReasoningEffort(sessionId: string, value: string): Promise<void>
}

/**
 * Validate pending ids against the newly bound session, apply valid changes in ACP
 * setter order, and return the session state the renderer should display.
 */
export async function applyPendingThreadControls(
  agent: PendingThreadControlAgent,
  sessionId: string,
  intent: ThreadControlIntent,
  reported: ThreadAgentControls,
  onError: (error: unknown) => void = () => {},
): Promise<ThreadAgentControls> {
  let actual = reported
  for (const change of validatedThreadControlChanges(intent, reported)) {
    try {
      if (change.axis === 'mode') await agent.setMode(sessionId, change.value)
      else if (change.axis === 'model') await agent.setModel(sessionId, change.value)
      else await agent.setReasoningEffort(sessionId, change.value)
      actual = controlsWithCurrentValue(actual, change.axis, change.value)
    } catch (error) {
      onError(error)
    }
  }
  return actual
}
