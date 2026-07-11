import { useMemo, type JSX } from 'react'
import { Streamdown, type Components } from 'streamdown'
import { code } from '@streamdown/code'
import { cn } from '../lib/utils'
import { extractLinkHrefs, fileLinkLabels, isSafeExternalHref, parseFileLink } from './file-link'
import { FileChip } from './FileChip'
import { findProsePathMatches } from './prose-file-links'
import { responseRehypePlugins } from './response-rehype'
import { responseRemarkPlugins } from './response-remark'

/** Streamdown normally paints these prose elements with its own Tailwind utilities.
 * Mapping them back to intrinsic elements lets the container-level Typeset stylesheet
 * own their rhythm while Streamdown keeps parsing, streaming, and interactive blocks. */
const TYPESET_SEMANTIC_COMPONENTS = {
  blockquote: 'blockquote',
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  h5: 'h5',
  h6: 'h6',
  hr: 'hr',
  li: 'li',
  ol: 'ol',
  strong: 'strong',
  sub: 'sub',
  sup: 'sup',
  tbody: 'tbody',
  td: 'td',
  th: 'th',
  thead: 'thead',
  tr: 'tr',
  ul: 'ul',
} as const satisfies Components

/**
 * Renders agent-authored text as streaming-safe Markdown (#114, spike #112). Wraps
 * `streamdown`: it self-heals incomplete markdown as it streams (`parseIncompleteMarkdown`),
 * splits into blocks so completed prose isn't re-highlighted every token, and ships
 * shiki syntax highlighting + a copy control via the `@streamdown/code` plugin.
 * Themed to our tokens through the `@source` + `@theme inline` map in styles.css.
 *
 * SECURITY: agent output is UNTRUSTED. The `rehypePlugins` below is streamdown's own default
 * `[raw, sanitize, harden]` chain, minimally reconfigured for #168 — see `response-rehype.ts` for
 * the full rationale. Each layer:
 *  - `sanitize` (`rehype-sanitize`) is THE XSS wall — the only one: it drops disallowed raw
 *    HTML elements/attributes the model emits (`<script>`, `<img onerror=…>`, `<svg onload>`)
 *    and STRIPS the href off `javascript:`/`data:`/`vbscript:` links before render. NB raw
 *    HTML is NOT "skipped": `raw` parses it into real element nodes first, which makes
 *    `skipHtml` (below) inert in this chain — it only removes raw-type nodes, which no longer
 *    exist after `raw` runs. It's kept as a dead-man's guard (it matters again if `raw` is
 *    ever dropped), NOT as a live protection — do not credit it in a security analysis.
 *  - `harden` (`rehype-harden`) origin-checks external link/image URLs. #168 wraps it so ONLY
 *    file-path anchors bypass it (reaching the `a` override unrewritten so `FileChip` can render);
 *    every dangerous or external href still goes through harden exactly as before.
 *  - the `a` override below is the final layer: it renders a file path as a `FileChip` and only
 *    emits a real anchor for an `isSafeExternalHref` scheme, so it can't become a `javascript:` sink
 *    even if the chain upstream ever changes.
 * We pass `responseRehypePlugins` because the `rehypePlugins` prop REPLACES streamdown's defaults;
 * **do NOT drop `raw`/`sanitize` from that list** — either would reintroduce raw-HTML/href XSS.
 * Do not remove `skipHtml` either.
 *
 * `remarkPlugins` (#185) has the same REPLACES-defaults hazard, solved the same way: see
 * `response-remark.ts`, which re-supplies streamdown's `gfm`/`codeMeta` and appends
 * `remarkProseFileLinks` — a markdown-AST transform that turns bare file paths in prose into
 * standard `link` nodes. Those run UPSTREAM of the whole sanitize/harden chain above, so an
 * auto-linkified path is secured exactly like an authored `[label](path)` link. Never inline
 * either plugin array — streamdown memoizes blocks by the arrays' identities.
 *
 * Typeset integration and two custom `components` overrides:
 *  - semantic prose elements — Streamdown's default renderers carry their own
 *    typography utilities. Mapping them to intrinsic HTML lets `typeset.css` own
 *    size, leading, and forward-only flow without changing the Markdown pipeline.
 *  - `inlineCode` — resolves the spike's `muted` token collision: streamdown's default
 *    inline code is `bg-muted`, but our `--color-muted` is a text-grey, so we repaint
 *    inline code on `--accent-tint` instead (code BLOCKS use `bg-sidebar`, no collision).
 *  - `a` — turns file-path destinations into an orange `FileChip`; other links stay
 *    plain accent-underlined anchors (opened in the system browser).
 */
export function Response({ text, className }: { text: string; className?: string }): JSX.Element {
  // Disambiguate basenames across THIS message once: an `a` override renders each
  // link independently, so we pre-derive the label map from the full text and close
  // over it (pure `file-link` logic; DOM-free).
  const components = useMemo<Components>(() => {
    const paths: string[] = []
    for (const href of extractLinkHrefs(text)) {
      const link = parseFileLink(href)
      if (link) paths.push(link.path)
    }
    // Bare paths auto-linkified by `remarkProseFileLinks` (#185) must disambiguate in the
    // same pool. This raw-text scan also sees paths inside code fences the transform will
    // never touch — harmless: a pooled-but-unchipped path can only add a `· parent` suffix
    // to a colliding chip label, never render a wrong chip.
    for (const { link } of findProsePathMatches(text)) paths.push(link.path)
    const labels = fileLinkLabels(paths)

    // Only bind the props we forward — leaving `node` (and other react-markdown
    // ExtraProps) undestructured keeps them off the DOM element AND lint-clean.
    return {
      ...TYPESET_SEMANTIC_COMPONENTS,
      inlineCode: ({ className: codeClassName, children }) => (
        <code
          className={cn(
            'rounded-md border border-border bg-[var(--accent-tint)] px-1.5 py-0.5 font-mono text-[0.85em]',
            codeClassName,
          )}
        >
          {children}
        </code>
      ),
      a: ({ href, className: linkClassName, children }) => {
        const link = href ? parseFileLink(href) : null
        if (link) return <FileChip link={link} label={labels.get(link.path) ?? link.basename} />
        // Defence-in-depth: the sanitize/harden chain already strips dangerous hrefs
        // before we get here, but only render a real anchor for an allow-listed scheme
        // so a future config change can't turn this override into a `javascript:` sink.
        // A rejected scheme renders as inert text (no href), never a clickable link.
        if (!isSafeExternalHref(href)) return <span className={linkClassName}>{children}</span>
        return (
          <a
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            className={cn('font-medium text-accent-text underline', linkClassName)}
          >
            {children}
          </a>
        )
      },
    }
  }, [text])

  return (
    <Streamdown
      className={cn('typeset typeset-chat min-w-0 space-y-0', className)}
      plugins={{ code }}
      controls={{ code: { copy: true } }}
      rehypePlugins={responseRehypePlugins}
      remarkPlugins={responseRemarkPlugins}
      parseIncompleteMarkdown
      skipHtml
      components={components}
    >
      {text}
    </Streamdown>
  )
}
