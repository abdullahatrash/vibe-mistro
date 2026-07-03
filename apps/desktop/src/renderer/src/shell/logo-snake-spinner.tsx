import type { JSX } from 'react'
import { cn } from '../lib/utils'

/** How long one full lap of the snake takes. */
const SNAKE_DURATION_S = 1.1

/**
 * The Vibe Mistro "V" stroke chopped into 8 segments, ORDERED as a snake path
 * that draws the letter — down the left leg, up the right — so the phased
 * highlight reads as a light tracing the V rather than a flat shimmer. Colors
 * ride the flame ramp (yellow at the tips, red at the vertex), mirrored.
 */
const SNAKE_PATH: ReadonlyArray<{ d: string; stroke: string }> = [
  { d: 'M19 19 L22.25 25.75', stroke: '#f6c445' },
  { d: 'M22.25 25.75 L25.5 32.5', stroke: '#f2a740' },
  { d: 'M25.5 32.5 L28.75 39.25', stroke: '#ec8a3c' },
  { d: 'M28.75 39.25 L32 46', stroke: '#e2452a' },
  { d: 'M32 46 L35.25 39.25', stroke: '#e2452a' },
  { d: 'M35.25 39.25 L38.5 32.5', stroke: '#ec8a3c' },
  { d: 'M38.5 32.5 L41.75 25.75', stroke: '#f2a740' },
  { d: 'M41.75 25.75 L45 19', stroke: '#f6c445' },
]

/**
 * A branded loading indicator (the "funky" spinner): a light snakes along the
 * Vibe Mistro "V" monogram stroke. Pure CSS — each segment runs the shared
 * `vmSnake` keyframe (styles.css) phased by a negative `animationDelay` along
 * {@link SNAKE_PATH}, so a bright head + short trail chase through the letter.
 * `prefers-reduced-motion` freezes it to a static dim V. Square; `size` is both
 * dimensions in px; drop-in at the sidebar's streaming indicators.
 */
export function LogoSnakeSpinner({
  size = 14,
  className,
  label = 'Working',
}: {
  size?: number
  className?: string
  /** Accessible name — the streaming context ("Streaming", "This project is working"). */
  label?: string
}): JSX.Element {
  return (
    <svg
      role="img"
      aria-label={label}
      className={cn('shrink-0', className)}
      width={size}
      height={size}
      viewBox="13 13 38 38"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {SNAKE_PATH.map((seg, i) => (
        <path
          key={seg.d}
          d={seg.d}
          stroke={seg.stroke}
          strokeWidth="8.5"
          strokeLinecap="round"
          className="vm-snake-cell"
          style={{ animationDelay: `${-(i / SNAKE_PATH.length) * SNAKE_DURATION_S}s` }}
        />
      ))}
    </svg>
  )
}
