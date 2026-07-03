# Pending-context chips: structured composer attachments, flattened to plain text at send

**Status: ACCEPTED** (2026-07-03). Builds on **ADR-0002** (thin orchestrator — no client-side
expansion, no new wire shapes), **ADR-0009** (queue payload unchanged), **ADR-0013** decision 2
(Files-preview insert channel), **ADR-0016** (element picker — its output re-homed here). PRD
#228; slices #229 (skill), #230 (file), #231 (element). Reference: t3code's composer, whose
**attachment pattern** we adopt and whose **Lexical inline-chip editor** we deliberately do not.

## Context

Selecting context in the composer used to collapse straight into draft text: a `/` accept spliced
`/name ` into the prose, an `@` accept spliced `@path `, and a Browser Surface element pick pasted
a multi-line annotation into the draft. The user couldn't see at a glance what a prompt carried,
couldn't remove one attachment without hand-editing text, and the draft stopped being theirs to
edit.

t3code solves the in-text version of this with a ~1,700-line Lexical editor whose decorator nodes
render inline chips. But its browser **element contexts** — the closest analogue to our picker —
do NOT go through that editor: they are structured drafts rendered as removable chips *outside*
the text field, flattened into a trailing plain-text block at send. Inline positional chips are
only needed when a token must sit mid-sentence; none of ours do.

## Decision

1. **Chips live BESIDE the draft, never inline in it.** The composer stays a plain textarea; a
   `PendingContext` discriminated union (`skill` / `file` / `element`, `pending-contexts.ts`)
   is separate state with the same lifecycle as staged images (#100): ephemeral, cleared on
   send/enqueue, restored on a failed send.

2. **The draft string stays the single source of truth for prose; the wire stays plain text.**
   `serializeForSend(text, contexts)` flattens at the moment of send or enqueue:
   - skill → leading `/name ` (the agent parses it server-side; at most ONE chip, replace-on-add);
   - files → a trailing `<attached_files>` block of `@path` mentions (the agent expands them;
     deduped by path);
   - elements → a final `<element_context>` block of descriptive lines (the former #224
     annotation content, whitespace-normalized to stay line-parseable).
   The follow-up queue's `{text, images}` payload shape is untouched.

3. **Display re-derives chips from the sent text at RENDER time** (`extractPromptContexts`, the
   exact mirror of the serializer), matching the PR #213 match-at-render decision. Marker blocks
   are stripped from the visible bubble and rendered as chips. Because everything rides in the
   prompt text, the JSONL transcript persists context for free and cold replay shows the same
   chips with zero persistence changes. Extraction only touches TRAILING blocks whose content
   matches what we write — hand-typed prompts and inline `@path` mentions pass through untouched.

4. **The element pick delivers ONE payload** (metadata + optional screenshot) over a dedicated
   composer-insert channel; the composer pairs the chip to its staged screenshot by id, so
   removing the chip removes the screenshot. The picker itself (ADR-0016) is unchanged.

5. **The Terminal Surface's "Add to chat" stays raw text** — multi-line terminal output belongs
   in the editable draft, not behind a chip.

## Consequences

- No Lexical/contentEditable dependency; composer logic stays pure-module unit-testable (node
  env, no jsdom). The threshold for revisiting: a token that must sit mid-sentence.
- Typed `/name` and `@path` flows are unchanged — chips are additive over the same wire format.
- Chips are ephemeral v1: unlike the old spliced-text mentions, they do not survive a Thread
  switch/app restart. Persisting a structured draft (`{text, contexts}`) is a recorded follow-up.
- The agent sees marker elements (`<attached_files>`, `<element_context>`) as plain prose. This
  is deliberate: they are descriptive fences, not protocol. If a prompt legitimately ends with
  text matching a fence, extraction only mis-fires if the content also parses (`@`-only lines /
  `Picked element <…>` entries) — accepted as vanishingly unlikely.
