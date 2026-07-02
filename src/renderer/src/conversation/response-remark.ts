import { defaultRemarkPlugins } from 'streamdown'
import type { Pluggable, PluggableList } from 'unified'
import { remarkProseFileLinks } from './prose-file-links'

/**
 * The remark (markdown-AST) plugin chain for {@link Response} (#185) — the exact remark-side
 * counterpart of `response-rehype.ts`: the `remarkPlugins` prop REPLACES streamdown's defaults
 * (it does not append), so this list re-supplies them UNCHANGED and only appends ours.
 *
 * Streamdown 2.5.0's defaults (`defaultRemarkPlugins`, a `Record<'gfm'|'codeMeta', Pluggable>`):
 *  - `gfm`      — `remark-gfm`: tables, strikethrough, task lists, URL autolinks. Dropping it
 *                 silently loses all of those.
 *  - `codeMeta` — copies a fence's `meta` onto `hProperties.metastring`, which `@streamdown/code`
 *                 reads; dropping it breaks the code block title/controls.
 *  - `remarkProseFileLinks` (#185) then turns bare file paths in prose text into standard `link`
 *    nodes. It runs UPSTREAM of the whole `[raw, sanitize, guarded-harden]` rehype chain, so an
 *    auto-linkified path is secured exactly like an explicitly authored `[label](path)` link —
 *    the #168/#184 posture is untouched.
 *
 * Both entries are pulled by KEY and verified at module load — fail loud on a streamdown
 * upgrade that renames them, rather than silently shipping without GFM or code metadata.
 * MUST stay a module-level constant: streamdown's Block memo compares `remarkPlugins` by
 * identity, so an inline array would re-render every completed block on each streaming token.
 */
const { gfm, codeMeta } = defaultRemarkPlugins as Record<'gfm' | 'codeMeta', Pluggable>
if (!gfm || !codeMeta) {
  throw new Error('streamdown defaultRemarkPlugins is missing the expected gfm/codeMeta entries')
}

export const responseRemarkPlugins: PluggableList = [gfm, codeMeta, remarkProseFileLinks]
