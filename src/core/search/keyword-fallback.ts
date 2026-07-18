import type { SearchResult } from '../types.ts';

/**
 * v0.42 — keyword→semantic fallback for the `search` op (TECH-2739 / U5).
 *
 * When keyword (BM25/ts_rank) search returns ZERO results and the
 * `search.keyword_semantic_fallback` knob is enabled, run a semantic fallback
 * and label those results `match_type: 'semantic'` so an existence-check caller
 * can tell a semantic GUESS from an exact keyword match. Keyword hits under an
 * enabled knob are labeled `match_type: 'keyword'` so the distinction is always
 * explicit; with the knob OFF the input is returned untouched (bit-for-bit the
 * prior verbatim-keyword behavior).
 *
 * Pure + fallback-fn-injected so it is unit-testable WITHOUT a live model — the
 * `search` handler wires the real `hybridSearchCached`, tests stub it. Labeling
 * happens at THIS envelope, never inside `hybridSearch`: `cachedHybridSearch`
 * rebuilds its meta with explicit field lists and would silently drop labels.
 */
export interface KeywordFallbackOutcome {
  results: SearchResult[];
  /** True iff keyword returned empty AND the semantic fallback ran. */
  fallback_fired: boolean;
}

export async function applyKeywordSemanticFallback(
  keywordResults: SearchResult[],
  enabled: boolean,
  runSemanticFallback: () => Promise<SearchResult[]>,
): Promise<KeywordFallbackOutcome> {
  // Knob off → return input untouched (no labels, no fallback, no extra work).
  if (!enabled) {
    return { results: keywordResults, fallback_fired: false };
  }
  // Keyword hit → label as exact keyword matches; no fallback.
  //
  // Label COPIES, never mutate in place: the rescued semantic rows below are
  // the SAME objects `hybridSearchCached`'s fire-and-forget cache store is
  // about to serialize — `store()` awaits a DB round-trip
  // (buildPageGenerationsSnapshot) BEFORE it JSON.stringify's the results, so
  // an in-place `match_type` write races into the persisted `query_cache` row
  // and would leak a 'semantic' label to a later non-fallback `query` cache
  // hit. Copy the keyword leg too for symmetry (its rows are fresh/uncached,
  // but the invariant "this helper never mutates its inputs" is cheaper to keep
  // than to reason about per-leg).
  if (keywordResults.length > 0) {
    return {
      results: keywordResults.map((r) => ({ ...r, match_type: 'keyword' as const })),
      fallback_fired: false,
    };
  }
  // Keyword empty → semantic rescue. Any abort/error propagates (the caller's
  // await rejects before telemetry/return) — no partial write. Label copies of
  // the rescued rows as semantic guesses (see the cache-contamination note).
  const semantic = await runSemanticFallback();
  return {
    results: semantic.map((r) => ({ ...r, match_type: 'semantic' as const })),
    fallback_fired: true,
  };
}
