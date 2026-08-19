/**
 * PROTOTYPE (#422) — throwaway, do not promote. Three variants of the Bots view
 * mounted inside the REAL shell (sidebar, header, tokens, density), switchable
 * from a floating bar. Variant + populated/empty persist in `localStorage` so a
 * reload lands where you left off.
 *
 * The variant lives in App, not here, because variant C has NO outlet list — its
 * Bots go into the REAL sidebar through Shell's prototype slot. Drawing C's list
 * in the outlet would paint a second sidebar and misrepresent the one thing that
 * variant exists to argue.
 *
 * Fold the winner into real code and delete this directory; the full set lives on
 * the `proto/422-bots-view` branch as the primary source.
 */
import { useCallback, useEffect, type JSX } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { PROTO_BOTS, type ProtoBot } from './fixtures'
import { VariantA, VariantB, VariantCOutlet } from './variants'
import { IconButton } from '../ui/icon-button'

export const PROTO_VARIANTS = ['A', 'B', 'C'] as const
export type ProtoVariant = (typeof PROTO_VARIANTS)[number]

const NAMES: Record<ProtoVariant, string> = {
  A: 'Roster — list + detail',
  B: 'Team gallery — cards, then full width',
  C: 'Sidebar-native — no Bots page at all',
}

const VARIANT_KEY = 'proto:422:variant'
const EMPTY_KEY = 'proto:422:empty'

export function readProtoVariant(): ProtoVariant {
  const stored = localStorage.getItem(VARIANT_KEY)
  return PROTO_VARIANTS.includes(stored as ProtoVariant) ? (stored as ProtoVariant) : 'A'
}

export function readProtoEmpty(): boolean {
  return localStorage.getItem(EMPTY_KEY) === '1'
}

export function protoBots(empty: boolean): ProtoBot[] {
  return empty ? [] : PROTO_BOTS
}

export function BotsPrototype({
  onClose,
  variant,
  onVariant,
  empty,
  onEmpty,
  cSelected,
}: {
  onClose: () => void
  variant: ProtoVariant
  onVariant: (v: ProtoVariant) => void
  empty: boolean
  onEmpty: (v: boolean) => void
  /** Variant C's selection — owned by App, since its list is in the sidebar. */
  cSelected: string | null
}): JSX.Element {
  const cycle = useCallback(
    (delta: number) => {
      const i = PROTO_VARIANTS.indexOf(variant)
      const next = PROTO_VARIANTS[(i + delta + PROTO_VARIANTS.length) % PROTO_VARIANTS.length]
      localStorage.setItem(VARIANT_KEY, next)
      onVariant(next)
    },
    [variant, onVariant],
  )

  // ← / → cycle, but never while the user is typing in the create form.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      if (typing) return
      if (e.key === 'ArrowLeft') cycle(-1)
      if (e.key === 'ArrowRight') cycle(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cycle])

  const bots = protoBots(empty)
  const cBot = bots.find((b) => b.id === cSelected) ?? bots[0] ?? null

  return (
    <div className="relative flex h-full flex-col">
      <div className="min-h-0 flex-1">
        {variant === 'A' && <VariantA bots={bots} />}
        {variant === 'B' && <VariantB bots={bots} />}
        {variant === 'C' && <VariantCOutlet bot={cBot} />}
      </div>

      {/* Deliberately high-contrast: it must never read as part of the design
          being judged. Dev-only — a stray merge can't ship this to users. */}
      {import.meta.env.DEV && (
        <div className="pointer-events-auto absolute bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-neutral-900 px-2 py-1.5 text-white shadow-xl">
          <IconButton aria-label="Previous variant" onClick={() => cycle(-1)}>
            <ChevronLeft className="size-4" />
          </IconButton>
          <span className="px-2 text-[12px] font-medium">
            {variant} — {NAMES[variant]}
          </span>
          <IconButton aria-label="Next variant" onClick={() => cycle(1)}>
            <ChevronRight className="size-4" />
          </IconButton>
          <span className="mx-1 h-4 w-px bg-white/20" />
          <button
            type="button"
            onClick={() => {
              localStorage.setItem(EMPTY_KEY, empty ? '0' : '1')
              onEmpty(!empty)
            }}
            className="rounded-full px-2.5 py-1 text-[12px] hover:bg-white/10"
          >
            {empty ? 'empty' : 'populated'}
          </button>
          <span className="mx-1 h-4 w-px bg-white/20" />
          <IconButton aria-label="Close prototype" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
      )}
    </div>
  )
}
