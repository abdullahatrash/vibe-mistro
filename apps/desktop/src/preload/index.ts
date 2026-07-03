import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type DiscoverDevServersResult,
  type AcpEvent,
  type AgentEvictedEvent,
  type MenuActionEvent,
  type CancelTurnArgs,
  type DeleteThreadResult,
  type GitBranchesArgs,
  type GitBranchesResult,
  type GitBranchOpArgs,
  type GitCommitArgs,
  type GitCommitResult,
  type GitActionProgressEvent,
  type GitFullDiffArgs,
  type GitFullDiffResult,
  type GitOpResult,
  type GitRangeDiffArgs,
  type GitRangeDiffResult,
  type GitRevertArgs,
  type GitStackedActionArgs,
  type GitStackedActionResult,
  type GhCreatePrArgs,
  type GhCreateResult,
  type GhCurrentPrArgs,
  type GhPrResult,
  type RevealPathArgs,
  type EditorsListResult,
  type EditorsOpenArgs,
  type EditorsOpenResult,
  type FilesListArgs,
  type FilesListResult,
  type FilesReadArgs,
  type FilesReadResult,
  type OpenExternalArgs,
  type TerminalClearArgs,
  type TerminalCloseArgs,
  type TerminalEvent,
  type TerminalOpenArgs,
  type TerminalOpenResult,
  type TerminalResizeArgs,
  type TerminalRestartArgs,
  type TerminalWriteArgs,
  type GitStatusEvent,
  type GitStatusSubscriptionArgs,
  type ListMetadataResult,
  type ReadTranscriptArgs,
  type ReadTranscriptResult,
  type ThreadSnapshotPutArgs,
  type ReadThreadAttachmentsResult,
  type RemoveWorkspaceResult,
  type RespondPermissionArgs,
  type OpenThreadArgs,
  type SearchQueryArgs,
  type SearchQueryResult,
  type SkillsListArgs,
  type SkillsListResult,
  type SkillsReadArgs,
  type SkillsReadResult,
  type SkillsRevealArgs,
  type SendPromptArgs,
  type SendPromptResult,
  type AccountWhoamiResult,
  type CheckAuthStatusArgs,
  type CheckAuthStatusResult,
  type SetThreadConfigArgs,
  type SetThreadConfigResult,
  type SetThreadFlagsArgs,
  type SetThreadFlagsResult,
  type SignInArgs,
  type SignInResult,
  type SignOutArgs,
  type SignOutResult,
  type StartThreadArgs,
  type StartThreadResult,
  type SetThreadTitleArgs,
  type SetThreadTitleResult,
  type ThreadBoundEvent,
  type ThreadStatusEvent,
  type ThreadTitleEvent,
  type VibeDetectResult,
  type CheckVibeUpdateArgs,
  type VibeUpdateResult,
  type AppUpdateStatusEvent,
} from '../shared/ipc'

/**
 * One streaming-subscription bridge: wrap `ipcRenderer.on(channel)` as an
 * add-listener that returns its own unsubscribe (the `on`+unsubscribe IPC shape).
 * Every `on*` below is this helper at a specific channel + payload type — identical
 * plumbing, so it lives once here.
 */
function subscribe<T>(channel: string): (listener: (event: T) => void) => () => void {
  return (listener) => {
    const handler = (_e: unknown, payload: T): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  }
}

const api = {
  detectVibe: (): Promise<VibeDetectResult> => ipcRenderer.invoke(IPC.detectVibe),
  checkVibeUpdate: (args: CheckVibeUpdateArgs): Promise<VibeUpdateResult> =>
    ipcRenderer.invoke(IPC.checkVibeUpdate, args),
  getAppUpdateStatus: (): Promise<AppUpdateStatusEvent> =>
    ipcRenderer.invoke(IPC.appUpdateGetStatus),
  appUpdateRestart: (): void => ipcRenderer.send(IPC.appUpdateRestart),
  openWorkspaceDialog: (): Promise<string | null> => ipcRenderer.invoke(IPC.openWorkspaceDialog),
  startThread: (args: StartThreadArgs): Promise<StartThreadResult> =>
    ipcRenderer.invoke(IPC.startThread, args),
  openThread: (args: OpenThreadArgs): Promise<StartThreadResult> =>
    ipcRenderer.invoke(IPC.openThread, args),
  sendPrompt: (args: SendPromptArgs): Promise<SendPromptResult> =>
    ipcRenderer.invoke(IPC.sendPrompt, args),
  respondPermission: (args: RespondPermissionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.respondPermission, args),
  cancelTurn: (args: CancelTurnArgs): Promise<void> => ipcRenderer.invoke(IPC.cancelTurn, args),
  signIn: (args: SignInArgs): Promise<SignInResult> => ipcRenderer.invoke(IPC.signIn, args),
  signOut: (args: SignOutArgs): Promise<SignOutResult> => ipcRenderer.invoke(IPC.signOut, args),
  checkAuthStatus: (args: CheckAuthStatusArgs): Promise<CheckAuthStatusResult> =>
    ipcRenderer.invoke(IPC.checkAuthStatus, args),
  accountWhoami: (): Promise<AccountWhoamiResult> => ipcRenderer.invoke(IPC.accountWhoami),
  stopAgent: (agentId: string): Promise<void> => ipcRenderer.invoke(IPC.stopAgent, agentId),
  setActiveAgent: (agentId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.setActiveAgent, agentId),
  listMetadata: (): Promise<ListMetadataResult> => ipcRenderer.invoke(IPC.listMetadata),
  deleteThread: (threadId: string): Promise<DeleteThreadResult> =>
    ipcRenderer.invoke(IPC.deleteThread, threadId),
  removeWorkspace: (workspaceId: string): Promise<RemoveWorkspaceResult> =>
    ipcRenderer.invoke(IPC.removeWorkspace, workspaceId),
  getThreadStatuses: (): Promise<ThreadStatusEvent[]> => ipcRenderer.invoke(IPC.getThreadStatuses),
  setThreadConfig: (args: SetThreadConfigArgs): Promise<SetThreadConfigResult> =>
    ipcRenderer.invoke(IPC.setThreadConfig, args),
  setThreadFlags: (args: SetThreadFlagsArgs): Promise<SetThreadFlagsResult> =>
    ipcRenderer.invoke(IPC.setThreadFlags, args),
  setThreadTitle: (args: SetThreadTitleArgs): Promise<SetThreadTitleResult> =>
    ipcRenderer.invoke(IPC.setThreadTitle, args),
  readTranscript: (args: ReadTranscriptArgs): Promise<ReadTranscriptResult> =>
    ipcRenderer.invoke(IPC.readTranscript, args),
  putThreadSnapshot: (args: ThreadSnapshotPutArgs): void => {
    ipcRenderer.send(IPC.threadSnapshotPut, args)
  },
  readThreadAttachments: (threadId: string): Promise<ReadThreadAttachmentsResult> =>
    ipcRenderer.invoke(IPC.readThreadAttachments, threadId),
  searchQuery: (args: SearchQueryArgs): Promise<SearchQueryResult> =>
    ipcRenderer.invoke(IPC.searchQuery, args),
  skillsList: (args: SkillsListArgs): Promise<SkillsListResult> =>
    ipcRenderer.invoke(IPC.skillsList, args),
  skillsReveal: (args: SkillsRevealArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.skillsReveal, args),
  skillsRead: (args: SkillsReadArgs): Promise<SkillsReadResult> =>
    ipcRenderer.invoke(IPC.skillsRead, args),
  gitSubscribeStatus: (args: GitStatusSubscriptionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.gitSubscribeStatus, args),
  gitUnsubscribeStatus: (args: GitStatusSubscriptionArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.gitUnsubscribeStatus, args),
  gitFullDiff: (args: GitFullDiffArgs): Promise<GitFullDiffResult> =>
    ipcRenderer.invoke(IPC.gitFullDiff, args),
  gitRangeDiff: (args: GitRangeDiffArgs): Promise<GitRangeDiffResult> =>
    ipcRenderer.invoke(IPC.gitRangeDiff, args),
  gitCommit: (args: GitCommitArgs): Promise<GitCommitResult> => ipcRenderer.invoke(IPC.gitCommit, args),
  gitRevert: (args: GitRevertArgs): Promise<GitOpResult> => ipcRenderer.invoke(IPC.gitRevert, args),
  gitBranches: (args: GitBranchesArgs): Promise<GitBranchesResult> =>
    ipcRenderer.invoke(IPC.gitBranches, args),
  gitCheckout: (args: GitBranchOpArgs): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.gitCheckout, args),
  gitCreateBranch: (args: GitBranchOpArgs): Promise<GitOpResult> =>
    ipcRenderer.invoke(IPC.gitCreateBranch, args),
  gitRunStackedAction: (args: GitStackedActionArgs): Promise<GitStackedActionResult> =>
    ipcRenderer.invoke(IPC.gitRunStackedAction, args),
  ghCurrentPr: (args: GhCurrentPrArgs): Promise<GhPrResult> =>
    ipcRenderer.invoke(IPC.ghCurrentPr, args),
  ghCreatePr: (args: GhCreatePrArgs): Promise<GhCreateResult> =>
    ipcRenderer.invoke(IPC.ghCreatePr, args),
  revealPath: (args: RevealPathArgs): Promise<void> => ipcRenderer.invoke(IPC.revealPath, args),
  filesList: (args: FilesListArgs): Promise<FilesListResult> => ipcRenderer.invoke(IPC.filesList, args),
  filesRead: (args: FilesReadArgs): Promise<FilesReadResult> => ipcRenderer.invoke(IPC.filesRead, args),
  openExternal: (args: OpenExternalArgs): Promise<void> => ipcRenderer.invoke(IPC.openExternal, args),
  editorsList: (): Promise<EditorsListResult> => ipcRenderer.invoke(IPC.editorsList),
  editorsOpen: (args: EditorsOpenArgs): Promise<EditorsOpenResult> =>
    ipcRenderer.invoke(IPC.editorsOpen, args),
  discoverDevServers: (): Promise<DiscoverDevServersResult> =>
    ipcRenderer.invoke(IPC.discoverDevServers),
  terminalOpen: (args: TerminalOpenArgs): Promise<TerminalOpenResult> =>
    ipcRenderer.invoke(IPC.terminalOpen, args),
  terminalWrite: (args: TerminalWriteArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalWrite, args),
  terminalResize: (args: TerminalResizeArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalResize, args),
  terminalClose: (args: TerminalCloseArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalClose, args),
  terminalClear: (args: TerminalClearArgs): Promise<void> =>
    ipcRenderer.invoke(IPC.terminalClear, args),
  terminalRestart: (args: TerminalRestartArgs): Promise<TerminalOpenResult> =>
    ipcRenderer.invoke(IPC.terminalRestart, args),
  onAcpEvent: subscribe<AcpEvent>(IPC.acpEvent),
  onTerminalEvent: subscribe<TerminalEvent>(IPC.terminalEvent),
  onThreadBound: subscribe<ThreadBoundEvent>(IPC.threadBound),
  onThreadStatus: subscribe<ThreadStatusEvent>(IPC.threadStatus),
  onThreadTitle: subscribe<ThreadTitleEvent>(IPC.threadTitle),
  onAgentEvicted: subscribe<AgentEvictedEvent>(IPC.agentEvicted),
  onMenuAction: subscribe<MenuActionEvent>(IPC.menuAction),
  onAppUpdateStatus: subscribe<AppUpdateStatusEvent>(IPC.appUpdateStatus),
  onGitStatus: subscribe<GitStatusEvent>(IPC.gitStatus),
  onGitActionProgress: subscribe<GitActionProgressEvent>(IPC.gitActionProgress),
}

export type VibeMistroApi = typeof api

contextBridge.exposeInMainWorld('api', api)
