import { useCallback, useEffect, useRef, useState, type FormEvent, type JSX } from 'react'
import { ArrowLeft, ArrowRight, Code, ExternalLink, Globe, Loader2, MousePointerClick, RefreshCw, RotateCw, TriangleAlert } from 'lucide-react'
import type { DevServer } from '../../../shared/ipc'
import { emitComposerInsertElement, type ComposerInsertImage } from '../conversation/composer-insert'
import { parseDataUrl } from '../conversation/image-attach'
import { buildPickerScript, coercePickedElement, cropRectForElement } from './browser-picker'
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
import { INITIAL_LOAD, onFailLoad, onStartLoad, onStopLoad, type LoadState } from './browser-load-state'

/**
 * The Browser Surface (#216 embed, #217 states/persistence; ADR-0015): an embedded
 * dev-server preview on the Electron `<webview>` tag — a real DOM node, so it lays
 * out/clips/resizes inside the panel like any other Surface. Navigation is
 * RENDERER-DRIVEN (the component talks to the element directly); main's involvement is
 * the `will-attach-webview` clamp and guest popup/nav guards. Every URL the webview is
 * asked to load passes `normalizeBrowserUrl` first — http/https only.
 *
 * Slice 2 rounds it into a real browser: a loading indicator, a friendly unreachable
 * state with Retry (built on the pure load-state machine that handles the
 * did-stop-after-did-fail ordering gotcha), the page title in the chrome, open-in-system-
 * browser + DevTools actions, and last-URL persistence via the store (`persistedUrl` in,
 * `onUrlChange` out) so a reopen/restart reloads where the user left off.
 */
export function BrowserSurface({
  workspaceDir,
  persistedUrl,
  onUrlChange,
  activeThreadId,
}: {
  workspaceDir: string
  /** The last-visited URL restored from the store (#217), or undefined for a fresh tab. */
  persistedUrl?: string
  /** Report a committed guest URL up to the store so it persists. */
  onUrlChange: (url: string) => void
  /** The live Thread whose composer a picked element targets (#224); null when none. */
  activeThreadId: string | null
}): JSX.Element {
  // The mounted webview as STATE (not a ref): the `setView` setter is identity-stable,
  // so React invokes the callback ref only on real mount/unmount — an inline-closure
  // ref would re-fire per render and leak one listener pair each time.
  const [view, setView] = useState<WebviewElement | null>(null)
  const addressInputRef = useRef<HTMLInputElement | null>(null)
  // The first blessed URL becomes the webview's `src`; later submissions go through
  // `loadURL`. Seeded from the persisted URL so a reopened tab auto-loads; `null` = a
  // fresh tab showing the URL-entry empty state.
  const [initialUrl, setInitialUrl] = useState<string | null>(persistedUrl ?? null)
  const [address, setAddress] = useState(persistedUrl ?? '')
  const [title, setTitle] = useState('')
  const [picking, setPicking] = useState(false)
  const [load, setLoad] = useState<LoadState>(INITIAL_LOAD)
  // Back/forward availability is tracked from navigation EVENTS via the pure model —
  // the webview element's own canGoBack()/canGoForward() are unreliable. `pending`
  // records that the NEXT did-navigate is our own back/forward/reload, so the handler
  // shifts (or ignores) the cursor instead of pushing a fresh entry.
  const [nav, setNav] = useState<NavState>(INITIAL_NAV)
  const pending = useRef<'back' | 'forward' | 'reload' | null>(null)

  function load_(url: string): void {
    void view?.loadURL(url).catch((err: unknown) => {
      // A superseded load rejects benignly; a real failure surfaces via did-fail-load
      // (the unreachable state). Nothing actionable here beyond a log.
      console.error('[browser] loadURL failed', url, err)
    })
  }

  function submitAddress(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const url = normalizeBrowserUrl(address)
    if (!url) return
    setAddress(url)
    if (initialUrl === null) setInitialUrl(url)
    else load_(url)
  }

  // NB: navigate by OFFSET, not goBack()/goForward() — the webview tag's goBack/goForward
  // (and canGoBack) are broken in Electron's <webview>, but goToOffset works. Our nav
  // model is the source of truth for whether an offset is available.
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
  function retry(): void {
    if (load.status === 'failed') load_(load.url)
  }
  function openExternal(): void {
    if (address) void window.api.openExternal({ url: address })
  }
  function openDevTools(): void {
    view?.openDevTools()
  }

  // Pick an element to chat (#224/#231, ADR-0016): inject the picker into the guest via
  // executeJavaScript (isolated world — no preload, isolation stays ON), await the click,
  // screenshot the element, and deliver ONE payload — the element metadata + optional
  // screenshot — to the active Thread's composer, which stages it as a pending-context
  // ELEMENT chip paired to the staged image. A no-op without a mounted composer or webview.
  async function pickElement(): Promise<void> {
    if (!view || !activeThreadId || picking) return
    setPicking(true)
    try {
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e8833a'
      const raw: unknown = await view.executeJavaScript(buildPickerScript({ accent }), true)
      const picked = coercePickedElement(raw)
      if (!picked) return // cancelled (Esc/nav) or a malformed return — nothing to send
      // Screenshot AFTER the picker overlay is gone (the injected script tore it down
      // before resolving), so the crop is the page, not the picker chrome.
      const crop = cropRectForElement(picked.rect, { width: view.offsetWidth, height: view.offsetHeight }, { padding: 8 })
      let image: ComposerInsertImage | null = null
      if (crop) {
        try {
          const captured = await view.capturePage(crop)
          const parsed = parseDataUrl(captured.toDataURL())
          if (parsed) {
            image = { ...parsed, name: `element-${picked.tagName}.png`, previewUrl: captured.toDataURL() }
          }
        } catch (err) {
          // A capture failure is non-fatal — the element chip still lands, screenshot-less.
          console.error('[browser] element screenshot failed', err)
        }
      }
      emitComposerInsertElement(activeThreadId, {
        element: {
          tagName: picked.tagName,
          selector: picked.selector,
          text: picked.text,
          pageUrl: picked.pageUrl,
        },
        image,
      })
    } catch (err) {
      // executeJavaScript rejects if the guest navigated mid-pick — treat as a cancel.
      console.error('[browser] pick cancelled', err)
    } finally {
      setPicking(false)
    }
  }

  // The webview only exposes its state through DOM events — wire them once per mounted
  // element, unwiring on unmount/remount.
  useEffect(() => {
    if (!view) return
    const onNavigate = (): void => {
      const url = view.getURL()
      // Never clobber an address the user is mid-typing: the guest can navigate
      // (redirects, SPA pushState) while the bar has focus. Persistence is independent
      // of the visible input — always report the committed URL.
      if (document.activeElement !== addressInputRef.current) setAddress(url)
      onUrlChange(url)
      // Advance the cursor per what caused this navigation. A reload adds no entry.
      const cause = pending.current
      pending.current = null
      if (cause === 'reload') return
      setNav((s) =>
        cause === 'back' ? goBackNav(s) : cause === 'forward' ? goForwardNav(s) : pushNav(s),
      )
    }
    const onStart = (): void => setLoad(onStartLoad)
    const onStop = (): void => setLoad(onStopLoad)
    const onFail = (event: Event): void => {
      pending.current = null
      const { errorCode, validatedURL } = event as unknown as {
        errorCode?: number
        validatedURL?: string
      }
      setLoad((s) => onFailLoad(s, validatedURL ?? view.getURL(), errorCode ?? 0))
    }
    const onTitle = (event: Event): void => {
      setTitle((event as unknown as { title?: string }).title ?? '')
    }
    view.addEventListener('did-navigate', onNavigate)
    view.addEventListener('did-navigate-in-page', onNavigate)
    view.addEventListener('did-start-loading', onStart)
    view.addEventListener('did-stop-loading', onStop)
    view.addEventListener('did-fail-load', onFail)
    view.addEventListener('page-title-updated', onTitle)
    return () => {
      view.removeEventListener('did-navigate', onNavigate)
      view.removeEventListener('did-navigate-in-page', onNavigate)
      view.removeEventListener('did-start-loading', onStart)
      view.removeEventListener('did-stop-loading', onStop)
      view.removeEventListener('did-fail-load', onFail)
      view.removeEventListener('page-title-updated', onTitle)
    }
  }, [view, onUrlChange])

  const canGoBack = canGoBackNav(nav)
  const canGoForward = canGoForwardNav(nav)

  // Open a blessed URL: from the empty state (first load) it seeds the webview src;
  // once loaded, later opens go through loadURL.
  function openUrl(url: string): void {
    setAddress(url)
    if (initialUrl === null) setInitialUrl(url)
    else load_(url)
  }

  if (initialUrl === null) return <BrowserEmptyState onOpenUrl={openUrl} />

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
        <form onSubmit={submitAddress} className="relative min-w-0 flex-1">
          <input
            ref={addressInputRef}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            aria-label="Address"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className={cn(
              'w-full rounded-md border border-transparent bg-accent/5 px-2.5 py-1 pr-7 text-xs text-text',
              'placeholder:text-faint focus:outline-none focus-visible:border-accent/60 focus-visible:bg-surface',
            )}
          />
          {load.status === 'loading' && (
            <Loader2
              aria-label="Loading"
              className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted"
            />
          )}
        </form>
        <BrowserAction
          label="Pick an element to chat"
          onClick={() => void pickElement()}
          disabled={activeThreadId === null || picking}
          active={picking}
        >
          <MousePointerClick aria-hidden />
        </BrowserAction>
        <BrowserAction label="Open in browser" onClick={openExternal}>
          <ExternalLink aria-hidden />
        </BrowserAction>
        <BrowserAction label="Developer tools" onClick={openDevTools}>
          <Code aria-hidden />
        </BrowserAction>
      </div>
      {/* Page title strip (surface chrome) — only when the guest reports one. */}
      {title && (
        <div className="shrink-0 truncate border-b border-border px-3 py-1 text-[11px] text-muted" title={title}>
          {title}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {/* The guest page. `partition`/`webpreferences`/`useragent` must be set before
            attach and never change — main's clamp re-verifies them (webview-clamp.ts). */}
        <webview
          ref={setView as (el: HTMLElement | null) => void}
          src={initialUrl}
          partition={deriveBrowserPartition(workspaceDir)}
          webpreferences={buildWebviewPreferencesAttribute()}
          useragent={stripElectronUserAgent(navigator.userAgent)}
          className="size-full bg-white"
        />
        {load.status === 'failed' && <UnreachableOverlay url={load.url} onRetry={retry} />}
      </div>
    </div>
  )
}

/**
 * The empty state (no page loaded): a URL input plus one-click suggestions for local dev
 * servers actually listening on the machine (#218). Discovery runs on mount and on an
 * explicit Refresh — no polling. A chosen suggestion or a typed URL flows out through
 * `onOpenUrl`, gated by the shared URL policy.
 */
function BrowserEmptyState({ onOpenUrl }: { onOpenUrl: (url: string) => void }): JSX.Element {
  const [input, setInput] = useState('')
  const [servers, setServers] = useState<DevServer[]>([])
  const [scanning, setScanning] = useState(true)

  const discover = useCallback(() => {
    setScanning(true)
    void window.api
      .discoverDevServers()
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]))
      .finally(() => setScanning(false))
  }, [])

  useEffect(() => discover(), [discover])

  function submit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault()
    const url = normalizeBrowserUrl(input)
    if (url) onOpenUrl(url)
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto bg-panel p-6">
      <div className="w-full max-w-sm text-center">
        <h3 className="text-sm font-medium text-text-strong">Preview a dev server</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Enter the URL of a local dev server — or any http(s) page.
        </p>
        <form onSubmit={submit}>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-faint">
              Running locally
            </span>
            <button
              type="button"
              onClick={discover}
              aria-label="Refresh dev servers"
              title="Refresh"
              className="flex size-5 items-center justify-center rounded text-muted outline-none transition-colors hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10 [&_svg]:size-3"
            >
              <RefreshCw aria-hidden className={scanning ? 'animate-spin' : undefined} />
            </button>
          </div>
          {servers.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {servers.map((server) => (
                <li key={server.port}>
                  <button
                    type="button"
                    onClick={() => onOpenUrl(server.url)}
                    className="flex w-full items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-xs outline-none transition-colors hover:bg-accent/10 focus-visible:border-accent/60 [&_svg]:size-3.5 [&_svg]:shrink-0 [&_svg]:text-muted"
                  >
                    <Globe aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-text">localhost:{server.port}</span>
                    <span className="shrink-0 text-faint">{server.processName}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-faint">
              {scanning ? 'Scanning…' : 'No dev servers detected.'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

/** The "can't reach this page" state over a failed guest, with a one-click Retry. */
function UnreachableOverlay({ url, onRetry }: { url: string; onRetry: () => void }): JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-panel p-6 text-center">
      <TriangleAlert aria-hidden className="size-6 text-muted" />
      <div>
        <p className="text-sm font-medium text-text-strong">Can’t reach this page</p>
        <p className="mt-1 max-w-xs truncate text-xs text-muted" title={url}>
          {url}
        </p>
        <p className="mt-1 text-xs text-muted">The dev server may be starting or stopped.</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-md border border-border bg-surface px-3 py-1 text-xs font-medium text-text outline-none transition-colors hover:bg-accent/10 focus-visible:border-accent/60"
      >
        Retry
      </button>
    </div>
  )
}

/**
 * A minimal Electron `NativeImage` — only `toDataURL`, which the picker uses to turn a
 * `capturePage` crop into a `data:` URL for the composer.
 */
interface NativeImageLike {
  toDataURL(): string
}

/** The slice of Electron's WebviewTag the Surface drives (renderer must not import electron). */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  getURL(): string
  /** Navigate by history offset — the working primitive (goBack/goForward are broken). */
  goToOffset(offset: number): void
  reload(): void
  openDevTools(): void
  /** Run code in the guest's ISOLATED world; resolves with the last expression (awaited if a Promise). */
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
  /** Capture a crop of the live guest compositor (rect in CSS/DIP px). */
  capturePage(rect?: { x: number; y: number; width: number; height: number }): Promise<NativeImageLike>
}

/** A browser toolbar icon button — the TerminalAction idiom. */
function BrowserAction({
  label,
  onClick,
  disabled,
  active,
  children,
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  active?: boolean
  children: JSX.Element
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={cn(
        'flex size-6 shrink-0 items-center justify-center rounded outline-none transition-colors',
        'hover:bg-accent/10 hover:text-text-strong focus-visible:bg-accent/10',
        'disabled:pointer-events-none disabled:opacity-40',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
        active ? 'bg-accent/15 text-accent-text' : 'text-muted',
      )}
    >
      {children}
    </button>
  )
}
