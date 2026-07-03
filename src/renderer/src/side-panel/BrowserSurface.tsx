import { useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { ArrowLeft, ArrowRight, RotateCw } from 'lucide-react'
import { cn } from '../lib/utils'
import {
  buildWebviewPreferencesAttribute,
  deriveBrowserPartition,
  stripElectronUserAgent,
} from '../../../shared/browser-guest'
import { normalizeBrowserUrl } from './browser-url'
import {
  canGoBackNav,
  canGoForwardNav,
  goBackNav,
  goForwardNav,
  INITIAL_NAV,
  pushNav,
  type NavState,
} from './browser-nav-history'

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
  // The mounted webview as STATE (not a ref): the `setView` setter is identity-stable,
  // so React invokes the callback ref only on real mount/unmount — an inline-closure
  // ref would re-fire per render and leak one listener pair each time.
  const [view, setView] = useState<WebviewElement | null>(null)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  // The first blessed URL becomes the webview's `src`; later submissions go through
  // `loadURL`. `null` = nothing loaded yet → the URL-entry empty state.
  const [initialUrl, setInitialUrl] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  // Back/forward availability is tracked from navigation EVENTS via the pure model —
  // the webview element's own canGoBack()/canGoForward() are unreliable (they report
  // false against a genuine multi-entry history). `pending` records that the NEXT
  // did-navigate is the result of our own back/forward/reload, so the handler shifts
  // (or ignores) the cursor instead of pushing a fresh entry.
  const [nav, setNav] = useState<NavState>(INITIAL_NAV)
  const pending = useRef<'back' | 'forward' | 'reload' | null>(null)

  function submitAddress(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const url = normalizeBrowserUrl(address)
    if (!url) return
    setAddress(url)
    if (initialUrl === null) {
      setInitialUrl(url)
      return
    }
    void view?.loadURL(url).catch((err: unknown) => {
      // A load superseded by a newer navigation rejects benignly, but so do real
      // failures — log rather than swallow (#217 turns this into an unreachable state).
      console.error('[browser] loadURL failed', url, err)
    })
  }

  // NB: navigate by OFFSET, not goBack()/goForward() — the webview tag's goBack/
  // goForward (and canGoBack) are broken in Electron's <webview> (they no-op against
  // a genuine multi-entry history), but goToOffset works. Our own nav model is the
  // source of truth for whether an offset is available.
  function goBack(): void {
    pending.current = 'back'
    view?.goToOffset(-1)
  }
  function goForward(): void {
    pending.current = 'forward'
    view?.goToOffset(1)
  }
  function reload(): void {
    pending.current = 'reload'
    view?.reload()
  }

  // The webview only exposes its state through DOM events — wire them once per
  // mounted element, unwiring on unmount/remount.
  useEffect(() => {
    if (!view) return
    const onNavigate = (): void => {
      // Never clobber an address the user is mid-typing: the guest can navigate
      // (redirects, SPA pushState) while the bar has focus.
      if (document.activeElement !== addressInputRef.current) setAddress(view.getURL())
      // Advance the cursor per what caused this navigation. A reload adds no entry.
      const cause = pending.current
      pending.current = null
      if (cause === 'reload') return
      setNav((s) =>
        cause === 'back' ? goBackNav(s) : cause === 'forward' ? goForwardNav(s) : pushNav(s),
      )
    }
    const logFailure = (event: Event): void => {
      pending.current = null
      const { errorCode, errorDescription, validatedURL } = event as unknown as {
        errorCode?: number
        errorDescription?: string
        validatedURL?: string
      }
      // -3 is Chromium's ERR_ABORTED — a superseded/cancelled load, not a failure.
      if (errorCode === -3) return
      console.error('[browser] load failed', validatedURL, errorCode, errorDescription)
    }
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigate)
    view.addEventListener('did-fail-load', logFailure)
    return () => {
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigate)
      view.removeEventListener('did-fail-load', logFailure)
    }
  }, [view])

  const canGoBack = canGoBackNav(nav)
  const canGoForward = canGoForwardNav(nav)

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
        <BrowserAction label="Back" onClick={goBack} disabled={!canGoBack}>
          <ArrowLeft aria-hidden />
        </BrowserAction>
        <BrowserAction label="Forward" onClick={goForward} disabled={!canGoForward}>
          <ArrowRight aria-hidden />
        </BrowserAction>
        <BrowserAction label="Reload" onClick={reload}>
          <RotateCw aria-hidden />
        </BrowserAction>
        <form onSubmit={submitAddress} className="min-w-0 flex-1">
          <input
            ref={addressInputRef}
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
        ref={setView as (el: HTMLElement | null) => void}
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
  /** Navigate by history offset — the working primitive (goBack/goForward are broken). */
  goToOffset(offset: number): void
  reload(): void
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
