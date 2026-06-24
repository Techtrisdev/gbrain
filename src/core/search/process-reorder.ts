/**
 * v0.40.x — Option A: intent-conditional POST-rerank process reorder.
 *
 * Runs AFTER applyReranker so the cross-encoder cannot wash it out — the prior
 * pre-rerank `r.score` boost was a no-op in balanced/tokenmax because the reranker
 * reorders the head by its own relevanceScore and ignores `score` (rerank.ts).
 *
 * Gated at the call site by: the `process_reorder_enabled` mode flag (default
 * OFF) + `isProcessQuery(query)` + the structural entity guard below. Bounded +
 * conservative: within a small head window, the SINGLE highest-ranked process-dir
 * doc that sits BELOW a person-timeline chunk is lifted to just above the highest
 * such person-timeline chunk. No broad source boosts.
 */
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';

/** How-to / process content dirs. NOT a broad source boost — only consulted by the
 * gated reorder below. */
const PROCESS_DOC_PREFIXES = ['playbooks/', 'decisions/', 'handoffs/'];
const DEFAULT_WINDOW = 10;

function isProcessDoc(r: SearchResult): boolean {
  return PROCESS_DOC_PREFIXES.some(p => r.slug.startsWith(p));
}
// v0.40.x — target ANY person-page result, not strictly chunk_source='timeline'.
// The diagnosis called out person-TIMELINE chunks, but the robust target is the
// person PAGE: (a) timeline-only is a no-op when the offending person chunk is
// compiled_truth or ranks via vector, and (b) for a process query (entity-guarded)
// a person page should never outrank the how-to doc regardless of chunk type.
function isPersonResult(r: SearchResult): boolean {
  return r.slug.startsWith('people/');
}

/**
 * In place: within the top `windowSize` results, if a process-dir doc sits below a
 * person-timeline chunk, move that (single, highest) process doc to just above the
 * highest person-timeline chunk. No-op when there is no person-timeline chunk in the
 * window or no process doc below it. Mutates and returns the same array.
 *
 * Conservative by design — exactly one element moves, only within the window, only
 * process-dir vs person-timeline. Everything else keeps its reranked position.
 */
export function applyProcessReorder(results: SearchResult[], windowSize = DEFAULT_WINDOW): SearchResult[] {
  const window = Math.min(windowSize, results.length);
  if (window < 2) return results;

  // Highest-ranked person-page result in the window.
  let personIdx = -1;
  for (let i = 0; i < window; i++) {
    if (isPersonResult(results[i]!)) { personIdx = i; break; }
  }
  if (personIdx === -1) return results; // nothing to leapfrog

  // Highest-ranked process doc BELOW that person result, within the window.
  let processIdx = -1;
  for (let i = personIdx + 1; i < window; i++) {
    if (isProcessDoc(results[i]!)) { processIdx = i; break; }
  }
  if (processIdx === -1) return results; // no process doc to promote

  // Single conservative move: process doc → just above the highest person-timeline chunk.
  const [doc] = results.splice(processIdx, 1);
  results.splice(personIdx, 0, doc!);
  return results;
}

// Query-structure words excluded from the entity-guard token set (reduce false
// positives where a common word coincides with an entity title word).
const GUARD_STOPWORDS = new Set([
  'how', 'does', 'did', 'the', 'are', 'was', 'were', 'what', 'for', 'and', 'with',
  'into', 'get', 'gets', 'got', 'this', 'that', 'from', 'your', 'our', 'their', 'about',
]);

/**
 * v0.40.x — STRUCTURAL entity guard (replaces the phrase blocklist). True when the
 * query references a KNOWN person/company/deal entity in the corpus — matched by
 * comparing salient query tokens against entity-page title words. Lowercase-safe
 * (no capitalization assumption), single indexed query.
 *
 * Errs toward preserving entity ranking: ANY token match → true (suppress reorder),
 * and on a query error it FAILS CLOSED (returns true) so a DB hiccup can never
 * silently demote an entity result. The reorder is itself behind a default-off flag.
 */
export async function referencesKnownEntity(
  engine: BrainEngine,
  query: string,
  sourceId: string = 'default',
): Promise<boolean> {
  const tokens = Array.from(new Set(
    query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !GUARD_STOPWORDS.has(t)),
  ));
  if (tokens.length === 0) return false;
  // Whole-word alternation regex. Tokens are [a-z0-9]+ only (split above), so no
  // regex metacharacters can be injected. \m / \M are Postgres word boundaries.
  const pattern = '\\m(' + tokens.join('|') + ')\\M';
  try {
    const rows = await engine.executeRaw<{ one: number }>(
      `SELECT 1 AS one
         FROM pages
        WHERE deleted_at IS NULL
          AND source_id = $1
          AND (slug LIKE 'people/%' OR slug LIKE 'companies/%' OR slug LIKE 'deals/%')
          AND lower(title) ~ $2
        LIMIT 1`,
      [sourceId, pattern],
    );
    return rows.length > 0;
  } catch {
    // Fail CLOSED — assume the query may reference an entity and suppress the
    // reorder (preserve entity ranking, the explicit requirement).
    return true;
  }
}
