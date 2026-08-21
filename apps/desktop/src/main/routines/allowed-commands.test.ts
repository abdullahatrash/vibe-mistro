import { describe, expect, it } from 'vitest'
import { hasShellOperator, matchAllowedCommand, refusalMessage } from './allowed-commands'

/**
 * The **Allowed commands** matcher (#469, ADR-0028 part 4), tested adversarially —
 * and the adversary is not imagined. Every case in the first block is a route the
 * #458 probe actually observed an agent take, or a shape the probe found inside
 * Vibe's own permission payloads. A matcher that passes an invented suite and
 * fails these would be worse than useless, because it would look tested.
 */

const ALLOWED = ['gh issue list --state open', 'git status', 'ls']

describe('matchAllowedCommand', () => {
  it('allows an invocation listed verbatim', () => {
    expect(matchAllowedCommand('gh issue list --state open', ALLOWED)).toEqual({
      allowed: true,
      entry: 'gh issue list --state open',
    })
  })

  describe("the routes #458 watched an agent take when it was denied", () => {
    it('refuses THE redirect that passed a command allowlist', () => {
      // The finding the whole design turns on: with the file-writing tools set to
      // `never`, the agent wrote the file with `echo … > file`, because the
      // redirect tokenises as a separate part and the allowlist only ever saw
      // `echo`. Whole-string matching is what closes it.
      expect(matchAllowedCommand('echo "hello" > file.txt', ['echo'])).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
    })

    it('refuses an appending redirect, and a redirect onto a listed command', () => {
      expect(matchAllowedCommand('ls >> out.txt', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
      expect(matchAllowedCommand('ls > /etc/hosts', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
    })

    it('refuses a pipe, even when both halves are listed', () => {
      expect(matchAllowedCommand('git status | ls', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
    })

    it('refuses command substitution in both spellings, and a variable', () => {
      expect(matchAllowedCommand('ls $(whoami)', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
      expect(matchAllowedCommand('ls `whoami`', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
      expect(matchAllowedCommand('ls ${HOME}', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
    })

    it('refuses separators and a subshell — the `cd && echo >` shape', () => {
      expect(matchAllowedCommand('cd /tmp && echo hi > a.txt', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
      expect(matchAllowedCommand('ls; rm -rf .', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
      expect(matchAllowedCommand('(ls)', ALLOWED)).toEqual({
        allowed: false,
        reason: 'shell-operator',
      })
    })
  })

  describe('whole-string matching', () => {
    it('refuses a longer command that a listed entry is a PREFIX of', () => {
      // The property that stops a list from widening as arguments are added:
      // `git status` on the list must never authorise `git status --porcelain`,
      // and `ls` must never authorise `ls /etc`.
      expect(matchAllowedCommand('git status --porcelain', ALLOWED)).toEqual({
        allowed: false,
        reason: 'not-listed',
      })
      expect(matchAllowedCommand('ls /etc', ALLOWED)).toEqual({
        allowed: false,
        reason: 'not-listed',
      })
    })

    it('refuses a command that a listed entry is a SUFFIX or substring of', () => {
      expect(matchAllowedCommand('sudo ls', ALLOWED)).toEqual({
        allowed: false,
        reason: 'not-listed',
      })
      expect(matchAllowedCommand('gh issue list --state open --limit 5', ALLOWED)).toEqual({
        allowed: false,
        reason: 'not-listed',
      })
    })

    it('is case- and whitespace-significant inside the command', () => {
      expect(matchAllowedCommand('LS', ALLOWED).allowed).toBe(false)
      expect(matchAllowedCommand('git  status', ALLOWED).allowed).toBe(false)
    })
  })

  describe('whitespace at the edges', () => {
    it('allows an invocation that differs only by leading or trailing whitespace', () => {
      expect(matchAllowedCommand('  git status  ', ALLOWED)).toEqual({
        allowed: true,
        entry: 'git status',
      })
      expect(matchAllowedCommand('\tls\n', ALLOWED)).toEqual({ allowed: true, entry: 'ls' })
    })

    it('trims the LIST too, so a hand-edited row cannot mean something else', () => {
      expect(matchAllowedCommand('git status', ['  git status  '])).toEqual({
        allowed: true,
        entry: 'git status',
      })
    })

    it('refuses a blank or whitespace-only invocation', () => {
      expect(matchAllowedCommand('', ALLOWED)).toEqual({ allowed: false, reason: 'blank' })
      expect(matchAllowedCommand('   ', ALLOWED)).toEqual({ allowed: false, reason: 'blank' })
    })
  })

  describe('the list itself', () => {
    it('refuses everything when the list is empty — the default a Routine is created with', () => {
      expect(matchAllowedCommand('ls', [])).toEqual({ allowed: false, reason: 'not-listed' })
    })

    it('allows an operator-carrying command when it is listed VERBATIM', () => {
      // The one intended way past the operator rule: the user typed the whole
      // line, so the whole line is what is authorised — and nothing near it is.
      const listed = ['gh issue list --json number | head -5']
      expect(matchAllowedCommand('gh issue list --json number | head -5', listed)).toEqual({
        allowed: true,
        entry: 'gh issue list --json number | head -5',
      })
      expect(matchAllowedCommand('gh issue list --json number | head -6', listed).allowed).toBe(false)
    })

    it('ignores blank and non-string entries rather than matching on them', () => {
      const ragged = ['', '   ', 42 as unknown as string, 'ls']
      expect(matchAllowedCommand('ls', ragged)).toEqual({ allowed: true, entry: 'ls' })
      expect(matchAllowedCommand('', ragged)).toEqual({ allowed: false, reason: 'blank' })
    })
  })
})

describe('hasShellOperator', () => {
  it('names the operators the refusal is about', () => {
    for (const command of ['a > b', 'a | b', 'a; b', 'a && b', 'a $(b)', 'a `b`', '(a)']) {
      expect({ command, operator: hasShellOperator(command) }).toEqual({ command, operator: true })
    }
    expect(hasShellOperator('gh issue list --state open')).toBe(false)
  })
})

describe('refusalMessage', () => {
  it('names the exact command, so the report is fixable', () => {
    const message = refusalMessage('Morning triage', 'gh pr merge 12', 'not-listed')
    expect(message).toContain('Morning triage')
    expect(message).toContain('`gh pr merge 12`')
  })

  it('says something true when there was no command to name', () => {
    expect(refusalMessage('Morning triage', null, 'unidentified')).toContain('not a shell command')
    expect(refusalMessage('Morning triage', null, 'blank')).toContain('could not read')
  })
})
