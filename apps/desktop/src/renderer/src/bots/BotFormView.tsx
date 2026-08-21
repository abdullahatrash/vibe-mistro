import { useId, useState, type JSX, type ReactNode } from 'react'
import { Check, Trash2 } from 'lucide-react'
import type {
  BotRecord,
  BotsCreateArgs,
  BotsUpdateArgs,
  BotWriteResult,
  ListMetadataResult,
} from '../../../shared/ipc'
import {
  BOT_COLOURS,
  botCreateArgs,
  botUpdateArgs,
  initialBotFormValues,
  isBotFormDirty,
  validateBotForm,
  type BotFormTarget,
  type BotFormValues,
} from './bot-form'
import { BOT_NAME_MAX_LENGTH, BOT_DESCRIPTION_MAX_LENGTH } from '../../../shared/bot-limits'
import { BotMark } from './BotMark'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { Menu, MenuContent, MenuRadioGroup, MenuRadioItem, MenuTrigger } from '../ui/menu'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { cn } from '../lib/utils'

/**
 * Creating and editing a **Mistro Bot**, in the OUTLET (#447; ADR-0027 decision 4
 * as amended — no Bots BROWSING view, and create/edit is a transient outlet view
 * with no list; prototyped as variant D on `proto/422-bots-view`).
 *
 * Not a dialog, and the reason is the instructions field: it is the whole
 * personality, and a three-line box in a modal quietly contradicts its own helper
 * text — it tells you to describe a teammate in a space that fits a sentence. The
 * outlet gives it real width and real height, and the sidebar stays visible
 * throughout, so opening the form never costs the user their place.
 *
 * Two things this form deliberately cannot do, both argued in `bot-form.ts`: move
 * a Bot to another Project, and change its profile id. Everything else about a Bot
 * is here — its behaviour IS this form, because a Bot has no Mode, Model or
 * reasoning-effort picker (ADR-0027 decision 5).
 */
export function BotFormView({
  target,
  bots,
  workspaces,
  onCreate,
  onSave,
  onDelete,
  onClose,
}: {
  target: BotFormTarget
  /** Every Bot record — the edit target is looked up here, and seeds the colour. */
  bots: readonly BotRecord[]
  /** The Projects a Bot may live in. Empty = nothing to create a Bot in yet. */
  workspaces: ListMetadataResult
  /** Create a Bot. Resolves with main's typed result so `problems` can be shown. */
  onCreate: (args: BotsCreateArgs) => Promise<BotWriteResult>
  /** Save an edit. Same contract; never carries a Project or a profile id. */
  onSave: (args: BotsUpdateArgs) => Promise<BotWriteResult>
  /**
   * Delete this Bot (edit only): the identity goes, the conversation is archived.
   * Resolves with the problems to SHOW — empty on success. A failed delete leaves
   * the form open saying so, rather than closing the confirm over a Bot that is
   * still there (#447 review, D2).
   */
  onDelete: (bot: BotRecord) => Promise<string[]>
  /** Leave the form — App returns the outlet to whatever was on screen. */
  onClose: () => void
}): JSX.Element {
  const editing = target.mode === 'edit' ? (bots.find((b) => b.threadId === target.threadId) ?? null) : null
  // Seeded ONCE per form open: the view is keyed by its target in App, so a switch
  // from create to edit (or to another Bot) remounts rather than re-seeding.
  const [values, setValues] = useState<BotFormValues>(() => initialBotFormValues({ target, bots }))
  const [saving, setSaving] = useState(false)
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false)
  // What MAIN refused, verbatim. Main is the validator (Vibe validates nothing we
  // write), so its problems are shown rather than paraphrased.
  const [problems, setProblems] = useState<string[]>([])
  // Only complain about a field once the user has tried to submit — a form that
  // shouts "A Bot needs a name" before the first keystroke is a form that nags.
  const [showErrors, setShowErrors] = useState(false)
  const fieldId = useId()

  const errors = validateBotForm(values)
  const invalid = Object.keys(errors).length > 0
  const dirty = editing ? isBotFormDirty(values, editing) : true

  function set<K extends keyof BotFormValues>(key: K, value: BotFormValues[K]): void {
    setValues((prev) => ({ ...prev, [key]: value }))
  }

  async function submit(): Promise<void> {
    setShowErrors(true)
    if (invalid || saving) return
    if (editing && !dirty) {
      // Nothing changed: don't rewrite the profile files (and don't claim the
      // "takes effect on your next message" promise) over a no-op.
      onClose()
      return
    }
    setSaving(true)
    setProblems([])
    const result = editing
      ? await onSave(botUpdateArgs(editing.threadId, values))
      : await onCreate(botCreateArgs(values))
    setSaving(false)
    if (result.ok) {
      onClose()
      return
    }
    setProblems(result.problems)
  }

  const projectName = workspaces.find((w) => w.id === values.workspaceId)?.displayName ?? null

  return (
    // Roomy, and capped at a readable measure — the instructions field is the point
    // of the layout, so everything above it stays compact and it gets the height.
    <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
      <header className="flex items-center gap-3">
        <BotMark name={values.name || '?'} colour={values.colour} size={36} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[20px] font-semibold text-foreground">
            {editing ? `Edit ${editing.name}` : 'New Bot'}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {editing
              ? 'A Bot keeps one conversation going. Editing it never changes what it has already said.'
              : 'It lives in the project you pick and keeps one conversation there.'}
          </p>
        </div>
      </header>

      <Field label="Name" controlId={`${fieldId}-name`} error={showErrors ? errors.name : undefined}>
        <Input
          id={`${fieldId}-name`}
          value={values.name}
          maxLength={BOT_NAME_MAX_LENGTH}
          placeholder="Rex"
          autoFocus
          onChange={(e) => set('name', e.target.value)}
        />
      </Field>

      <Field label="Colour" error={showErrors ? errors.colour : undefined}>
        <div className="flex items-center gap-2">
          {BOT_COLOURS.map((colour) => (
            <button
              key={colour}
              type="button"
              aria-label={`Colour ${colour}`}
              aria-pressed={values.colour === colour}
              onClick={() => set('colour', colour)}
              className={cn(
                'flex size-7 items-center justify-center rounded-full outline-none transition-transform',
                'hover:scale-110 focus-visible:ring-2 focus-visible:ring-primary',
              )}
              style={{ background: colour }}
            >
              {values.colour === colour && <Check className="size-4 text-white" aria-hidden />}
            </button>
          ))}
        </div>
      </Field>

      <Field
        label="Project"
        error={showErrors ? errors.workspaceId : undefined}
        hint={
          editing
            ? 'A Bot stays in the project it was made in — its conversation is about those files.'
            : 'A Bot lives in one project and works on those files.'
        }
      >
        {editing ? (
          <div className="rounded-md border border-border bg-secondary px-3 py-2 text-[14px] text-muted-foreground">
            {projectName ?? 'Unknown project'}
          </div>
        ) : workspaces.length === 0 ? (
          <p className="rounded-md border border-border bg-secondary px-3 py-2 text-[13px] text-muted-foreground">
            No projects yet — open one first. A Bot cannot exist without a project.
          </p>
        ) : (
          <Menu>
            <MenuTrigger
              className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-left text-sm text-foreground outline-none transition-colors hover:bg-primary/10 focus-visible:border-primary"
              aria-label="Project"
            >
              <span className={cn('truncate', !projectName && 'text-muted-foreground')}>
                {projectName ?? 'Pick a project'}
              </span>
            </MenuTrigger>
            <MenuContent align="start" className="min-w-[260px]">
              <MenuRadioGroup
                value={values.workspaceId}
                onValueChange={(value) => set('workspaceId', String(value))}
              >
                {workspaces.map((w) => (
                  // `closeOnClick` is NOT base-ui's default for a radio item (it
                  // assumes a menu you keep picking from). Picking a Project is one
                  // choice and done — without this the menu stays open behind its
                  // own inert backdrop and the rest of the form cannot be clicked.
                  <MenuRadioItem key={w.id} value={w.id} closeOnClick>
                    {w.displayName}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuContent>
          </Menu>
        )}
      </Field>

      <Field
        label="Description"
        controlId={`${fieldId}-description`}
        error={showErrors ? errors.description : undefined}
        hint="One line, shown under the Bot's name. Optional."
      >
        <Input
          id={`${fieldId}-description`}
          value={values.description}
          maxLength={BOT_DESCRIPTION_MAX_LENGTH}
          placeholder="Reviews my changes before I open a PR"
          onChange={(e) => set('description', e.target.value)}
        />
      </Field>

      <Field
        label="Instructions"
        controlId={`${fieldId}-instructions`}
        error={showErrors ? errors.instructions : undefined}
        hint={
          editing
            ? 'This is the whole personality. It loads with every message, so an edit takes effect on your next message — it never rewrites what has already been said.'
            : 'This is the whole personality. It is loaded with every message and survives everything the conversation does.'
        }
      >
        {/* The field the whole layout exists for: real width, real height. */}
        <Textarea
          id={`${fieldId}-instructions`}
          value={values.instructions}
          rows={14}
          className="min-h-[280px] resize-y font-normal"
          placeholder={
            'You review my changes before I open a PR. Be blunt about correctness, quiet about style.\n\n' +
            'You already know this project: its conventions, its awkward corners, and what we decided last week.'
          }
          onChange={(e) => set('instructions', e.target.value)}
        />
      </Field>

      {problems.length > 0 && (
        // Main refused the write. Its messages are field-prefixed and specific —
        // shown verbatim rather than collapsed into "something went wrong".
        <ul className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 border-t border-border pt-4">
        {editing && (
          <Button
            variant="ghost"
            className="mr-auto text-destructive hover:bg-destructive/10"
            onClick={() => setConfirmDeleteOpen(true)}
          >
            <Trash2 className="size-3.5" aria-hidden />
            Delete Bot
          </Button>
        )}
        <div className={cn('flex gap-2', !editing && 'ml-auto')}>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={saving || (showErrors && invalid)}>
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create Bot'}
          </Button>
        </div>
      </div>

      {/* Deleting a Bot destroys the IDENTITY, not the history (ADR-0027). The copy
          has to carry that, or the button reads as "delete weeks of conversation". */}
      {editing && (
        <Dialog open={confirmDeleteOpen} onOpenChange={setConfirmDeleteOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Delete {editing.name}?</DialogTitle>
              <DialogDescription>
                This removes {editing.name} from the sidebar and deletes its profile. The
                conversation is kept — it becomes an archived thread in{' '}
                {projectName ?? 'its project'}, so nothing you have said is lost.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="secondary" />}>Cancel</DialogClose>
              <Button
                variant="destructive"
                onClick={() => {
                  setConfirmDeleteOpen(false)
                  void onDelete(editing).then(setProblems)
                }}
              >
                Delete Bot
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}

/**
 * One labelled row of the form: label, control, then hint or error (never both).
 *
 * The label never WRAPS its control: two of these rows hold buttons (the colour
 * swatches and the Project menu), and a wrapping label makes every click on the
 * row fire the first one.
 */
function Field({
  label,
  controlId,
  hint,
  error,
  children,
}: {
  label: string
  /** The id of the field's single input, when it has one — associates the label. */
  controlId?: string
  hint?: string
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
