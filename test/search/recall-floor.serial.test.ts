/**
 * Recall-floor decoupling (v0.44).
 *
 * The recall/rerank candidate pool (`innerLimit`) must never be shallower than
 * the reranker will score (`reranker_top_n_in`). The legacy `limit * 2` tied the
 * pool to the caller's DISPLAY limit, so a small-limit call (limit=3 → pool=6)
 * handed the cross-encoder fewer candidates than its topNIn budget (30) — the
 * reranker was STARVED. A weak vector-match answer page (an entity page buried
 * under query-space hubs at cosine rank ~21) was then structurally unreachable
 * via the vector leg for small-limit callers, reaching the reranker only if the
 * keyword AND-match happened to surface it. A phrasing that missed on keyword
 * FALSELY ABSTAINED — even though the reranker scores that page ~0.9 whenever it
 * actually sees it. Root cause: gbrain-entity-vs-topic-ranking-defect (Q01 Hang,
 * TARS parity: candidate_count=10 with a healthy corpus).
 *
 * This file has two guards:
 *   1. UNIT — the pure `resolveInnerLimit` invariant (deterministic).
 *   2. END-TO-END — a controlled corpus where the answer sits at vector rank ~21
 *      and is keyword-orthogonal; a small-limit query FALSELY ABSTAINS on the
 *      legacy formula and SERVES the answer with the floor. Both go red if the
 *      floor is reverted (mutation check).
 *
 * SERIAL: configureGateway + __setEmbedTransportForTests mutate the process-
 * global gateway singleton, which leaks across a parallel shard.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, resolveInnerLimit } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { PageInput, HybridSearchMeta } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

const MAX = 100; // MAX_SEARCH_LIMIT
const TOP_N_IN = 30;

describe('resolveInnerLimit — recall-floor invariant (unit)', () => {
  const mode = { rerankerEnabled: true, rerankerTopNIn: TOP_N_IN };

  test('floors small display limits at reranker_top_n_in (the reranker is never starved)', () => {
    // The regression: with the legacy `limit * 2`, these all returned < TOP_N_IN,
    // starving the reranker and hiding weak vector-match answers.
    for (const displayLimit of [1, 3, 5, 8, 10, 14]) {
      expect(resolveInnerLimit(displayLimit, mode)).toBeGreaterThanOrEqual(TOP_N_IN);
    }
  });

  test('leaves large display limits at limit*2 (floor is a minimum, not a cap)', () => {
    expect(resolveInnerLimit(25, mode)).toBe(50); // max(50, 30) = 50, unchanged
    expect(resolveInnerLimit(40, mode)).toBe(80);
  });

  test('never exceeds MAX_SEARCH_LIMIT', () => {
    expect(resolveInnerLimit(90, mode)).toBe(MAX);
    expect(resolveInnerLimit(1000, mode)).toBe(MAX);
  });

  test('no floor when the reranker will not run (nothing to starve)', () => {
    const off = { rerankerEnabled: false, rerankerTopNIn: TOP_N_IN };
    expect(resolveInnerLimit(3, off)).toBe(6); // legacy limit*2, no floor
  });
});

// ---- End-to-end reproduction ------------------------------------------------

let engine: PGLiteEngine;
const DIMS = 1536;
// Query points at basis dim 0. A page's distance to the query grows with its
// dim-1 magnitude (cosine = 1/sqrt(1+a^2)), so `a` is a monotone rank knob.
const QUERY_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0));
function pageEmb(a: number): number[] {
  const v = new Array(DIMS).fill(0);
  v[0] = 1;
  v[1] = a;
  return v;
}

const ANSWER_SLUG = 'integrations/answer';
// The reranker rescues ONLY the answer (mirrors reality: it scores the buried
// entity page ~0.9 whenever it actually reaches the cross-encoder).
const rerankAnswerHigh = {
  enabled: true,
  topNIn: TOP_N_IN,
  topNOut: null,
  // A real reranker API returns documents SORTED by relevance DESC; applyReranker
  // preserves that returned order (it does not re-sort by score itself). Mirror
  // that contract so the 0.9 answer is reordered to the head, not left in place.
  rerankerFn: async (input: RerankInput): Promise<RerankResult[]> =>
    input.documents
      .map((d, i) => ({
        index: i,
        relevanceScore: /answermarker/i.test(typeof d === 'string' ? d : (d as { text?: string }).text ?? '') ? 0.9 : 0.1,
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore),
};

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // 20 near hubs (ranks 1..20): a TIGHT cluster near the query (dim-1 0.01..0.20,
  // cosine ~0.98..0.9999). The gap to the answer is large enough that the
  // searchVector source-factor boost cannot lift the answer into a shallow pool.
  for (let i = 1; i <= 20; i++) {
    const slug = `hubs/near-${i}`;
    await engine.putPage(slug, { type: 'note', title: `Near hub ${i}`, compiled_truth: 'widgetstatus hub noise' } as PageInput);
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'widgetstatus hub noise report', chunk_source: 'compiled_truth', embedding: pageEmb(0.01 * i) },
    ]);
  }
  // The answer at rank 21: keyword-ORTHOGONAL (no 'widgetstatus' token) and a
  // decisively WEAK vector match (dim-1 = 2.0, cosine ~0.45 — far below every
  // near hub, so no source boost can promote it into a top-6 pool).
  await engine.putPage(ANSWER_SLUG, { type: 'integration', title: 'Answer', compiled_truth: 'answermarker the integration is live' } as PageInput);
  await engine.upsertChunks(ANSWER_SLUG, [
    { chunk_index: 0, chunk_text: 'answermarker the integration is live and connected', chunk_source: 'compiled_truth', embedding: pageEmb(2.0) },
  ]);
  // 14 far hubs (ranks 22..35): pad the pool past the floor so the answer is a
  // genuine mid-pool candidate, not the pool's tail.
  for (let j = 1; j <= 14; j++) {
    const slug = `hubs/far-${j}`;
    await engine.putPage(slug, { type: 'note', title: `Far hub ${j}`, compiled_truth: 'widgetstatus hub noise' } as PageInput);
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: 'widgetstatus hub noise report', chunk_source: 'compiled_truth', embedding: pageEmb(2.5 + 0.1 * j) },
    ]);
  }

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  // The query embeds to QUERY_EMB (basis dim 0); page embeddings are explicit.
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => QUERY_EMB),
  }) as any);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

async function run(query: string, limit: number): Promise<{ meta: HybridSearchMeta | null; results: Array<{ slug?: string }> }> {
  let meta: HybridSearchMeta | null = null;
  const results = (await hybridSearch(engine, query, {
    limit,
    reranker: rerankAnswerHigh,
    onMeta: (m) => { meta = m; },
  })) as Array<{ slug?: string }>;
  return { meta, results };
}

describe('recall-floor — end-to-end false-abstain guard', () => {
  beforeAll(async () => { await engine.setConfig('search.rerank_abstain_floor', '0.5'); });
  afterAll(async () => { await engine.unsetConfig('search.rerank_abstain_floor'); });

  // `zzqnomatch` matches nothing on the keyword leg, so ONLY the vector leg
  // drives the candidate pool and the answer's fused rank equals its vector rank
  // (21) — isolating the recall-floor mechanism from RRF/keyword confounds. This
  // is exactly the phrasing-missed-on-keyword case that made the production bug
  // intermittent (the keyword leg otherwise rescues the answer).
  const Q = 'zzqnomatch';

  test('small-limit query reaches the rank-~21 answer and does NOT falsely abstain', async () => {
    // limit=3: legacy innerLimit=6 → answer (rank 21) excluded from the vector
    // pool → reranker sees only low-scoring hubs → max 0.1 < floor → ABSTAIN
    // (the production bug). With the floor innerLimit>=30 → answer is in the pool
    // → reranker scores it 0.9 → served. This assertion goes RED on pre-fix code.
    const { meta, results } = await run(Q, 3);
    expect(meta?.abstained).toBe(false);
    expect(results.some((r) => r.slug === ANSWER_SLUG)).toBe(true);
  });

  test('the answer is served across the small-limit range (limit 1..8), never falsely abstaining', async () => {
    // The production false-abstain needed all three weaknesses at once: weak
    // vector match + shallow display-coupled pool + keyword miss. This is that
    // exact intersection across small limits, and the floor alone resolves it.
    for (const limit of [1, 2, 5, 8]) {
      const { meta, results } = await run(Q, limit);
      expect(meta?.abstained).toBe(false);
      expect(results.some((r) => r.slug === ANSWER_SLUG)).toBe(true);
    }
  });
});
