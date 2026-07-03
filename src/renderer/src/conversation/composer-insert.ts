/**
 * A tiny module-level channel for the Files preview's "Insert into composer" action (#189,
 * ADR-0013 decision 2). The preview lives in the side panel — a SIBLING of the conversation, not
 * a parent — so it can't reach the composer through props/context. Instead it EMITS an insert for
 * a Thread id here; the mounted `Conversation` for that Thread SUBSCRIBES (keyed by its own
 * `threadId`) and stages the path as a pending-context FILE chip (#230), re-serialized to a
 * plain-text `@path` mention at send. Renderer-only, no IPC: the wire format is untouched — the
 * agent expands the plain-text `@path` itself server-side (ADR-0002; no client-side expansion).
 *
 * If no composer is mounted for the target Thread (e.g. the active Thread is a cold replay), the
 * emit is a harmless no-op — there is no subscriber to receive it. Reveal-in-Finder does not go
 * through here and works regardless.
 */

/** A subscriber receiving the plain-text fragment to append to its Thread's composer draft. */
type InsertListener = (mention: string) => void

/**
 * A pre-split image to stage in a Thread's composer (#224 element picker): `data` is BARE
 * base64 (sent to the agent), `previewUrl` the full data URL (thumbnail + echoed turn) —
 * the exact shape the composer's `PendingImage` needs, so the subscriber just adds an id.
 */
export interface ComposerInsertImage {
  data: string
  mimeType: string
  name: string
  previewUrl: string
}

type ImageListener = (image: ComposerInsertImage) => void

const listenersByThread = new Map<string, Set<InsertListener>>()
const textListenersByThread = new Map<string, Set<InsertListener>>()
const imageListenersByThread = new Map<string, Set<ImageListener>>()

/** Subscribe a Thread's composer to insert requests; returns an unsubscribe. */
export function subscribeComposerInsert(threadId: string, listener: InsertListener): () => void {
  let set = listenersByThread.get(threadId)
  if (!set) {
    set = new Set()
    listenersByThread.set(threadId, set)
  }
  set.add(listener)
  return () => {
    const current = listenersByThread.get(threadId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) listenersByThread.delete(threadId)
  }
}

/** Request the given Thread's composer append `@<relativePath>`; a no-op if none is mounted. */
export function emitComposerInsert(threadId: string, relativePath: string): void {
  const set = listenersByThread.get(threadId)
  if (!set) return
  for (const listener of set) listener(relativePath)
}

/**
 * Append RAW text to `draft` (the Terminal Surface's "Add to chat", ADR-0014 slice 4):
 * no `@` prefix, no chip, no forced trailing space — the selection is inserted verbatim
 * (deliberately NOT a pending-context chip, #230). A newline separates it from prior draft content
 * (terminal selections are often multi-line), unless the draft is empty or already ends
 * in whitespace. Pure — the composer writes state + persisted draft together with the result.
 */
export function appendText(draft: string, text: string): string {
  if (draft.length === 0) return text
  const separator = /\s$/.test(draft) ? '' : '\n'
  return `${draft}${separator}${text}`
}

/** Subscribe a Thread's composer to RAW-text insert requests; returns an unsubscribe. */
export function subscribeComposerInsertText(threadId: string, listener: InsertListener): () => void {
  let set = textListenersByThread.get(threadId)
  if (!set) {
    set = new Set()
    textListenersByThread.set(threadId, set)
  }
  set.add(listener)
  return () => {
    const current = textListenersByThread.get(threadId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) textListenersByThread.delete(threadId)
  }
}

/** Request the given Thread's composer append raw `text`; a no-op if none is mounted. */
export function emitComposerInsertText(threadId: string, text: string): void {
  const set = textListenersByThread.get(threadId)
  if (!set) return
  for (const listener of set) listener(text)
}

/**
 * Subscribe a Thread's composer to IMAGE insert requests (#224): the Browser Surface's
 * element picker stages a screenshot as a pending image through here — a side-panel
 * sibling reaching the composer, keyed by threadId, exactly like the text/@ channels.
 * Returns an unsubscribe.
 */
export function subscribeComposerInsertImage(threadId: string, listener: ImageListener): () => void {
  let set = imageListenersByThread.get(threadId)
  if (!set) {
    set = new Set()
    imageListenersByThread.set(threadId, set)
  }
  set.add(listener)
  return () => {
    const current = imageListenersByThread.get(threadId)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) imageListenersByThread.delete(threadId)
  }
}

/** Request the given Thread's composer stage `image`; a no-op if none is mounted. */
export function emitComposerInsertImage(threadId: string, image: ComposerInsertImage): void {
  const set = imageListenersByThread.get(threadId)
  if (!set) return
  for (const listener of set) listener(image)
}
