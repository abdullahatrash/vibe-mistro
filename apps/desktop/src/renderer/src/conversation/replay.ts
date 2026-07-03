import type { TranscriptEntry } from '../../../shared/ipc'
import {
  conversationReducer,
  initialConversationState,
  type ConversationAction,
  type ConversationState,
} from './reducer'

/**
 * Rebuild a Thread's conversation view from its persisted JSONL transcript
 * (ADR-0005, TB3 #32) with NO `vibe-acp` process. Each `TranscriptEntry` maps
 * near-mechanically to the `ConversationAction` it was teed from, and we fold the
 * lot through the EXISTING `conversationReducer` (ADR-0001) — the same code path
 * the live turn used — so a recorded turn replays to the state it produced.
 *
 * Two reopen-only corrections beyond the 1:1 map:
 *  - a `resolve-permission` entry carries `optionId` but `name:null` (main can't
 *    see the renderer-side display name at the chokepoint), so we recover the
 *    chosen option's name from the permission item already folded into state —
 *    making a resolved permission render RESOLVED with the right name, not re-prompt;
 *  - `isProcessing` is forced false at the end: a cold reopen is never mid-turn,
 *    and a log whose final turn was cut off (app closed before its terminal entry)
 *    would otherwise leave a phantom in-flight spinner.
 */
/**
 * A Thread's persisted attachments (`file name -> data URL`), the reply of the
 * batched `readThreadAttachments` IPC. Resolved against each `user-prompt`
 * entry's image refs so a replayed prompt renders its images; a ref whose file
 * is missing from the map (deleted/corrupt on disk) is silently omitted — the
 * prompt degrades to text-only, replay never breaks.
 */
export type AttachmentMap = Readonly<Record<string, string>>

/** Whether any entry references persisted images — gates the attachments IPC. */
export function transcriptHasImages(entries: TranscriptEntry[]): boolean {
  return entries.some((e) => e.t === 'user-prompt' && (e.images?.length ?? 0) > 0)
}

export function replayTranscript(
  entries: TranscriptEntry[],
  attachments?: AttachmentMap,
): ConversationState {
  return foldTranscriptTail(initialConversationState, entries, attachments)
}

/**
 * Fold a transcript TAIL onto an already-folded base state (ADR-0019, #297) —
 * the incremental half of the tiered reopen: hydrate the durable fold snapshot,
 * then fold only the entries beyond its horizon through the SAME reducer. With
 * `initialConversationState` as the base this IS the full replay, so both paths
 * share one fold (and the same reopen-only corrections: permission-name
 * recovery sees the base's items; `isProcessing` is forced false at the end —
 * a cold reopen is never mid-turn).
 */
export function foldTranscriptTail(
  base: ConversationState,
  entries: TranscriptEntry[],
  attachments?: AttachmentMap,
): ConversationState {
  let state = base
  for (const entry of entries) {
    state = conversationReducer(state, toAction(entry, state, attachments))
  }
  return state.isProcessing ? { ...state, isProcessing: false } : state
}

/**
 * Parse a durable fold snapshot's blob back into a `ConversationState`, or null
 * when it doesn't parse or doesn't look like one (torn write, hand-edit, a
 * shape drift the version constant should have caught). Null sends the caller
 * down the `forceFull` full-fold path — a bad snapshot costs one re-fold,
 * never a broken view (snapshots are disposable projections).
 */
export function parseSnapshotState(blob: string): ConversationState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const state = parsed as ConversationState
  if (!Array.isArray(state.items)) return null
  if (typeof state.isProcessing !== 'boolean') return null
  if (!Array.isArray(state.availableCommands)) return null
  return state
}

/**
 * Whether a freshly-hydrated view should be persisted as the durable fold
 * snapshot (ADR-0019, #297). Pure, so the policy is pinned by tests:
 *  - only a view that reflects an exact read horizon (`lastSeq > 0`; the legacy
 *    JSONL engine answers 0 — it never snapshots);
 *  - only when it IMPROVES on what's stored (a fresh fold or a non-empty tail —
 *    re-putting an unchanged snapshot is write noise);
 *  - never an empty view (nothing to accelerate);
 *  - never a view with image attachments: replay embeds them as data URLs, so
 *    the blob would copy image bytes INTO the database (ADR-0019 keeps bytes
 *    out) — image-bearing Threads keep the full-fold path for now.
 */
export function shouldPutSnapshot(args: {
  usedSnapshot: boolean
  tailLength: number
  hasImages: boolean
  itemCount: number
  lastSeq: number
}): boolean {
  if (args.lastSeq <= 0) return false
  if (args.itemCount === 0) return false
  if (args.hasImages) return false
  return !args.usedSnapshot || args.tailLength > 0
}

/** Map one logged entry to its reducer action (using `state` to recover names). */
function toAction(
  entry: TranscriptEntry,
  state: ConversationState,
  attachments?: AttachmentMap,
): ConversationAction {
  switch (entry.t) {
    case 'user-prompt': {
      const images = entry.images
        ?.map((ref) => attachments?.[ref.file])
        .filter((url): url is string => typeof url === 'string')
        .map((previewUrl) => ({ previewUrl }))
      return {
        type: 'send-prompt',
        id: entry.id,
        text: entry.text,
        images: images && images.length > 0 ? images : undefined,
      }
    }
    case 'acp-event':
      return { type: 'acp-event', payload: entry.payload }
    case 'turn-complete':
      return { type: 'turn-complete' }
    case 'turn-error':
      return { type: 'turn-error', message: entry.message }
    case 'agent-rebound':
      return { type: 'agent-rebound' }
    case 'resolve-permission':
      return {
        type: 'resolve-permission',
        requestId: entry.requestId,
        optionId: entry.optionId,
        // The entry's `name` is null (TB2): recover the chosen option's display
        // name from the request event already folded into the permission item.
        name: entry.name ?? recoverOptionName(state, entry.requestId, entry.optionId),
      }
  }
}

/**
 * Recover a chosen permission option's display name from the permission item the
 * earlier `session/request_permission` event folded into state. Falls back to the
 * raw `optionId` if the option can't be matched (defensive — replay never throws).
 */
function recoverOptionName(
  state: ConversationState,
  requestId: number | string,
  optionId: string,
): string {
  const permission = state.items.find(
    (item) => item.kind === 'permission' && item.requestId === requestId,
  )
  if (permission?.kind !== 'permission') return optionId
  return permission.options.find((o) => o.optionId === optionId)?.name ?? optionId
}
