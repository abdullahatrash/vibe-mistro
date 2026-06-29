import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'
import {
  IPC,
  type ListMetadataResult,
  type OpenThreadArgs,
  type RespondPermissionArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type ThreadConnection,
  type ThreadInfo,
} from '../shared/ipc'
import { detectVibe } from './vibe-detect'
import { getShellEnv } from './shell-env'
import { groupThreadsByWorkspace, MetadataStore } from './persistence/metadata-store'
import {
  acpEventEntry,
  resolvePermissionEntry,
  TranscriptStore,
  userPromptEntry,
  type TranscriptEntry,
} from './persistence/transcript'
import { WorkspaceAgent, WorkspaceAgentError } from './workspace-agent'

/** Active Workspace agents keyed by a generated agent id. */
const agents = new Map<string, WorkspaceAgent>()

/**
 * The single-writer metadata index (ADR-0005). Assigned at app-ready (needs
 * `userData`) and loaded before the first window so the renderer's cold list
 * fetch sees the persisted state. A failed load degrades to empty, never throws.
 */
let metadataStore: MetadataStore | null = null

/**
 * The per-Thread transcript writer (ADR-0005, TB2). Assigned at app-ready (needs
 * `userData`) alongside `metadataStore`. Best-effort like the metadata writes —
 * a failed tee never breaks the live conversation.
 */
let transcriptStore: TranscriptStore | null = null

/**
 * Bridge the ACP-keyed event flow to the JSONL key. Streamed events + permission
 * replies cross main keyed by `agentId` (the chokepoints carry no `sessionId`),
 * but the transcript is keyed by the minted Thread `id` (TB1). We populate this
 * `agentId -> threadId` index when a Thread is recorded; the store's
 * `findThreadIdBySessionId` is the secondary path (e.g. `sendPrompt`, which does
 * carry a `sessionId`). A miss skips the tee — never breaking the live flow.
 */
const transcriptThreads = new Map<string, string>()

/** Resolve the active Thread id for a chokepoint, or null to skip the tee. */
function threadIdForTee(agentId: string, sessionId?: string | null): string | null {
  return (
    transcriptThreads.get(agentId) ?? metadataStore?.findThreadIdBySessionId(sessionId ?? null) ?? null
  )
}

/**
 * Tee one conversation INPUT to the active Thread's JSONL (ADR-0005). Best-effort
 * and fire-and-forget, guarded exactly like `recordThread`: an absent store or an
 * unresolved Thread id skips the write; the append itself swallows I/O errors.
 */
function teeTranscript(threadId: string | null, entry: TranscriptEntry): void {
  if (!transcriptStore || !threadId) return
  void transcriptStore.append(threadId, entry)
}

/**
 * Persist that this Workspace was opened and a Thread minted. The Thread gets a
 * durable id (minted by the store) distinct from its ACP `sessionId`, which is
 * stored as the resume cursor for a later reopen (TB3). Best-effort: a metadata
 * write must never break the live connect flow. Also seeds the `agentId ->
 * threadId` transcript bridge so the agent's streamed events tee to this Thread.
 */
async function recordThread(agentId: string, workspaceDir: string, thread: ThreadInfo): Promise<void> {
  if (!metadataStore) return
  try {
    const ws = await metadataStore.upsertWorkspace({
      dir: workspaceDir,
      displayName: basename(workspaceDir),
    })
    const record = await metadataStore.upsertThread({
      workspaceId: ws.id,
      sessionId: thread.sessionId,
      title: thread.title,
    })
    transcriptThreads.set(agentId, record.id)
  } catch {
    // A persistence failure is non-fatal — the user is still connected.
  }
}

/**
 * Persist that a Workspace was opened, BEFORE the agent starts, so even a
 * not-signed-in Workspace lists. Best-effort exactly like `recordThread`: a
 * failing `persist()` (disk full / read-only userData) must NEVER reject the
 * connect flow — the renderer's onClick has no `.catch`, so a throw here would
 * wedge the UI on "Launching…".
 */
async function recordWorkspaceOpen(workspaceDir: string): Promise<void> {
  if (!metadataStore) return
  try {
    await metadataStore.upsertWorkspace({
      dir: workspaceDir,
      displayName: basename(workspaceDir),
    })
  } catch {
    // A persistence failure is non-fatal — the connect flow proceeds.
  }
}

/** Build the renderer-facing connection (carries the sign-out gate + methods). */
function connectionFor(agentId: string, agent: WorkspaceAgent, thread: ThreadInfo): ThreadConnection {
  return {
    agentId,
    workspaceDir: agent.workspaceDir,
    ...thread,
    signOutAvailable: agent.signOutAvailable,
    authMethods: agent.authMethods,
  }
}

/**
 * Map a thread-open failure to a result. An auth-classified error (a -32000
 * mid-session/expiry) keeps the agent ALIVE and routes to the sign-in panel;
 * any other failure stops + disposes the agent.
 */
function threadFailureResult(agentId: string, agent: WorkspaceAgent, err: unknown): StartThreadResult {
  if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
    // Keep the agent alive AND registered so the renderer's follow-up
    // signIn({agentId}) finds it. Idempotent: startThread already registers on a
    // successful start(), but a -32000 thrown from start() itself reaches here
    // before that, so without this the child would leak + the button would dead-end.
    agents.set(agentId, agent)
    return { ok: false, kind: 'not-signed-in', agentId, workspaceDir: agent.workspaceDir, authMethods: agent.authMethods }
  }
  agent.stop()
  agents.delete(agentId)
  if (err instanceof WorkspaceAgentError) return { ok: false, kind: 'error', error: err.message, hint: err.hint }
  return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err), hint: null }
}

/** Stop + drop any live agent bound to this workspace (dedup before re-spawn). */
function disposeAgentsForWorkspace(workspaceDir: string): void {
  for (const [id, agent] of agents) {
    if (agent.workspaceDir !== workspaceDir) continue
    agent.stop()
    agents.delete(id)
  }
}
let agentCounterSeed = 0

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.detectVibe, () => detectVibe())

  ipcMain.handle(IPC.openWorkspaceDialog, async (event): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle(IPC.startThread, async (event, args: StartThreadArgs): Promise<StartThreadResult> => {
    // Dedup: dispose any existing agent for this workspace before spawning, so a
    // re-Connect (e.g. after a not-signed-in panel) can't orphan the previous child.
    disposeAgentsForWorkspace(args.workspaceDir)

    const agentId = `a${++agentCounterSeed}`
    const agent = new WorkspaceAgent({
      workspaceDir: args.workspaceDir,
      env: getShellEnv(),
      // Delegated sign-in (#12): open the returned signInUrl in the system browser.
      openUrl: (url) => void shell.openExternal(url),
    })

    agent.on('event', (payload: unknown) => {
      // Tee each streamed payload to the active Thread's transcript (ADR-0005)
      // before forwarding it — best-effort, never gating the live forward.
      teeTranscript(threadIdForTee(agentId), acpEventEntry(payload))
      if (!event.sender.isDestroyed()) {
        event.sender.send(IPC.acpEvent, { agentId, payload })
      }
    })

    // Persist the Workspace open up front (ADR-0005), so even a not-signed-in
    // Workspace shows in the cold list. Best-effort — must not reject connect.
    await recordWorkspaceOpen(args.workspaceDir)

    try {
      await agent.start()
      agents.set(agentId, agent)

      // Detected not-signed-in: keep the agent (the sign-in flow drives it) but
      // don't open a Thread — session/new would fail with -32000. The renderer
      // shows the sign-in panel and re-tries openThread after sign-in.
      if (agent.authState === 'not-signed-in') {
        return { ok: false, kind: 'not-signed-in', agentId, workspaceDir: args.workspaceDir, authMethods: agent.authMethods }
      }

      const thread = await agent.openThread()
      await recordThread(agentId, args.workspaceDir, thread)
      return { ok: true, thread: connectionFor(agentId, agent, thread) }
    } catch (err) {
      return threadFailureResult(agentId, agent, err)
    }
  })

  ipcMain.handle(IPC.openThread, async (_event, args: OpenThreadArgs): Promise<StartThreadResult> => {
    // Open a Thread on an agent already started + signed in (after sign-in or an
    // in-place re-auth). Reuses the retained agent — no re-spawn.
    const agent = agents.get(args.agentId)
    if (!agent) return { ok: false, kind: 'error', error: `No active agent for id ${args.agentId}.`, hint: null }
    try {
      const thread = await agent.openThread()
      await recordThread(args.agentId, agent.workspaceDir, thread)
      return { ok: true, thread: connectionFor(args.agentId, agent, thread) }
    } catch (err) {
      return threadFailureResult(args.agentId, agent, err)
    }
  })

  ipcMain.handle(
    IPC.sendPrompt,
    async (_event, args: SendPromptArgs): Promise<SendPromptResult> => {
      const agent = agents.get(args.agentId)
      if (!agent) return { ok: false, kind: 'error', error: `No active agent for id ${args.agentId}.` }
      // Tee the user's prompt (the conversation INPUT) before sending it, so it
      // precedes the streamed events it triggers. Main has no renderer item id,
      // so we mint one — it's an opaque replay key, never matched against.
      teeTranscript(threadIdForTee(args.agentId, args.sessionId), userPromptEntry(randomUUID(), args.text))
      try {
        const result = await agent.prompt(args.sessionId, args.text)
        return { ok: true, result }
      } catch (err) {
        // Mid-session expiry (-32000): keep the agent alive so the renderer can
        // re-auth in place on the same agent; don't stop it.
        if (err instanceof WorkspaceAgentError && err.authState === 'not-signed-in') {
          return { ok: false, kind: 'not-signed-in', agentId: args.agentId, authMethods: agent.authMethods }
        }
        return { ok: false, kind: 'error', error: err instanceof Error ? err.message : String(err) }
      }
    },
  )

  ipcMain.handle(IPC.respondPermission, (_event, args: RespondPermissionArgs) => {
    // Main only relays the user's choice back to the agent by request id; the
    // approve/deny decision lives in the renderer (ADR-0001). We also tee the
    // choice to the transcript — main sees requestId + optionId but not the
    // option's display name (renderer-side), so the entry's `name` is null.
    const agent = agents.get(args.agentId)
    teeTranscript(threadIdForTee(args.agentId), resolvePermissionEntry(args.requestId, args.optionId))
    agent?.respondPermission(args.requestId, args.optionId)
  })

  ipcMain.handle(IPC.signIn, async (_event, args: SignInArgs): Promise<SignInResult> => {
    // Drive Vibe's browser sign-in on the agent retained from startThread; main
    // orchestrates + relays the resulting AuthState, the renderer owns the view
    // state (ADR-0001). Credentials never touch us — Vibe owns the keyring (ADR-0003).
    const agent = agents.get(args.agentId)
    if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
    try {
      const authState = await agent.signIn(args.methodId)
      return { ok: true, authState }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.signOut, async (_event, args: SignOutArgs): Promise<SignOutResult> => {
    // Sign out via Vibe's keyring removal and relay the new state; the agent
    // stays alive so the user can sign a different account back in (ADR-0003).
    const agent = agents.get(args.agentId)
    if (!agent) return { ok: false, error: `No active agent for id ${args.agentId}.` }
    try {
      const authState = await agent.signOut()
      return { ok: true, authState, authMethods: agent.authMethods }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(IPC.stopAgent, (_event, agentId: string) => {
    const agent = agents.get(agentId)
    agent?.stop()
    agents.delete(agentId)
  })

  ipcMain.handle(IPC.listMetadata, (): ListMetadataResult => {
    // The cold launch list (ADR-0005): persisted Workspaces + Threads from
    // metadata alone — no agent spawned, no transcript loaded.
    if (!metadataStore) return []
    return groupThreadsByWorkspace(metadataStore.snapshot())
  })
}

app.whenReady().then(async () => {
  // Load the persisted index before the first window so the renderer's launch
  // fetch sees prior Workspaces/Threads. `userData` is only valid once ready.
  metadataStore = new MetadataStore({ filePath: join(app.getPath('userData'), 'metadata.json') })
  await metadataStore.load()

  // The per-Thread transcript dir (ADR-0005). `appendFile` won't create parent
  // dirs, so ensure it exists once here; a failure leaves `transcriptStore` null
  // and teeing becomes a silent no-op (best-effort — the conversation is fine).
  const transcriptsDir = join(app.getPath('userData'), 'transcripts')
  try {
    await mkdir(transcriptsDir, { recursive: true })
    transcriptStore = new TranscriptStore({ dir: transcriptsDir })
  } catch {
    transcriptStore = null
  }

  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // The agents Map is process-global, which is fine for single-window TB1.
  // A future multi-window slice should track + dispose agents per window.
  for (const agent of agents.values()) agent.stop()
  agents.clear()
  if (process.platform !== 'darwin') app.quit()
})
