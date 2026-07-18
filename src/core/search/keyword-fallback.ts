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
  if (keywordResults.length > 0) {
    for (const r of keywordResults) r.match_type = 'keyword';
    return { results: keywordResults, fallback_fired: false };
  }
  // Keyword empty → semantic rescue. Any abort/error propagates (the caller's
  // await rejects before telemetry/return) — no partial write. Label the
  // rescued results as semantic guesses.
  const semantic = await runSemanticFallback();
  for (const r of semantic) r.match_type = 'semantic';
  return { results: semantic, fallback_fired: true };
}
