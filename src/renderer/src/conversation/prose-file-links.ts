/**
 * Bare file paths in prose → FileChips (#185, slice 2 of #168).
 *
 * Agents rarely emit `[label](path)` markdown links — they write bare paths in prose
 * (`src/main/agent-pool.ts:42`). {@link remarkProseFileLinks} is a remark (mdast) transform
 * that detects file-ish paths in plain TEXT nodes and replaces them with standard `link`
 * nodes, so they flow through the UNTOUCHED `[raw, sanitize, guarded-harden]` rehype chain
 * and the existing `a` override → `parseFileLink` → `FileChip` pipeline exactly like an
 * explicitly authored link. The rehype/security posture of #168 (PR #184) is not modified.
 *
 * Code is excluded structurally: `mdast-util-find-and-replace` visits only `text` nodes,
 * and inline/fenced code are `inlineCode`/`code` LITERALS whose values are never text
 * nodes; existing links are skipped via `ignore: ['link', 'linkReference']`.
 *
 * Detection is pure and shared: {@link findProsePathMatches} runs the same candidate
 * regex + classification over a raw string, so `Response` can feed prose-detected paths
 * into the same `fileLinkLabels` disambiguation pool the chips read from.
 *
 * Provenance: candidate regex, trailing-delimiter trimming, and URL-first precedence are
 * ported from t3code's terminal linkifier (`terminal-links.ts`). t3code never chips bare
 * prose, so the STRICTNESS GATE below is ours: their patterns alone would chip `and/or`.
 * False-positive budget over recall — a missed path costs a click, a wrong chip is noise:
 *  - relative paths need a real extension on the final segment (`and/or`, `I/O` → plain);
 *  - bare filenames chip only with a `:line` suffix (`package.json:12` yes, `Node.js`,
 *    `e.g.`, `v1.2.3`, plain `package.json` no);
 *  - domain-shaped first segments are rejected (`github.com/foo/bar.ts` → plain; known
 *    false negative: `next.js/docs/x.ts`);
 *  - candidates inside URLs are rejected (schemed URLs are already `link` nodes at
 *    transform time — GFM autolinks at parse time — but the raw-text scan needs it).
 */
import type { PhrasingContent, Root } from 'mdast'
import { findAndReplace, type RegExpMatchObject } from 'mdast-util-find-and-replace'
import { parseFileLink, type FileLink } from './file-link'

/** A bare path detected in prose text. `end` is exclusive and reflects the trimmed span. */
export interface ProsePathMatch {
  start: number
  end: number
  /** The trimmed candidate, used verbatim as the link destination (may carry `:line:col`). */
  href: string
  /** `parseFileLink(href)` — the same shape the chip pipeline consumes. */
  link: FileLink
}

/**
 * Candidate scanner (fresh instance per scan — matching mutates `lastIndex`). NO capture
 * groups: `findAndReplace` spreads captures into the replace callback, so the signature
 * must stay `(value, match)`. Three alternatives:
 *  1. prefixed: `~/`, `./`, `../`, absolute `/`, Windows drive/UNC — then any non-space
 *     run (t3code; `*` additionally excluded so globs and `**bold**` tails never match);
 *  2. relative with ≥1 slash + optional `:line[:col]` (t3code);
 *  3. bare filename WITH a mandatory `:line[:col]` (ours — alt 2 requires a slash, and a
 *     positionless bare filename is below the false-positive budget).
 */
function candidatePattern(): RegExp {
  return /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>*]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}|[A-Za-z0-9._-]+\.[A-Za-z0-9_-]+:\d+(?::\d+)?/g
}

/** Spans of anything URL-shaped; path candidates overlapping one are rejected.
 *  Fresh instance per scan, like {@link candidatePattern} — `exec` mutates `lastIndex`. */
function urlPattern(): RegExp {
  return /\bhttps?:\/\/[^\s<>"'`]+|\bwww\.[^\s<>"'`]+/gi
}

const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?]+$/
const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/
const RELATIVE_PREFIX_PATTERN = /^(?:\.{1,2}\/|~\/)/
/** A real extension: letter-first (kills `x.3`), 1–8 chars. Applied to the basename. */
const EXTENSION_PATTERN = /\.[A-Za-z][A-Za-z0-9]{0,7}$/
/** TLD-shaped first segment of a relative candidate (`github.com`, `api.example.com`). */
const DOMAIN_SEGMENT_PATTERN = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/
const WINDOWS_PREFIX_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\)/
/** Chars that may legitimately precede a path in prose (whitespace, open brackets, quotes,
 *  `*` for bold). NOT `.`/`:`/`/`/`@`/backtick — a candidate starting after one of those is
 *  the tail of a larger token (URL innards, e-mail hosts, `` `code` `` spans). This guard is
 *  what makes rejection safe under `findAndReplace`'s retry-at-`start+1` semantics: every
 *  suffix of a rejected token starts after a path character and is rejected here too. */
const BOUNDARY_PATTERN = /[\s([{"'*]/

interface Span {
  start: number
  end: number
}

function findUrlSpans(input: string): Span[] {
  const spans: Span[] = []
  const pattern = urlPattern()
  let match: RegExpExecArray | null
  while ((match = pattern.exec(input)) !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length })
  }
  return spans
}

/** t3code's `trimClosingDelimiters`: trailing punctuation, then closing brackets that are
 *  unbalanced WITHIN the candidate — `(src/x.ts:42)` sheds the `)`, `dir/(x)/y.ts` keeps its own. */
function trimTrailingDelimiters(value: string): string {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, '')
  const trimUnbalanced = (open: string, close: string): void => {
    while (output.endsWith(close)) {
      const opens = output.split(open).length - 1
      const closes = output.split(close).length - 1
      if (opens >= closes) return
      output = output.slice(0, -1)
    }
  }
  trimUnbalanced('(', ')')
  trimUnbalanced('[', ']')
  trimUnbalanced('{', '}')
  return output.replace(TRAILING_PUNCTUATION_PATTERN, '')
}

function lastSegment(path: string): string {
  const separatorIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path
}

/**
 * The shared classification core: boundary guard → URL exclusion → trailing trim →
 * strictness gate → domain rejection → `parseFileLink` as final validation. Returns the
 * trimmed href + parsed link, or null. Both consumers (the remark transform and the raw
 * label-pool scan) run the exact same pipeline so they can never disagree on what chips.
 */
function classifyCandidate(
  input: string,
  start: number,
  raw: string,
  urlSpans: readonly Span[],
): { href: string; link: FileLink } | null {
  if (start > 0 && !BOUNDARY_PATTERN.test(input[start - 1] ?? '')) return null

  const end = start + raw.length
  if (urlSpans.some((span) => start < span.end && span.start < end)) return null

  const href = trimTrailingDelimiters(raw)
  if (href.length === 0) return null

  const positionMatch = href.match(POSITION_SUFFIX_PATTERN)
  const pathPart = positionMatch ? href.slice(0, -positionMatch[0].length) : href
  const hasRelativePrefix = RELATIVE_PREFIX_PATTERN.test(pathPart)
  const hasSlash = pathPart.includes('/') || pathPart.includes('\\')
  const hasExtension = EXTENSION_PATTERN.test(lastSegment(pathPart))
  const gatePasses =
    hasRelativePrefix ||
    (hasSlash && hasExtension) ||
    (positionMatch !== null && (hasSlash || hasExtension))
  if (!gatePasses) return null

  if (
    hasSlash &&
    !hasRelativePrefix &&
    !pathPart.startsWith('/') &&
    !WINDOWS_PREFIX_PATTERN.test(pathPart)
  ) {
    const firstSegment = pathPart.split('/')[0] ?? ''
    if (DOMAIN_SEGMENT_PATTERN.test(firstSegment)) return null
  }

  const link = parseFileLink(href)
  if (!link) return null
  return { href, link }
}

/**
 * Pure scan of a raw string for chippable bare paths. Mirrors `findAndReplace`'s cursor
 * semantics exactly (rejected candidate → resume at `start + 1`; accepted → after the
 * trimmed span) so the transform and this scan detect the same set.
 */
export function findProsePathMatches(text: string): ProsePathMatch[] {
  const urlSpans = findUrlSpans(text)
  const pattern = candidatePattern()
  const matches: ProsePathMatch[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const classified = classifyCandidate(text, match.index, match[0], urlSpans)
    if (!classified) {
      pattern.lastIndex = match.index + 1
      continue
    }
    matches.push({
      start: match.index,
      end: match.index + classified.href.length,
      href: classified.href,
      link: classified.link,
    })
    pattern.lastIndex = match.index + classified.href.length
  }
  return matches
}

/** A colon before the first (back)slash — `package.json:12`, `C:\repo\a.ts` — makes
 *  `rehype-sanitize` read the head as a URL SCHEME (`package.json:`) and strip the href,
 *  after which harden renders `[blocked]` INTO the prose. Percent-encode the colons for
 *  such candidates: sanitize then sees a scheme-less relative href, and `parseFileLink`
 *  (which `safeDecode`s every href it classifies) still parses the identical path, so the
 *  chip pipeline and the label pool agree. Slash-first paths (`src/x.ts:42`) never trip
 *  the scheme check and stay byte-for-byte as authored explicit links always have. */
function schemeSafeUrl(href: string): string {
  return /^[^/\\]*:/.test(href) ? href.replaceAll(':', '%3A') : href
}

function replaceCandidate(
  value: string,
  match: RegExpMatchObject,
): PhrasingContent[] | false {
  const classified = classifyCandidate(match.input, match.index, value, findUrlSpans(match.input))
  if (!classified) return false
  const nodes: PhrasingContent[] = [
    {
      type: 'link',
      url: schemeSafeUrl(classified.href),
      children: [{ type: 'text', value: classified.href }],
    },
  ]
  // The trim may have shed trailing punctuation/brackets — restore them as plain text.
  const rest = value.slice(classified.href.length)
  if (rest.length > 0) nodes.push({ type: 'text', value: rest })
  return nodes
}

/**
 * The remark plugin. MUST stay a NAMED function: streamdown's processor cache keys on the
 * plugin function's `name`, and an anonymous entry can collide across Streamdown instances.
 */
export function remarkProseFileLinks(): (tree: Root) => undefined {
  return function transformProseFileLinks(tree: Root): undefined {
    findAndReplace(tree, [candidatePattern(), replaceCandidate], {
      ignore: ['link', 'linkReference'],
    })
    return undefined
  }
}
