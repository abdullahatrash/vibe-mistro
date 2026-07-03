import { useRef, useState, type FormEvent, type JSX } from 'react'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { cn } from '../lib/utils'
import {
  buildWebviewPreferencesAttribute,
  deriveBrowserPartition,
  stripElectronUserAgent,
} from '../../../shared/browser-guest'
import { normalizeBrowserUrl } from './browser-url'

/**
 * The Browser Surface (#216, ADR-0015): an embedded dev-server preview on the Electron
 * `<webview>` tag — a real DOM node, so it lays out/clips/resizes inside the panel like
 * any other Surface (the t3code "Preview" decision, minus their root-mounted overlay:
 * our view is DISPOSABLE — unmounting discards the page; the URL survives in the store
 * for slice 2's persistence).
 *
 * Navigation is RENDERER-DRIVEN: the component talks to the webview element directly
 * (loadURL/goBack/events); main's involvement is the `will-attach-webview` clamp and
 * guest popup routing. Every URL the webview is asked to load passes
 * `normalizeBrowserUrl` first — http/https only, schemes like `file:` refused.
 */
export function BrowserSurface({ workspaceDir }: { workspaceDir: string }): JSX.Element {
  const webviewRef = useRef<WebviewElement | null>(null)
  // The first blessed URL becomes the webview's `src`; later submissions go through
  // `loadURL`. `null` = nothing loaded yet → the URL-entry empty state.
  const [initialUrl, setInitialUrl] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)

  function submitAddress(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const url = normalizeBrowserUrl(address)
    if (!url) return
    setAddress(url)
    if (initialUrl === null) {
      setInitialUrl(url)
      return
    }
    void webviewRef.current?.loadURL(url).catch(() => {
      // A load interrupted by a newer navigation rejects — the did-navigate
      // listener is the source of truth, nothing to do here.
    })
  }

  // The webview only exposes its state through DOM events — wire them via a callback
  // ref (the element mounts late, only once a first URL exists).
  function attachWebview(el: WebviewElement | null): void {
    webviewRef.current = el
    if (!el) return
    const sync = (): void => {
      setAddress(el.getURL())
      setCanGoBack(el.canGoBack())
      setCanGoForward(el.canGoForward())
    }
    el.addEventListener('did-navigate', sync)
    el.addEventListener('did-navigate-in-page', sync)
  }

  if (initialUrl === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
        <form onSubmit={submitAddress} className="w-full max-w-sm text-center">
          <h3 className="text-sm font-medium text-text-strong">Preview a dev server</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            Enter the URL of a local dev server — or any http(s) page.
          </p>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label="Address"
            placeholder="localhost:5173"
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              'mt-4 w-full rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] text-text',
              'placeholder:text-faint focus:outline-none focus-visible:border-accent/60',
            )}
          />
        </form>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <BrowserAction label="Back" onClick={() => webviewRef.current?.goBack()} disabled={!canGoBack}>
          <ArrowLeft aria-hidden />
        </BrowserAction>
        <BrowserAction
          label="Forward"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!canGoForward}
        >
          <ArrowRight aria-hidden />
        </BrowserAction>
        <BrowserAction label="Reload" onClick={() => webviewRef.current?.reload()}>
          <RotateCw aria-hidden />
        </BrowserAction>
        <form onSubmit={submitAddress} className="min-w-0 flex-1">
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              'w-full rounded-md border border-transparent bg-accent/5 px-2.5 py-1 text-xs text-text',
              'placeholder:text-faint focus:outline-none focus-visible:border-accent/60 focus-visible:bg-surface',
            )}
          />
        </form>
      </div>
      {/* The guest page. `partition`/`webpreferences`/`useragent` must be set before
          attach and never change — main's clamp re-verifies them (webview-clamp.ts). */}
      <webview
        ref={attachWebview}
        src={initialUrl}
        partition={deriveBrowserPartition(workspaceDir)}
        webpreferences={buildWebviewPreferencesAttribute()}
        useragent={stripElectronUserAgent(navigator.userAgent)}
        className="min-h-0 flex-1 bg-white"
      />
    </div>
  )
}

/** The slice of Electron's WebviewTag the Surface drives (renderer must not import electron). */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
}

/** A browser toolbar icon button — the TerminalAction idiom. */
function BrowserAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded text-muted outline-none transition-colors',
        'hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10',
        'disabled:pointer-events-none disabled:opacity-40',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
      )}
    >
      {children}
    </button>
  )
}
