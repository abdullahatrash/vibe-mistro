import {
  useEffect,
  useCallback,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
} from 'react'
import { ArrowUp, Clipboard, File, Mic, MessageSquareText, MousePointerClick, Plus, Sparkles, Square, X } from 'lucide-react'
import type {
  FileEntry,
  ThreadConfigAxis,
  ThreadModels,
  ThreadModes,
  ThreadReasoningEffort,
} from '../../../shared/ipc'
import { AgentControls } from './AgentControls'
import { Card } from '../ui/card'
import { IconButton } from '../ui/icon-button'
import { cn } from '../lib/utils'
import type { AcpCommand } from './reducer'
import { useComposerDraft, type ComposerDraftImage } from './composer-draft-store'
import {
  appendText,
  subscribeComposerInsert,
  subscribeComposerInsertElement,
  subscribeComposerInsertImage,
  subscribeComposerInsertReviewComment,
  subscribeComposerInsertTerminal,
  subscribeComposerInsertText,
} from './composer-insert'
import { ACCEPTED_IMAGE_TYPES, isAcceptedImageType, parseDataUrl } from './image-attach'
import {
  addContext,
  contextKey,
  isLongPaste,
  pastedLabel,
  removeContext,
  type PendingContext,
} from './pending-contexts'
import { nextQueueId, type FollowUpQueue } from './follow-up-queue'
import { useComposerAutocomplete, CompletionPopover } from './use-composer-autocomplete'
import { createCommandSource, createPathSource } from './composer-sources'
import {
  createComposerSendSnapshot,
  createQueuedFollowUp,
  restoreFailedSendSnapshot,
} from './composer-send-lifecycle'
import { ComposerPromptEditor } from './ComposerPromptEditor'
import type { ComposerEditorHandle } from './composer-editor-handle'
import {
  createTerminalInlineToken,
  getSlashCommandInlineToken,
  insertTerminalInlineTokenAt,
  pruneInactiveInlineTokens,
  setSlashCommandInlineToken,
} from './composer-inline-tokens'
import {
  createComposerHistoryState,
  navigateComposerHistory,
  reconcileComposerHistoryEdit,
  resetComposerHistoryState,
  shouldNavigateComposerHistory,
  type ComposerHistoryDirection,
} from './composer-history'

/** Process-local counters for unique pending-image / element / review / paste-chip ids (not Math.random/Date). */
let imageSeq = 0
let elementSeq = 0
let reviewSeq = 0
let pasteSeq = 0
let terminalSeq = 0

/** A review chip's compact line-range suffix, e.g. `:10-12` / `:7` — empty when unlocated. */
function reviewRange(context: { startLine: number | null; endLine: number | null }): string {
  if (context.startLine === null || context.endLine === null) return ''
  return context.startLine === context.endLine
    ? `:${context.startLine}`
    : `:${context.startLine}-${context.endLine}`
}

/** A pending-context chip's visible label, per kind. */
function chipLabel(context: PendingContext): string {
  switch (context.kind) {
    case 'skill':
      return `/${context.name}`
    case 'file':
      return context.path
    case 'element':
      return context.selector ?? `<${context.tagName}>`
    case 'review':
      return `${context.filePath}${reviewRange(context)}`
    case 'pasted':
      return pastedLabel(context)
  }
}

/** A pasted chip's hover preview — the head of the text, capped so the tooltip stays sane. */
const PASTE_TITLE_PREVIEW_CHARS = 400

/** A pending-context chip's hover detail (`title`), per kind. */
function chipTitle(context: PendingContext): string | undefined {
  switch (context.kind) {
    case 'skill':
      return context.description
    case 'file':
      return context.path
    case 'element':
      return [
        `<${context.tagName}>`,
        context.selector ?? '',
        context.text.trim(),
        context.pageUrl,
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    case 'review':
      return [`${context.filePath}${reviewRange(context)}`, context.note, '', context.excerpt].join('\n')
    case 'pasted':
      return context.text.length > PASTE_TITLE_PREVIEW_CHARS
        ? `${context.text.slice(0, PASTE_TITLE_PREVIEW_CHARS)}…`
        : context.text
  }
}

/** The picker's `accept` list — the accepted image mime types, comma-joined. */
const IMAGE_ACCEPT = ACCEPTED_IMAGE_TYPES.join(',')

/**
 * The composer: the Thread's input surface (quality-review slice 4 split from Conversation).
 * Owns its own renderer-only state — the per-Thread persisted draft (#60), the staged images
 * awaiting send (#100), and the unified `/`+`@` autocomplete (#95/#190) — plus the queued
 * follow-up strip (#105). It hands a composed message UP to the container via `submitPrompt`
 * (idle send) or `followUps.enqueue` (while a turn streams); the container owns the turn
 * lifecycle and drains the queue. Keyed by `threadId` through its parent's remount, so all of
 * this state seeds fresh per Thread.
 */
export function Composer({
  threadId,
  agentId,
  boundSessionId,
  isProcessing,
  isEmpty,
  availableCommands,
  sentPromptHistory,
  followUps,
  submitPrompt,
  modes,
  models,
  reasoningEffort,
  onSetConfig,
}: {
  threadId: string
  agentId: string
  /** The Thread's bound session, or null for a pre-prompt draft (#75). */
  boundSessionId: string | null
  /** A turn is streaming for this Thread (#115): disables controls, shows Stop. */
  isProcessing: boolean
  /** No conversation yet — drives the placeholder copy. */
  isEmpty: boolean
  /** The Vibe-streamed slash commands for the `/` autocomplete (#95). */
  availableCommands: AcpCommand[]
  /** Visible text from this Thread's prior sent prompts, chronological. */
  sentPromptHistory: readonly string[]
  /** This Thread's follow-up queue (#105) — send-vs-queue, the queued strip, drain. */
  followUps: FollowUpQueue
  /** Send ONE message as a fresh turn (owned by the container). Resolves ok/failed. */
  submitPrompt: (
    text: string,
    images: Array<{ data: string; mimeType: string; previewUrl: string }>,
  ) => Promise<boolean>
  /** Agent controls (#66): display-from-session-state. */
  modes: ThreadModes | null
  models: ThreadModels | null
  reasoningEffort: ThreadReasoningEffort | null
  onSetConfig?: (axis: ThreadConfigAxis, value: string, sessionId: string | null) => void
}): JSX.Element {
  // The composer's unsent text, persisted per-Thread to localStorage (#60) so it
  // survives any unmount (cold↔live, agent eviction/re-warm, app restart, switching
  // to a cold Thread). This view is keyed by `threadId` through its parent, so it
  // REMOUNTS on a Thread switch — the lazy initializer seeds THAT Thread's stored
  // draft fresh, with no stale carry-over (no re-seed effect needed). Reading here
  // must not write, so we only persist on change/send below.
  const [composerDraft, setComposerDraft, clearPersistedDraft, draftPersistenceError] =
    useComposerDraft(threadId)
  const draft = composerDraft.prompt
  const slashCommandToken = getSlashCommandInlineToken(composerDraft.inlineTokens)
  const pendingImages = composerDraft.images
  const pendingContexts = composerDraft.contextAttachments
  const nonPersistedImageIds = useMemo(
    () => new Set(composerDraft.nonPersistedImageIds),
    [composerDraft.nonPersistedImageIds],
  )
  const liveComposerStateRef = useRef({
    prompt: draft,
    inlineTokens: composerDraft.inlineTokens,
    contexts: pendingContexts,
    images: pendingImages,
  })
  liveComposerStateRef.current = {
    prompt: draft,
    inlineTokens: composerDraft.inlineTokens,
    contexts: pendingContexts,
    images: pendingImages,
  }
  const inputRef = useRef<ComposerEditorHandle>(null)
  // Shell-style sent-prompt recall is per mounted Thread. The transcript owns the entries;
  // only the cursor + current unsent scratch are transient refs, so arrow navigation does not
  // add render work to the hot editor path.
  const historyStateRef = useRef(createComposerHistoryState())
  const historyAppliedValueRef = useRef<string | null>(null)
  // The hidden file picker behind the 📎 button (#100).
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dragDepthRef = useRef(0)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)
  // The shared `files:list` listing (ADR-0013 decision 5), fetched ONCE per composer
  // mount on the first `@` (lazy) and cached here — ranking runs in the renderer, so no
  // per-keystroke IPC. `requestedRef` guards the single fetch; a failed/empty listing is
  // tolerated (the popup just shows nothing — a typed `@path` still sends fine, the agent
  // resolves it). Addressed by the connection's `agentId`, like the Files Surface.
  const [pathEntries, setPathEntries] = useState<FileEntry[]>([])
  const pathEntriesRequestedRef = useRef(false)

  // Fetch the shared `files:list` listing ONCE per composer mount, lazily on the first
  // `@` (ADR-0013 decision 5). Serves main's per-Workspace cache (no `refresh`), so it is
  // cheap; a failure is swallowed — the popup just stays empty and a typed `@path` still
  // sends. The resolved entries land in state, which re-renders the open popover with them.
  function ensurePathEntries(): void {
    if (pathEntriesRequestedRef.current) return
    pathEntriesRequestedRef.current = true
    void window.api.filesList({ agentId }).then(
      (result) => setPathEntries(result.entries),
      () => {
        /* tolerate a failed listing — typed paths still send; the agent resolves them */
      },
    )
  }

  // Write-through: keep React state and the persisted draft (#60) in lockstep. The
  // autocomplete hook calls this when it accepts a completion; the textarea's onChange
  // and the composer-insert subscription use it too.
  function writeDraft(
    next: string | ((current: string) => string),
    options?: { fromHistory?: boolean },
  ): void {
    if (!options?.fromHistory) historyStateRef.current = createComposerHistoryState()
    setComposerDraft((current) => {
      const prompt = typeof next === 'function' ? next(current.prompt) : next
      return {
        ...current,
        prompt,
        inlineTokens: pruneInactiveInlineTokens(prompt, current.inlineTokens),
      }
    })
  }

  const setPendingContexts = useCallback((
    next: PendingContext[] | ((current: PendingContext[]) => PendingContext[]),
  ): void => {
    setComposerDraft((current) => ({
      ...current,
      contextAttachments:
        typeof next === 'function' ? next(current.contextAttachments) : next,
    }))
  }, [setComposerDraft])

  const setPendingImages = useCallback((
    next: ComposerDraftImage[] | ((current: ComposerDraftImage[]) => ComposerDraftImage[]),
  ): void => {
    setComposerDraft((current) => ({
      ...current,
      images: typeof next === 'function' ? next(current.images) : next,
    }))
  }, [setComposerDraft])

  function setSlashCommandToken(command: AcpCommand | null): void {
    setComposerDraft((current) => ({
      ...current,
      inlineTokens: setSlashCommandInlineToken(current.inlineTokens, command),
    }))
  }

  // The `/` (#95) and `@` (#190) autocompletes, unified into ONE state machine over two
  // priority-ordered sources (command first, so it wins when both tokens overlap).
  const commandSource = useMemo(() => createCommandSource(availableCommands), [availableCommands])
  const pathSource = useMemo(
    () => createPathSource({ entries: pathEntries, onFirstOpen: ensurePathEntries }),
    // ensurePathEntries is stable (refs + agentId); rebuild only when the listing lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pathEntries],
  )
  const sources = useMemo(() => [commandSource, pathSource], [commandSource, pathSource])
  const autocomplete = useComposerAutocomplete(
    sources,
    draft,
    writeDraft,
    inputRef,
    (context) => setPendingContexts((prev) => addContext(prev, context)),
    (token) => {
      if (token.kind === 'slashCommand') setSlashCommandToken(token)
    },
  )

  // Insert from the Files preview's action (#189): the side panel is a sibling of this
  // view, so it reaches the composer through the module-level `composer-insert` channel
  // keyed by threadId. The path stages as a prompt-level file chip and is serialized
  // into the legacy trailing <attached_files> block at send.
  useEffect(() => {
    return subscribeComposerInsert(threadId, (relativePath) => {
      setPendingContexts((prev) => addContext(prev, { kind: 'file', path: relativePath }))
      inputRef.current?.focus()
    })
  }, [setPendingContexts, threadId])

  // Insert raw text annotations from sibling surfaces that still use plain text (for
  // example Browser Surface screenshot notes), keyed by Thread id.
  useEffect(() => {
    return subscribeComposerInsertText(threadId, (text) => {
      writeDraft((current) => appendText(current, text))
      inputRef.current?.focus()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId])

  // Insert a Terminal selection as a positional Inline token (#313): the visible
  // reference lands at the current caret, while the full terminal output stays in
  // structured draft metadata and serializes as supporting context at send.
  useEffect(() => {
    return subscribeComposerInsertTerminal(threadId, ({ source, output }) => {
      const token = createTerminalInlineToken({
        id: `terminal:${terminalSeq++}`,
        source,
        output,
      })
      let nextCaret: number | null = null
      setComposerDraft((current) => {
        const caret = inputRef.current?.getSelectionStart() ?? current.prompt.length
        const inserted = insertTerminalInlineTokenAt(current.prompt, caret, token)
        nextCaret = inserted.caret
        return {
          ...current,
          prompt: inserted.value,
          inlineTokens: [...pruneInactiveInlineTokens(inserted.value, current.inlineTokens), token],
        }
      })
      requestAnimationFrame(() => {
        const input = inputRef.current
        if (!input || nextCaret === null) return
        input.focus()
        input.setSelectionRange(nextCaret, nextCaret)
      })
    })
  }, [setComposerDraft, threadId])

  // Stage a STANDALONE image from the Browser Surface (#226 page screenshot): a plain
  // attachment with no structured pick behind it — arrives pre-split through the
  // module-level channel keyed by threadId, so we just add an id.
  useEffect(() => {
    return subscribeComposerInsertImage(threadId, (image) => {
      setPendingImages((prev) => [...prev, { id: `img:${imageSeq++}`, ...image }])
      inputRef.current?.focus()
    })
  }, [setPendingImages, threadId])

  // Stage a Browser Surface element pick (#224/#231): the ONE payload — element metadata
  // + optional pre-split screenshot — arrives through the module-level channel keyed by
  // threadId. The screenshot stages as a pending image; the element stages as a chip
  // carrying that image's id, so removing the chip removes its screenshot with it.
  useEffect(() => {
    return subscribeComposerInsertElement(threadId, ({ element, image }) => {
      let imageId: string | null = null
      if (image) {
        imageId = `img:${imageSeq++}`
        setPendingImages((prev) => [...prev, { id: imageId as string, ...image }])
      }
      setPendingContexts((prev) =>
        addContext(prev, { kind: 'element', id: `el:${elementSeq++}`, ...element, imageId }),
      )
      inputRef.current?.focus()
    })
  }, [setPendingContexts, setPendingImages, threadId])

  // Stage a Review Surface diff comment (#239): file + located line range + note +
  // verbatim diff excerpt arrive through the module-level channel keyed by threadId;
  // each comment is its own removable chip, several accumulate into one prompt and
  // flatten into a trailing <review_comments> block at send.
  useEffect(() => {
    return subscribeComposerInsertReviewComment(threadId, (comment) => {
      setPendingContexts((prev) => addContext(prev, { kind: 'review', id: `rc:${reviewSeq++}`, ...comment }))
      inputRef.current?.focus()
    })
  }, [setPendingContexts, threadId])

  // Read a pasted/picked image blob to a data URL (DOM: FileReader lives here, not
  // in the pure module), split it into bare base64 + mime via `parseDataUrl`, and
  // stage it. Non-accepted types are skipped up front so we don't read junk.
  function addFile(file: File | Blob, name: string): void {
    if (!isAcceptedImageType(file.type)) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : ''
      const parsed = parseDataUrl(dataUrl)
      if (!parsed) return
      setPendingImages((prev) => [
        ...prev,
        { id: `img:${imageSeq++}`, data: parsed.data, mimeType: parsed.mimeType, name, previewUrl: dataUrl },
      ])
    }
    reader.readAsDataURL(file)
  }

  // Clipboard paste (#100): stage any pasted image files. A LONG text paste stages as a
  // pending-context chip instead of splicing into the draft (t3code's inline-token
  // treatment, via our ADR-0017 chips) — the composer stays compact and the full text
  // rides a trailing <pasted_text> block at send. `preventDefault` fires ONLY when we
  // handled the paste ourselves, so a normal short text paste is untouched.
  function onPaste(e: ClipboardEvent<HTMLDivElement>): void {
    let handled = false
    for (const item of e.clipboardData.items) {
      if (item.kind !== 'file' || !isAcceptedImageType(item.type)) continue
      const file = item.getAsFile()
      if (!file) continue
      addFile(file, file.name || 'pasted-image')
      handled = true
    }
    if (!handled) {
      // CRLF-normalized so line counts and the wire block are stable across sources.
      const text = e.clipboardData.getData('text/plain').replace(/\r\n/g, '\n')
      if (isLongPaste(text)) {
        setPendingContexts((prev) => addContext(prev, { kind: 'pasted', id: `paste:${pasteSeq++}`, text }))
        handled = true
      }
    }
    if (handled) e.preventDefault()
  }

  // File picker (#100): stage each selected image, then reset the input value so
  // re-picking the SAME file fires `change` again.
  function onPickFiles(e: ChangeEvent<HTMLInputElement>): void {
    const files = e.target.files
    if (files) for (const file of files) addFile(file, file.name)
    e.target.value = ''
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current += 1
    setIsDraggingFiles(true)
  }

  function onDragOver(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setIsDraggingFiles(false)
  }

  function onDrop(e: DragEvent<HTMLDivElement>): void {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragDepthRef.current = 0
    setIsDraggingFiles(false)
    for (const file of e.dataTransfer.files) addFile(file, file.name)
    inputRef.current?.focus()
  }

  function removeImage(id: string): void {
    setPendingImages((prev) => prev.filter((img) => img.id !== id))
  }

  // Composer submit (Enter or the Send/Queue button). When a turn is streaming we
  // ENQUEUE the composer payload and clear the composer (it flushes on the next turn
  // end); when idle we send immediately, preserving #100's clear-on-success /
  // keep-on-failure UX (a failed send keeps the text + staged images for retry).
  async function send(): Promise<void> {
    const snapshot = createComposerSendSnapshot({
      prompt: draft,
      inlineTokens: composerDraft.inlineTokens,
      contexts: pendingContexts,
      images: pendingImages,
    })
    if (!snapshot.hasContent) return
    historyStateRef.current = resetComposerHistoryState()
    historyAppliedValueRef.current = null
    if (followUps.sending) {
      // A turn is live for this Thread (authoritative module latch, not the per-
      // instance reducer snapshot which lags on a remount) — queue it (protocol forbids
      // a concurrent prompt) and clear the composer so the user can compose the next
      // follow-up. It auto-flushes on the next turn end.
      followUps.enqueue(createQueuedFollowUp(nextQueueId(), snapshot))
      clearPersistedDraft()
      return
    }
    // Idle: send now, clearing the composer OPTIMISTICALLY — `submitPrompt` resolves
    // only when the whole turn ENDS (the IPC returns at the turn's stopReason), so a
    // clear-after-await would hold the sent text in the input for the entire streamed
    // response. The echo is already in the transcript; on a FAILED outcome we RESTORE
    // the payload for retry (#100's keep-on-failure, e.g. switching to a vision model
    // after -31008) — unless the user started composing something new meanwhile.
    clearPersistedDraft()
    const ok = await submitPrompt(snapshot.text, snapshot.images)
    if (!ok) {
      // Restore the PRE-serialize prose + chips (not the flattened wire text), so a
      // retry re-serializes cleanly instead of double-prepending the invocation.
      const restored = restoreFailedSendSnapshot(snapshot, liveComposerStateRef.current)
      setComposerDraft((current) => ({
        ...current,
        prompt: restored.prompt,
        inlineTokens: restored.inlineTokens,
        contextAttachments: restored.contexts,
        images: restored.images,
      }))
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    // The autocomplete intercepts nav/accept/Esc while open; when it doesn't handle the
    // key (closed, or a non-nav key), Enter falls through to send.
    if (autocomplete.onKeyDown(e)) return
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const direction: ComposerHistoryDirection = e.key === 'ArrowUp' ? 'previous' : 'next'
      const selection = inputRef.current?.getSelection() ?? null
      if (
        selection &&
        shouldNavigateComposerHistory({
          direction,
          autocompleteOpen: autocomplete.open,
          selectionCollapsed: selection.collapsed,
          caretLine: selection.caretLine,
        })
      ) {
        const navigation = navigateComposerHistory(
          sentPromptHistory,
          historyStateRef.current,
          draft,
          direction,
        )
        if (navigation) {
          e.preventDefault()
          historyStateRef.current = navigation.state
          historyAppliedValueRef.current = navigation.value
          writeDraft(navigation.value, { fromHistory: true })
          requestAnimationFrame(() => {
            inputRef.current?.focus()
            inputRef.current?.setSelectionRange(navigation.value.length, navigation.value.length)
          })
          return
        }
      }
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && slashCommandToken) {
      const caret = inputRef.current?.getSelectionStart() ?? draft.length
      if (caret === 0) {
        e.preventDefault()
        setSlashCommandToken(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  return (
    // @container: the composer adapts to ITS OWN width (container queries), not the
    // viewport's — with the sidebar + side panel open the chat column narrows while
    // the window stays wide, so viewport breakpoints would never fire.
    <div className="conv-measure @container">
      {/* shadow-xs: a lighter lift than the Card default — the composer sits over the
          transcript, so the full shadow-sm read as a heavy smudge under it. */}
      <Card
        className={cn(
          'gap-0 p-0 shadow-xs transition-colors',
          isDraggingFiles && 'border-accent bg-[var(--accent-tint)]',
        )}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="flex flex-col px-6 pt-[22px] pb-[14px] @max-[480px]:px-4">
          {followUps.queued.length > 0 && (
            // Queued follow-ups (#105, ADR-0009): messages submitted while a turn
            // streams, auto-flushed one per turn end. Each row shows its text (or a
            // `📎 N image(s)` label when text-empty; a `📎 N` marker when it has both)
            // and a ✕ to drop it. Edit-in-place is deferred.
            <div className="mb-3 flex flex-col gap-1">
              {followUps.queued.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-2 rounded-lg border border-border bg-panel px-2 py-1"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-text">
                    {m.text
                      ? m.text
                      : `📎 ${m.images.length} image${m.images.length === 1 ? '' : 's'}`}
                    {m.text && m.images.length > 0 && (
                      <span className="text-muted"> 📎 {m.images.length}</span>
                    )}
                  </span>
                  <IconButton
                    size="icon-xs"
                    aria-label="Remove queued message"
                    onClick={() => followUps.remove(m.id)}
                  >
                    <X className="size-3.5" aria-hidden />
                  </IconButton>
                </div>
              ))}
            </div>
          )}

          {(slashCommandToken || pendingContexts.length > 0) && (
            // Token/chip row (#229/#230/#231/#309): the structured slash command token and
            // pending attachments staged beside the draft, with a remove action per chip.
            // Removing an ELEMENT chip also removes its paired screenshot (one payload in,
            // one gesture out); removing the thumbnail alone keeps the chip (screenshot is
            // optional context, the pick isn't).
            <div className="mb-3 flex flex-wrap gap-2">
              {slashCommandToken && (
                <span
                  data-inline-token-chip
                  title={slashCommandToken.description}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] py-0.5 pr-1 pl-1.5 font-mono text-xs leading-none text-accent-text"
                >
                  <Sparkles className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">/{slashCommandToken.name}</span>
                  <button
                    type="button"
                    aria-label={`Remove /${slashCommandToken.name}`}
                    onClick={() => setSlashCommandToken(null)}
                    className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-accent-text outline-none hover:bg-[var(--accent-tint-border)]"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              )}
              {pendingContexts.map((context) => (
                <span
                  key={contextKey(context)}
                  data-pending-context-chip
                  title={chipTitle(context)}
                  className="inline-flex max-w-full items-center gap-1 rounded-md border border-[var(--accent-tint-border)] bg-[var(--accent-tint)] py-0.5 pr-1 pl-1.5 font-mono text-xs leading-none text-accent-text"
                >
                  {context.kind === 'skill' ? (
                    <Sparkles className="size-3 shrink-0" aria-hidden />
                  ) : context.kind === 'file' ? (
                    <File className="size-3 shrink-0" aria-hidden />
                  ) : context.kind === 'review' ? (
                    <MessageSquareText className="size-3 shrink-0" aria-hidden />
                  ) : context.kind === 'pasted' ? (
                    <Clipboard className="size-3 shrink-0" aria-hidden />
                  ) : (
                    <MousePointerClick className="size-3 shrink-0" aria-hidden />
                  )}
                  <span className="truncate">{chipLabel(context)}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${chipLabel(context)}`}
                    onClick={() => {
                      setPendingContexts((prev) => removeContext(prev, contextKey(context)))
                      if (context.kind === 'element' && context.imageId) {
                        removeImage(context.imageId)
                      }
                    }}
                    className="inline-flex size-3.5 shrink-0 items-center justify-center rounded-sm text-accent-text outline-none hover:bg-[var(--accent-tint-border)]"
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
          )}

          {pendingImages.length > 0 && (
            // Staged-image strip (#100): thumbnails with a ✕ remove, above the input.
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingImages.map((img) => {
                const sessionOnly = nonPersistedImageIds.has(img.id)
                return (
                  <div
                    key={img.id}
                    className="relative size-14"
                    title={sessionOnly ? `${img.name} is current-session-only` : img.name}
                  >
                    <img
                      className="size-14 rounded-lg border border-border object-cover"
                      src={img.previewUrl}
                      alt={img.name}
                    />
                    {sessionOnly && (
                      <span className="absolute bottom-0 left-0 max-w-full rounded-tr-md rounded-bl-lg bg-panel/95 px-1 py-0.5 text-[9px] leading-none text-muted">
                        Session only
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${img.name}`}
                      onClick={() => removeImage(img.id)}
                      className="absolute -top-1.5 -right-1.5 inline-flex size-[18px] items-center justify-center rounded-full border border-border bg-panel text-text outline-none"
                    >
                      <X className="size-3" aria-hidden />
                    </button>
                  </div>
                )
              })}
            </div>
          )}

          {draftPersistenceError && (
            <p role="status" className="mb-3 text-xs text-bad">
              Draft changes are available now but could not be saved for the next app launch.
            </p>
          )}

          <div className="relative">
            {autocomplete.open && autocomplete.activeSource && (
              <CompletionPopover
                source={autocomplete.activeSource}
                rows={autocomplete.rows}
                activeIndex={autocomplete.activeIndex}
                activeRowRef={autocomplete.activeRowRef}
                onAccept={autocomplete.accept}
              />
            )}
            <ComposerPromptEditor
              ref={inputRef}
              className="min-h-0 resize-none border-0 bg-transparent p-0 text-[17px] leading-normal focus-visible:border-0"
              placeholder={isEmpty ? 'Ask anything…' : 'Ask for follow-up changes'}
              value={draft}
              onChange={(value, caret) => {
                // Lexical may echo one controlled history value more than once. Keep its cursor
                // alive until the value actually DIFFERS; that difference is the real user edit.
                const reconciled = reconcileComposerHistoryEdit(
                  historyStateRef.current,
                  historyAppliedValueRef.current,
                  value,
                )
                historyStateRef.current = reconciled.state
                historyAppliedValueRef.current = reconciled.appliedValue
                // Write-through: keep React state and the persisted draft (#60) in lockstep.
                writeDraft(value, { fromHistory: true })
                // Re-derive the `/` (#95) and `@` (#190) triggers from the new value + caret.
                autocomplete.onInput(value, caret)
              }}
              // Caret moves (arrows/click) with no edit also open/close the triggers.
              onSelect={(value, caret) => autocomplete.onInput(value, caret)}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
            />
          </div>

          <input
            ref={fileInputRef}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            onChange={onPickFiles}
          />

          {/* Control row (prototype: 44px gap below the input). Attach + agent
              controls left; mic + interrupt + gradient send right. */}
          {/* min-w-0 lets the AgentControls chips absorb the squeeze (they shrink +
              truncate) so the send button NEVER leaves the card in a narrow column. */}
          <div className="mt-[44px] flex min-w-0 items-center gap-3.5 @max-[560px]:gap-2">
            <IconButton
              size="icon-sm"
              aria-label="Attach images"
              title="Attach images"
              onClick={() => fileInputRef.current?.click()}
            >
              <Plus className="size-5" aria-hidden />
            </IconButton>

            {/* Agent controls (#66): Mode / Model / Reasoning effort. Vibe-owned,
                between-turns only — disabled WHILE a turn streams. A pre-prompt draft
                (#75) is NOT processing, so its pickers are live: a pick passes the null
                `boundSessionId` up, and App caches it (no IPC — no session yet) to apply
                on the first bind. A bound Thread passes its real session for the IPC. */}
            <AgentControls
              modes={modes}
              models={models}
              reasoningEffort={reasoningEffort}
              disabled={isProcessing}
              onSetConfig={(axis, value) => onSetConfig?.(axis, value, boundSessionId)}
            />

            <div className="flex-1" />

            {/* Decorative voice-input affordance from the prototype; not yet wired.
                First thing to yield in a tight column (it does nothing yet). */}
            <Mic className="size-[19px] shrink-0 text-muted @max-[400px]:hidden" aria-hidden />

            {isProcessing && boundSessionId && (
              // Interrupt the active turn (#103, ADR-0009): fire `session/cancel`. The
              // turn then resolves `cancelled`, which the existing turn-complete path
              // flips `isProcessing` off on — no new local state needed here. Gated on
              // `boundSessionId` so it only shows once there's a turn it can cancel (a
              // draft's first prompt is pre-bind for its session/new round-trip).
              <IconButton
                size="icon-sm"
                variant="stop"
                aria-label="Stop turn"
                title="Stop"
                onClick={() => void window.api.cancelTurn({ agentId, sessionId: boundSessionId })}
              >
                <Square className="size-4" aria-hidden />
              </IconButton>
            )}

            {/* Circular gradient send (prototype: 36px `--accent-grad-action` + glow).
                Icon-only; the Queue-vs-Send distinction (#105) is conveyed via the
                label/tooltip while a turn streams. */}
            <button
              type="button"
              onClick={() => void send()}
              // A staged chip alone is sendable — it serializes to wire text (a bare
              // /skill, @path block, or pasted_text block) even with an empty draft.
              disabled={
                draft.trim().length === 0 &&
                composerDraft.inlineTokens.length === 0 &&
                pendingImages.length === 0 &&
                pendingContexts.length === 0
              }
              aria-label={followUps.sending ? 'Queue message' : 'Send message'}
              title={followUps.sending ? 'Queue' : 'Send'}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-white shadow-[0_1px_2px_var(--accent-shadow)] outline-none transition-opacity [background:var(--accent-grad-action)] hover:opacity-90 disabled:cursor-default disabled:opacity-40 @max-[560px]:size-8"
            >
              <ArrowUp className="size-5 @max-[560px]:size-4" aria-hidden />
            </button>
          </div>
        </div>
      </Card>
    </div>
  )
}
