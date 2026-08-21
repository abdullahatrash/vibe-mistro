# Bot Routines: scheduled headless turns into a Bot's own conversation

**Status: PROPOSED** (2026-08-21, #455 → #460). Builds on **ADR-0027** (what a Mistro Bot is),
**ADR-0002** (thin orchestrator), **ADR-0006** (the warm-agent pool and its protection predicate) and
**ADR-0019** (persistence). It **amends ADR-0001** (the renderer owns conversation state and answers
permission requests) — see Consequences.

## Context

Mistro Bots as shipped are a persistent system prompt plus a place in the sidebar. That is real
continuity, but it is not a new capability: a Bot does nothing you did not just ask it to do. A
**Routine** is the differentiation — a Bot that does work while nobody is watching, and reports what it
found. The motivating example, stated once and used throughout: triage a repo's issues every morning
and say what changed.

Five wayfinder tickets settled the design (#456–#459 plus this handoff), one of them an empirical probe
against the live `vibe-acp` binary. The findings that constrain it:

- **A headless turn is viable and cheap.** The transcript tee never depended on a subscriber, the pool
  already warms a Workspace nobody selected, and a turn nobody watches costs what a watched one costs.
  There is no protocol limit here — only bounded changes in our own main process.
- **A failure *before* binding is invisible today.** The prompt path returns from its catch before it
  touches the Thread, so an agent that will not spawn, a failed `session/new`, and a failed resume write
  no entry **and** never move `lastActiveAt`. With a user at the composer this is correct; with nobody
  there it is silence.
- **An unanswered permission request hangs a turn forever.** Vibe awaits the client with no timeout.
- **A profile's declared `safety` enforces nothing.** It is presentation. A profile declaring itself
  safe ran shell commands and file writes with zero approval requests.
- **Denying write *tools* does not deny writing.** With file-writing tools set to `never`, the agent
  shelled out with a redirect and the file landed — a shell redirect tokenises as a separate part, so
  it passes a command allowlist that never listed it.
- **Rejection provokes evasion, not compliance.** Denied repeatedly on a one-file task, the agent tried
  fourteen different routes before finding one that was allowed.
- **We cannot reject what we are not asked about.** Client-side enforcement is only as complete as the
  set of things Vibe chooses to ask us about.

## Decision

**A Routine is a named schedule attached to a Mistro Bot. When it is due, we run one headless prompt
turn into that Bot's existing conversation, answering the agent's permission requests ourselves from a
user-authored allowlist, and we report what happened — including that nothing happened.**

Seven parts, each load-bearing.

### 1. Routines belong to Bots, and report into the Bot's continuing conversation

Not to Workspaces, and not into a freshly minted Thread per run. A daily routine that mints a Thread
would leave ninety Threads a quarter, none of which remembers the last one. Because a Bot is one
continuing conversation, the report lands where the previous reports are, and the Bot can say "three of
yesterday's five are still open" without being told. This composition is the whole reason routines are
worth building here rather than as a general scheduler.

**A Bot may have several routines, capped.** Morning triage and a Friday summary on the same repo are
one relationship. Forced to one, users would create "Triage Bot" and "Summary Bot" on the same Project
and split exactly the conversation this design exists to keep. The cap is not about resources: a Bot is
single-threaded, so routines due at the same moment defer against one another, and the queue that forms
is what needs bounding.

### 2. A schedule is a structured value, not a cron string

`{ kind: 'daily' | 'weekdays' | 'weekly', at: 'HH:MM', weekday?, timezone }`. Presets are the UI over
it; there is no cron anywhere in v1.

The reason is not readability. Part 6's detector needs the **backwards** computation — "when was this
last due before now" — which is a few lines of arithmetic over a structured value and a
library-capability question over cron. No cron parser exists in this repo, so choosing cron would mean
adding a dependency in order to make the harder direction harder. The escape hatch stays free: the
`kind` discriminator means a `cron` variant can be added later without a migration and without
rewriting the other branches.

**The timezone is stored with the routine**, defaulted to the machine's at creation, as an IANA name —
Electron ships full ICU, so this needs no dependency either. Following the machine instead would make
the same stored data yield a different answer depending on where the laptop is, which destroys the one
property the detector must have. Three DST rules, stated so they can be tested: when the scheduled hour
happens twice, fire at the **first** occurrence; when it does not exist, fire at the **next valid local
time**; a routine fires **at most once per scheduled slot**.

**Accepted limits:** "every 90 minutes" and "the last Friday of the month" cannot be expressed.
**Time triggers only** — "when CI fails" needs polling, rate limits and a story for events that happen
while the app is closed, and a morning report *about* CI gets most of the value.

### 3. The app must be open. This is stated, never disguised

Electron has no background daemon and we ship no server, so routines fire only while the app runs. The
UI must never imply otherwise, and part 6 exists precisely so that a routine which could not fire says
so rather than looking like one that fired and found nothing.

A missed run **executes once on next launch, marked late** — not N times, because nobody wants
Tuesday's triage on Thursday, and not silently skipped, because then a routine that never fires looks
exactly like one that works. The report states the period it covers.

### 4. The permission answer is ours, from a user-authored allowlist, and a denial ends the turn

A routine gets a **second, routine-only profile** whose job is to force Vibe to *ask*: file-writing
tools set to `never`, shell set to ask with an **empty** allowlist, because emptying the list is what
removes the defaults that let a redirect through. **Our allowlist is the answer we give.** The two are
complementary, not alternatives — the profile guarantees we are asked, the allowlist decides.

The allowlist holds **literal invocations**, is **empty by default**, and is matched against the
**whole** invocation string. Anything containing a redirect, pipe or substitution is refused unless that
exact string is listed, or we reopen the hole above.

**Auto-denying everything was rejected**: it makes read-only routines useless — the motivating example
*is* a shell command — and it provokes the evasion loop rather than stopping it. **Leaving the request
pending until the user opens the Bot was also rejected**: a routine blocked for eight hours and then
acting at 18:00 on 08:00's assumptions is a bug with a friendly face, and it holds the session and its
pool slot throughout.

So **the first denial cancels the turn**, and the cancellation is reported naming the exact command.
Continuing past a denial is what produces evasion; stopping is what produces a fixable message.

**Write-capable is the same allowlist with write commands in it.** There is no read-only/write-capable
mode to choose between — one mechanism, one field, and no moment where a user must work out which
policy is live.

**The allowlist is never seeded from what the Bot has already run.** What a Bot ran while you were
watching and approving is not evidence that it may run unattended; seeding would silently convert
supervised approvals into unsupervised ones, which is the entire property the allowlist protects.

### 5. A routine turn is legible, and it always writes something

A routine's prompt renders as an ordinary user bubble carrying a routine chip — the same treatment an
invoked slash command already gets, for the same reason: real input the agent received, which you did
not type. Hiding it behind a system line would conceal input that shaped the answer.

**One rule with no exceptions: a routine turn always writes an entry, success or failure.** This is what
closes the pre-bind hole in Context — those failures must tee and touch the Thread like any other. The
notifier is the **unread dot already built for Bots** (`lastActiveAt` moved since you last watched),
never the needs-attention flag, which is a live count of unanswered permission requests and clears
itself at turn end.

**A failed routine does not retry.** Every failure available to it is durable rather than transient —
sign-in expired, context exhausted, profile missing, agent binary gone — so retrying burns tokens and
buries the cause, and retry state would have to survive an app close. A daily routine already retries
daily.

### 6. Missed, late and never are DERIVED, not stored

The record holds `lastRunAt`, an outcome of `ok | failed | blocked | deferred`, and the failure detail.
It does **not** hold a next-run time, and it does **not** hold a "missed" flag.

Never, missed and late are **comparisons, not outcomes**. Storing them as values means something has to
write them at the right moment — but the case worth catching is exactly the one where **no code ran at
all**: the app was never open, a bug ate the timer, the fire path threw before reaching the store. A
flag nobody set is indistinguishable from a flag nobody needed to set.

A schedule is a pure function of time, so the expected last-due instant is computable at launch from the
stored schedule alone. If it is later than `lastRunAt`, a run was missed — whatever the reason,
including reasons we never anticipated. **The detector shares no code with the firing path.** This is
the correction of a mistake this codebase has now made three times: in #427, #433 and the persona-loss
case, the component that broke was also the component responsible for reporting that it broke.

The firer and the detector do share one pure schedule function, because they must **agree**. Sharing
arithmetic is not the anti-pattern; sharing responsibility for self-report is.

### 7. Authoring is a Bot-form list plus a per-routine editor, and templates carry the floor

The **list** lives in the Bot's form, because that is where you go to change what a Bot is. Each routine
is **edited in its own view**, because a routine has as many fields as a Bot does and nesting the two
produces a page nobody can scan. A routine has a **required name** — a list of identical schedules is
unreadable, and part 4's messages already assume a name exists.

At-rest state — next run, last run and outcome, paused — belongs on the routine's row and **not** on the
sidebar Bot row, which was deliberately settled as mark, name, timestamp and dot after richer variants
were rejected as truncating to noise at sidebar width.

**Pausing is stored state, and a paused routine has no missed runs**: resuming sets a fresh baseline
rather than accruing a fortnight of catch-up. A routine is **created active**, with its next run shown
at creation — a routine created in a state where it silently does nothing is the same failure family
this design spends part 6 eliminating.

**Templates ship prompt, schedule default and allowlist together.** Without them the empty-by-default
allowlist means every routine's first run aborts. That makes routine templates a correctness feature
rather than a cold-start one, and it is why they rank above the Bot templates drafted in #453.

## Consequences

- **This amends ADR-0001.** The renderer owns conversation state and answers permission requests; for a
  routine turn, **main answers them**, from the allowlist, without a renderer in the loop. The
  departure is narrow and deliberate: it applies only to turns raised by the scheduler, an unanswered
  request hangs the turn forever, and there is no renderer to ask. The renderer remains the only
  answerer for every user-initiated turn.
- **`isProtected` must learn about routines**, or a mid-routine agent is evicted under idle or LRU
  pressure. Separately, window-close currently disposes the whole pool without consulting protection,
  so closing the window would kill a running routine — that path must respect it.
- **The busy signal is the per-Thread streaming status, not the per-agent in-flight count.** One agent
  legitimately hosts concurrent turns across sessions, so the per-agent count over-defers. The
  rejection Vibe returns for a genuinely busy session is an application error, and the check must be
  atomic with the send or two ticks can race into it.
- **A Bot with routines is a Bot that costs tokens while you are not looking.** This is the intended
  behaviour and the reason the app-must-be-open limit is stated rather than worked around, but it means
  a runaway routine is a runaway bill. The cap in part 1 and the no-retry rule in part 5 are the two
  bounds; if more are needed, they belong here.
- **Verifying the gate took is mandatory.** Unknown keys in a profile are ignored silently, so a typo
  produces an ungated routine that looks correctly configured. A routine whose gate cannot be confirmed
  **must refuse to run**, and say why.
- **No `REDUCER_SCHEMA_VERSION` bump.** A bump is needed only when an old snapshot would be *misread* by
  the new reducer. Every addition here is optional — an absent routine marker reads as "not a routine
  turn", which is true — and bumping would discard every stored fold snapshot and force a full fold on
  the next open of every Thread (#443).
- **No OS notification in v1.** The unread dot is the notifier. The honest weakness is that a dot behind
  another window is not a notification; what makes it hold is that routines only fire while the app
  runs. If v1 proves too quiet, the first addition is a notify flag restricted to **failures** — a
  routine that quietly stopped working is the only case the dot is genuinely too weak for.
- **#175 is closed into this work.** Its draft put a schedule on a Workspace and minted a Thread per
  run; parts 1 and 6 are the corrections.

## Considered alternatives

- **A cron expression, with or without presets over it.** Rejected in part 2: it inverts the cost of the
  computation we actually need, and adds a dependency to do it.
- **Client-side permission rejection as the enforcement floor.** Rejected: we can only reject what we are
  asked about, and a permanently-allowed tool asks nothing. It is the *answer*, not the gate.
- **Putting the gate in the Bot's own profile.** Rejected: it would make the Bot read-only when you talk
  to it too, which is not what anyone asked for. Hence a second, routine-only profile.
- **Declaring the profile `safe`.** Rejected on evidence: the field is presentation and enforces nothing.
- **A per-run Thread** (#175's draft). Rejected in part 1 — it discards the continuity that makes a
  report worth reading.
- **Event triggers** — webhooks, file watchers, CI hooks. Deferred: they need polling, rate limits, and
  an answer for events that occur while the app is closed.
- **A daemon or hosted scheduler** so routines fire with the app closed. Out of scope by ADR-0002 and by
  the shape of the product: we are a local orchestrator, not a service.
- **Storing a next-run time on the record.** Rejected in part 6 — a stored next-fire is a value somebody
  must remember to rewrite, which is the failure mode the derivation exists to remove.
