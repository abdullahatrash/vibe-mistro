import type { JSX } from 'react'

/**
 * A Mistro Bot's identity mark (#446): its initial on its own colour. The whole
 * visual identity of a teammate, at every size it appears — the sidebar row, the
 * conversation header, and (slice 3) the form.
 *
 * `colour` is whatever the record holds; main validates it on write
 * (`validateBotColour`), so this renders it as given rather than re-deciding.
 * `aria-hidden` because the Bot's name is always beside it — a screen reader
 * announcing "R" before "Rex" is noise.
 */
export function BotMark({
  name,
  colour,
  size = 20,
}: {
  name: string
  colour: string
  size?: number
}): JSX.Element {
  return (
    <span
      aria-hidden
      className="flex flex-none items-center justify-center rounded-full font-semibold text-white"
      style={{
        background: colour,
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {botInitial(name)}
    </span>
  )
}

/** The mark's letter: the name's first character, uppercased ("?" for an empty name). */
function botInitial(name: string): string {
  return name.trim().slice(0, 1).toUpperCase() || '?'
}
