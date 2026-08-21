/**
 * The **Allowed commands** matcher (#469, ADR-0028 part 4) — pure, total, and
 * deliberately the least clever module in the feature.
 *
 * It answers one question: *may an unattended Routine run this exact invocation?*
 * The answer is yes only when the WHOLE invocation string appears, verbatim, in
 * the list the user authored. There is no prefix matching, no argument matching,
 * no globbing and no tokenising, and each of those absences is a decision:
 *
 *  - **Whole-string, because Vibe's own tokeniser is what leaked.** #458 found
 *    `echo "hello" > file` passing a command allowlist that never mentioned a
 *    redirect, because the shell parser treats the redirect as a separate part.
 *    Re-verified on the wire at vibe-acp 2.24.3 (`docs/acp-capture.md` §17): the
 *    permission request's own `invocation_pattern` for that command reads
 *    `echo hello <redirect>` — **the redirect is erased from it**. Anything that
 *    matches per-part inherits that hole, so we match the raw command text and
 *    nothing else.
 *  - **No prefix matching**, because `git log` on the list would otherwise
 *    authorise `git log --format=$(curl …)`.
 *  - **No globbing**, because the widened patterns Vibe offers alongside a request
 *    (`session_pattern: "echo *"`) are exactly the grant an unattended run must
 *    not take.
 *
 * The shell-operator rule below is therefore REDUNDANT to whole-string matching —
 * an invocation containing an operator is refused by rule 2 anyway unless it was
 * listed verbatim. It exists to give the refusal a name (so slice 5 can say *why*
 * rather than only *what*), and as a tripwire: if anyone ever loosens rule 2 into
 * something fuzzier, this rule is the line the loosening must not cross.
 *
 * Node/DOM-free, no dependencies, no clock — every rule here is a unit test.
 */

/**
 * The shell metacharacters that make one "command" into several, or into
 * something whose text does not say what it runs:
 *
 * | char | why |
 * |---|---|
 * | `>` `<` | redirects — the #458 hole; the file written is not in the command name |
 * | `\|` | pipes into another program |
 * | `;` `&` | command separators / background |
 * | `` ` `` `$` | command and variable substitution: `$(…)`, `` `…` ``, `${…}` |
 * | `(` `)` | subshells |
 * | newline | two invocations wearing one entry's clothes (also refused at write) |
 *
 * Not a sanitiser and not a parser — a name for the refusal. The gate is the
 * whole-string comparison above it.
 */
const SHELL_OPERATORS = /[<>|;&`$()\n\r]/

/** Why an invocation was refused, in the vocabulary the failure message uses. */
export type AllowedCommandRefusal =
  /**
   * The request was not about a shell command we could identify at all — an
   * unknown tool call (a subagent's, say), a non-shell tool, or a permission
   * about something other than a command. Never returned by
   * {@link matchAllowedCommand}, which is only ever asked about commands; it is
   * the answering path's word for *there was nothing here to match*.
   */
  | 'unidentified'
  /** Nothing to match — no command text was recovered from the wire. */
  | 'blank'
  /**
   * It carries a redirect, pipe, separator or substitution and is not listed
   * VERBATIM. Named separately because it is the #458 finding, and because
   * "add this to the list" is worse advice for this case than for the next.
   */
  | 'shell-operator'
  /** An ordinary invocation this Routine simply has not been allowed to run. */
  | 'not-listed'

export type AllowedCommandMatch =
  /** Listed verbatim. `entry` is the list entry that authorised it. */
  | { allowed: true; entry: string }
  | { allowed: false; reason: AllowedCommandRefusal }

/**
 * Match one invocation against a Routine's allowed commands.
 *
 * Both sides are trimmed and nothing else is normalised: internal spacing, quoting
 * and case are all significant, because they are all significant to a shell.
 * `normalizeAllowedCommands` (the write path) already trims the stored entries —
 * trimming again here means a hand-edited database row cannot authorise something
 * its author would not recognise, which is the leading/trailing-whitespace case
 * #458 called out.
 */
export function matchAllowedCommand(
  invocation: string,
  allowedCommands: readonly string[],
): AllowedCommandMatch {
  const command = typeof invocation === 'string' ? invocation.trim() : ''
  if (!command) return { allowed: false, reason: 'blank' }

  for (const candidate of allowedCommands) {
    if (typeof candidate !== 'string') continue
    const entry = candidate.trim()
    // Rule 2, and the whole gate: WHOLE-STRING equality. A listed entry that
    // itself contains an operator is honoured — the user typed it, verbatim, in
    // full knowledge of what it does. That is the one intended way past the rule
    // below, and it is why the rule is stated as "unless that exact string is
    // listed" rather than as a ban.
    if (entry && entry === command) return { allowed: true, entry }
  }

  if (SHELL_OPERATORS.test(command)) return { allowed: false, reason: 'shell-operator' }
  return { allowed: false, reason: 'not-listed' }
}

/** Whether an invocation contains shell operators — exported for the refusal copy. */
export function hasShellOperator(invocation: string): boolean {
  return SHELL_OPERATORS.test(invocation)
}

/**
 * The sentence a blocked Routine reports, naming the exact command (ADR-0028
 * part 4: "the cancellation is reported naming the exact command").
 *
 * One wording, here, because it is read in three places — the Routine's failure
 * detail, the entry written into the Bot's conversation, and (slice 5) the offer
 * to add the command to the list.
 */
export function refusalMessage(routineName: string, command: string | null, reason: AllowedCommandRefusal): string {
  const named = command ? `\`${command}\`` : 'a command it did not describe'
  switch (reason) {
    case 'unidentified':
      return (
        `"${routineName}" was stopped: the agent asked to do something that is not a shell command ` +
        'this app could name, and an unattended run only ever allows commands you listed.'
      )
    case 'blank':
      return (
        `"${routineName}" was stopped: the agent asked to run something this app could not read, ` +
        'so it was refused and the run was cancelled.'
      )
    case 'shell-operator':
      return (
        `"${routineName}" was stopped before running ${named}. It combines commands ` +
        '(a redirect, pipe, separator or substitution), so it is only ever run when that exact ' +
        "line is on the routine's allowed commands."
      )
    case 'not-listed':
      return `"${routineName}" was stopped before running ${named}, which is not on its allowed commands.`
  }
}
