/**
 * Content-hash cache keys for the diff worker pool's parsed-AST cache (#389, PRD #387).
 * `@pierre/diffs` keys its per-file parse/highlight cache by an opaque `cacheKey` string
 * on `FileDiffMetadata` — the library itself never derives one from patch content, so
 * without this a re-render or a refetch that yields byte-identical patch text still
 * re-parses and re-highlights from scratch. Deriving the key here (renderer-pure, no
 * Node `crypto`) lets ANY call site that parses a patch string attach a stable key,
 * so identical patches hit the pool's LRU across remounts/refreshes.
 *
 * FNV-1a is a non-cryptographic hash: fast on long strings, good distribution, and
 * dependency-free. A single 32-bit hash collides too often at review-diff scale, so we
 * mix two independent 32-bit hashes (different seed/prime) plus the input length into
 * one key — a collision needs both hashes AND the length to coincide.
 */

const FNV_OFFSET_BASIS_32 = 0x811c9dc5
const FNV_PRIME_32 = 0x01000193
const SECONDARY_HASH_SEED = 0x9e3779b9
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b

/** One FNV-1a pass over `input`. Exported so the double-hash mixing is independently testable. */
export function fnv1a32(input: string, seed = FNV_OFFSET_BASIS_32, multiplier = FNV_PRIME_32): number {
  let hash = seed >>> 0
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, multiplier) >>> 0
  }
  return hash >>> 0
}

/**
 * Builds a stable cache key for a raw patch string, suitable as `parsePatchFiles`'
 * `cacheKeyPrefix` (or as a `FileDiffMetadata.cacheKey` directly). `scope` namespaces
 * keys built by different call sites so two features that happen to render identical
 * patch text don't share a pool cache slot; it defaults to a single shared scope since
 * today only one call site parses git diffs into the worker pool.
 */
export function buildPatchCacheKey(patch: string, scope = 'diff-view'): string {
  const normalized = patch.trim()
  const primary = fnv1a32(normalized, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36)
  const secondary = fnv1a32(normalized, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36)
  return `${scope}:${normalized.length}:${primary}:${secondary}`
}
