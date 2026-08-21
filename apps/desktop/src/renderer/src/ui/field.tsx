import type { JSX, ReactNode } from 'react'

/**
 * One labelled row of a form: label, control, then hint or error (never both).
 *
 * Lifted out of the Bot form (#447) when the Routine editor (#471) needed the same
 * row — two full-outlet forms with the same anatomy, and a second copy would have
 * been two places for one layout decision to drift.
 *
 * The label never WRAPS its control, and that is the load-bearing detail: several
 * of these rows hold a group of buttons (colour swatches, schedule presets,
 * weekdays), and a wrapping `<label>` makes every click anywhere on the row fire
 * the first button in it.
 */
export function Field({
  label,
  controlId,
  hint,
  error,
  children,
}: {
  label: string
  /** The id of the field's single input, when it has one — associates the label. */
  controlId?: string
  hint?: ReactNode
  error?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      {controlId ? (
        <label htmlFor={controlId} className="text-[13px] font-medium text-foreground">
          {label}
        </label>
      ) : (
        <span className="text-[13px] font-medium text-foreground">{label}</span>
      )}
      {children}
      {error ? (
        <span className="text-[12px] text-destructive">{error}</span>
      ) : hint ? (
        <span className="text-[12px] leading-relaxed text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  )
}
