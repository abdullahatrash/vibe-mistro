import { serializeForSend, type PendingContext } from './pending-contexts'
import type { QueuedMessage } from './follow-up-queue'
import {
  serializeInlineTokensForSend,
  type ComposerInlineToken,
} from './composer-inline-tokens'
import type { ComposerDraftImage } from './composer-draft-store'

export interface ComposerSendImage {
  data: string
  mimeType: string
  previewUrl: string
}

export interface ComposerSendSnapshot {
  hasContent: boolean
  text: string
  images: ComposerSendImage[]
  restore: {
    prompt: string
    inlineTokens: ComposerInlineToken[]
    contexts: PendingContext[]
    images: ComposerDraftImage[]
  }
}

export interface ComposerLiveState {
  prompt: string
  inlineTokens: readonly ComposerInlineToken[]
  contexts: readonly PendingContext[]
  images: readonly ComposerDraftImage[]
}

export function createComposerSendSnapshot({
  prompt,
  inlineTokens,
  contexts,
  images,
}: {
  prompt: string
  inlineTokens: readonly ComposerInlineToken[]
  contexts: readonly PendingContext[]
  images: readonly ComposerDraftImage[]
}): ComposerSendSnapshot {
  const restoreInlineTokens = inlineTokens.map((token) => ({ ...token })) as ComposerInlineToken[]
  const restoreContexts = contexts.map((context) => ({ ...context })) as PendingContext[]
  const restoreImages = images.map((image) => ({ ...image }))
  const sendImages = images.map(({ data, mimeType, previewUrl }) => ({ data, mimeType, previewUrl }))
  const text = serializeInlineTokensForSend(serializeForSend(prompt, restoreContexts), restoreInlineTokens)
  return {
    hasContent: text.length > 0 || sendImages.length > 0,
    text,
    images: sendImages,
    restore: {
      prompt,
      inlineTokens: restoreInlineTokens,
      contexts: restoreContexts,
      images: restoreImages,
    },
  }
}

export function restoreFailedSendSnapshot(
  snapshot: ComposerSendSnapshot,
  current: ComposerLiveState,
): ComposerSendSnapshot['restore'] {
  if (
    current.prompt.length > 0 ||
    current.inlineTokens.length > 0 ||
    current.contexts.length > 0 ||
    current.images.length > 0
  ) {
    return {
      prompt: current.prompt,
      inlineTokens: current.inlineTokens.map((token) => ({ ...token })) as ComposerInlineToken[],
      contexts: [...current.contexts],
      images: current.images.map((image) => ({ ...image })),
    }
  }
  return {
    prompt: snapshot.restore.prompt,
    inlineTokens: snapshot.restore.inlineTokens.map((token) => ({ ...token })) as ComposerInlineToken[],
    contexts: snapshot.restore.contexts.map((context) => ({ ...context })) as PendingContext[],
    images: snapshot.restore.images.map((image) => ({ ...image })),
  }
}

export function createQueuedFollowUp(id: string, snapshot: ComposerSendSnapshot): QueuedMessage {
  return {
    id,
    text: snapshot.text,
    images: snapshot.images.map((image) => ({ ...image })),
  }
}
