import type { JSX } from 'react'

/**
 * The Vibe Mistro "V" monogram — a dark V stroke on the flame-gradient rounded
 * tile (same asset family as the website favicon and resources/icon.*). Square
 * (viewBox 64×64); `size` is both dimensions in px (20 in the window-chrome
 * header, 52 on the empty-state heroes). Inline SVG so it scales crisply and
 * adds no bundle image. The gradient id is namespaced per-instance-safe: ids
 * only collide when duplicated in one document, and every instance renders the
 * same defs, so reuse is harmless.
 */
export function Logo({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <svg
      aria-hidden
      className="shrink-0"
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="vm-flame" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#f6c445" />
          <stop offset="0.55" stopColor="#ef8a3c" />
          <stop offset="1" stopColor="#e2452a" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#vm-flame)" />
      <path
        d="M19 19 L32 46 L45 19"
        stroke="#241a12"
        strokeWidth="8.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}
