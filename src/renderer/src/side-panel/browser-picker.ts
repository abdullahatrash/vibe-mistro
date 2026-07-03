/**
 * Pure helpers for the Browser Surface's element picker (#224, ADR-0016). The picker
 * runs in the guest via `executeJavaScript` (isolated world — no preload, no relaxed
 * isolation), so the only things worth unit-testing are the string/geometry pieces
 * either side of that boundary: the crop-rect math for the screenshot, the coercion of
 * the untrusted payload the guest returns, and the annotation text. The injected script
 * itself runs only in a real browser world (exercised by driving the app).
 */

/** A rectangle in viewport CSS pixels — the coordinate space of `getBoundingClientRect`. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The DOM-level metadata captured for a picked element (#224). NO React component name /
 * source frames — those need the page's DevTools hook, unreachable from the isolated world
 * we inject into (the deliberate deviation from t3code; ADR-0016). `selector` is best-effort
 * (null if uncomputable); `text` is a truncated snippet; `rect` is the viewport bounding box.
 */
export interface PickedElement {
  pageUrl: string
  tagName: string
  selector: string | null
  text: string
  rect: Rect
}

/** Longest text snippet kept from a picked element (keeps the annotation compact). */
const MAX_TEXT = 200

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function coerceRect(raw: unknown): Rect | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!isFiniteNumber(r.x) || !isFiniteNumber(r.y) || !isFiniteNumber(r.width) || !isFiniteNumber(r.height)) {
    return null
  }
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}

/**
 * Coerce the untrusted JSON the guest returns into a valid {@link PickedElement}, or null
 * to drop it — the guest page could return anything, so validate structurally (the
 * `coerceSurface`/`safe-external-url` defensive-coercion pattern). Requires a string
 * `pageUrl`/`tagName` and a numeric `rect`; lowercases the tag; tolerates a null selector
 * and empty text; truncates the snippet.
 */
export function coercePickedElement(raw: unknown): PickedElement | null {
  if (typeof raw !== 'object' || raw === null) return null
  const o = raw as Record<string, unknown>
  if (typeof o.pageUrl !== 'string' || typeof o.tagName !== 'string') return null
  const rect = coerceRect(o.rect)
  if (!rect) return null
  const selector = typeof o.selector === 'string' && o.selector.length > 0 ? o.selector : null
  const text = typeof o.text === 'string' ? o.text.slice(0, MAX_TEXT) : ''
  return { pageUrl: o.pageUrl, tagName: o.tagName.toLowerCase(), selector, text, rect }
}

/**
 * Build the picker script injected into the guest via `executeJavaScript` (#224, ADR-0016).
 * Runs in the guest's ISOLATED WORLD: it manipulates the shared DOM (draws a highlight box +
 * label, hit-tests with `elementsFromPoint`, reads `getBoundingClientRect`) but has no access
 * to the page's JS globals — hence DOM metadata only, no React component names. Returns a
 * single IIFE EXPRESSION resolving a Promise, so `executeJavaScript` awaits it and hands back
 * the picked-element JSON (or null on Esc/cancel). Config values are JSON-encoded, never raw-
 * interpolated, so a hostile accent can't break out of the string context. Capture-phase
 * listeners + a click `preventDefault`/`stopPropagation` mean the guest app never sees the pick;
 * overlay nodes are marked so they're excluded from hit-testing (never self-picked). The whole
 * script runs only in a real browser world — unit tests cover its SHAPE, not its behavior (the
 * app-driving verification exercises the behavior).
 */
export function buildPickerScript(config: { accent: string }): string {
  const accent = JSON.stringify(config.accent)
  const marker = JSON.stringify('data-vibe-pick-ui')
  return `(() => {
  const ACCENT = ${accent};
  const MARKER = ${marker};
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.setAttribute(MARKER, '');
    Object.assign(box.style, { position: 'fixed', zIndex: '2147483646', pointerEvents: 'none', boxSizing: 'border-box', border: '2px solid ' + ACCENT, background: ACCENT + '22', borderRadius: '2px', display: 'none' });
    const label = document.createElement('div');
    label.setAttribute(MARKER, '');
    Object.assign(label.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', background: ACCENT, color: '#fff', font: '11px/1.5 ui-monospace, monospace', padding: '1px 5px', borderRadius: '3px', display: 'none', maxWidth: '60vw', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
    document.body.appendChild(box);
    document.body.appendChild(label);
    document.body.style.cursor = 'crosshair';
    let current = null;
    const isUi = (el) => !!(el && el.getAttribute && el.getAttribute(MARKER) !== null);
    const elementAt = (x, y) => {
      for (const el of document.elementsFromPoint(x, y)) {
        if (!isUi(el) && el !== document.documentElement && el !== document.body) return el;
      }
      return null;
    };
    const describe = (el) => {
      const id = el.id ? '#' + el.id : '';
      const cls = (typeof el.className === 'string' && el.className.trim()) ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
      return el.tagName.toLowerCase() + id + cls;
    };
    const onMove = (e) => {
      const el = elementAt(e.clientX, e.clientY);
      current = el;
      if (!el) { box.style.display = 'none'; label.style.display = 'none'; return; }
      const r = el.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
      label.textContent = describe(el);
      Object.assign(label.style, { display: 'block', left: r.left + 'px', top: Math.max(0, r.top - 18) + 'px' });
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('click', onClick, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pagehide', onCancel, true);
      document.body.style.cursor = '';
      box.remove();
      label.remove();
    };
    const payloadFor = (el) => {
      const r = el.getBoundingClientRect();
      const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
      let selector = null;
      try { selector = describe(el); } catch (_) { selector = null; }
      return { pageUrl: location.href, tagName: el.tagName, selector, text, rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
    };
    const onClick = (e) => {
      const el = current || elementAt(e.clientX, e.clientY);
      e.preventDefault();
      e.stopPropagation();
      cleanup();
      resolve(el ? payloadFor(el) : null);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); } };
    const onCancel = () => { cleanup(); resolve(null); };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pagehide', onCancel, true);
  });
})()`
}

/**
 * The crop rect for the picked element's screenshot: pad the element's bounding rect,
 * clamp it to the viewport, and round to integer pixels. Returns null for a zero-area
 * element (nothing to capture). Coordinates stay in CSS pixels — Electron's
 * `capturePage(rect)` expects DIP/CSS px and handles devicePixelRatio internally, so no
 * DPR scaling is applied here.
 */
export function cropRectForElement(
  rect: Rect,
  viewport: { width: number; height: number },
  opts: { padding: number },
): Rect | null {
  if (rect.width <= 0 || rect.height <= 0) return null
  const left = Math.max(0, Math.round(rect.x - opts.padding))
  const top = Math.max(0, Math.round(rect.y - opts.padding))
  const right = Math.min(viewport.width, Math.round(rect.x + rect.width + opts.padding))
  const bottom = Math.min(viewport.height, Math.round(rect.y + rect.height + opts.padding))
  return { x: left, y: top, width: right - left, height: bottom - top }
}
