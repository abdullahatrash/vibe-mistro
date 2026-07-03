import { useEffect, useRef, useState, type JSX } from 'react'
import { Check, Copy } from 'lucide-react'
import type { VibeDetectResult } from '../../../shared/ipc'
import { INSTALL_COMMAND, INSTALL_DOCS_URL, INSTALL_HINT } from '../../../shared/install-guidance'
import { Button } from '../ui/button'
import { CodeText } from '../ui/code-text'
import { Environment } from '../settings/Environment'
import { Logo } from './logo'
import { heroHeadline } from './hero-headline'
import type { FirstRunState } from './first-run'

/**
 * The first-run / empty outlet shown when nothing is connected or selected (#49).
 * Driven by the pure `firstRunState`: when `vibe` / `vibe-acp` is missing the env
 * status is surfaced PROMINENTLY here (the user can't proceed until it's installed);
 * when the toolchain's present but no Workspaces exist it nudges Open-project; once
 * everything's set up it's a neutral placeholder (env tucked behind settings).
 */
export function EmptyState({
  state,
  detect,
  loading,
  opening,
  workspaceName,
  onRecheck,
  onOpenProject,
}: {
  state: FirstRunState
  detect: VibeDetectResult | null
  loading: boolean
  opening: boolean
  /** The selected Workspace's name, emphasized in the idle hero headline (or null). */
  workspaceName: string | null
  onRecheck: () => void
  onOpenProject: () => void
}): JSX.Element {
  if (state === 'needs-install') {
    return (
      <div className="flex max-w-[460px] flex-col items-start gap-3">
        <div className="text-[15px] font-semibold text-text-strong">
          Install Mistral Vibe to get started
        </div>
        {/* Same canonical copy as the spawn-error hint + the persistent banner
            (shared/install-guidance) — one root cause, one message. */}
        <p className="hint">
          vibe-mistro drives the <code>vibe-acp</code> ACP server. <CodeText text={INSTALL_HINT} />{' '}
          <a className="underline" href={INSTALL_DOCS_URL} target="_blank" rel="noreferrer">
            Install guide
          </a>
        </p>
        <Environment detect={detect} loading={loading} onRecheck={onRecheck} />
      </div>
    )
  }
  if (state === 'no-workspaces') {
    // Same hero shape as the idle state below (logo + big headline, centered in
    // the outlet) so first run doesn't look like an afterthought; the CLI
    // install steps ride along in a quiet card for users who land here fresh.
    return (
      <div className="mx-auto flex h-full max-w-[830px] flex-col items-center justify-center gap-6 text-center">
        <Logo size={52} />
        <h1 className="text-[37px] font-semibold tracking-[-0.6px] text-text-strong">
          Open a <span className="text-accent-emphasis">project</span> to begin
        </h1>
        <p className="hint">
          Each project runs its own Mistral Vibe agent — open one to start your first thread.
        </p>
        <Button size="lg" onClick={onOpenProject} disabled={opening}>
          {opening ? 'Connecting…' : 'Open project'}
        </Button>
        <div className="mt-2 w-full max-w-[500px] rounded-lg border border-border bg-surface px-4 py-3.5 text-left">
          <div className="text-[13px] font-semibold text-text-strong">New to Mistral Vibe?</div>
          <ol className="mt-2 flex flex-col gap-2 text-[13px] text-text-secondary">
            <li className="flex flex-col gap-1">
              <span>1. Install the CLI:</span>
              <span className="flex items-center gap-1.5 rounded-md border border-border bg-sidebar py-0.5 pr-0.5 pl-2">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-text">
                  {INSTALL_COMMAND}
                </code>
                <CopyCommandButton text={INSTALL_COMMAND} />
              </span>
            </li>
            <li>
              2. Run <CodeText text="`vibe`" /> once to sign in
            </li>
          </ol>
          <a
            className="mt-2 inline-block text-[12px] text-accent-text underline-offset-2 hover:underline"
            href={INSTALL_DOCS_URL}
            target="_blank"
            rel="noreferrer"
          >
            Install guide
          </a>
        </div>
      </div>
    )
  }
  // idle — the empty-state hero: a centered logo + a dynamic headline with the
  // selected Workspace name in orange (`--accent-emphasis`).
  const headline = heroHeadline(workspaceName)
  return (
    <div className="mx-auto flex h-full max-w-[830px] flex-col items-center justify-center gap-6 text-center">
      <Logo size={52} />
      <h1 className="text-[37px] font-semibold tracking-[-0.6px] text-text-strong">
        {headline.lead}
        {headline.name && <span className="text-accent-emphasis">{headline.name}</span>}
        {headline.tail}
      </h1>
      <p className="hint">
        Select a thread from the sidebar to view it, or open a project to start a live agent.
      </p>
    </div>
  )
}

/**
 * The install-command copy control: icon flips to a check for a beat on success
 * (title flips to "Failed to copy" on a rejected clipboard write — never silent).
 * Same StrictMode-safe mounted guard as the transcript's MessageCopyButton (#263):
 * set true in SETUP, not just the initializer, or dev's mount rehearsal leaves it
 * false forever and every click silently bails.
 */
function CopyCommandButton({ text }: { text: string }): JSX.Element {
  const [feedback, setFeedback] = useState<'copied' | 'failed' | null>(null)
  const timeoutRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    }
  }, [])
  function onCopy(): void {
    navigator.clipboard.writeText(text).then(
      () => showFeedback('copied'),
      () => showFeedback('failed'),
    )
  }
  function showFeedback(next: 'copied' | 'failed'): void {
    if (!mountedRef.current) return
    setFeedback(next)
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current)
    timeoutRef.current = window.setTimeout(() => {
      if (mountedRef.current) setFeedback(null)
    }, 1500)
  }
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className="flex-none"
      onClick={onCopy}
      aria-label="Copy install command"
      title={feedback === 'failed' ? 'Failed to copy' : 'Copy'}
    >
      {feedback === 'copied' ? (
        <Check className="size-3.5 text-ok" aria-hidden />
      ) : (
        <Copy className="size-3.5" aria-hidden />
      )}
    </Button>
  )
}
