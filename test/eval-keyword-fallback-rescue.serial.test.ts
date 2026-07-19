/**
 * TECH-2743 — reconstructed empty-keyword → semantic rescue evidence.
 *
 * PRODUCTION ANCHOR (retrieval_events, 2026-07): 400 of 439 keyword `search` calls
 * returned ZERO results — a 91% keyword-miss rate, almost entirely from the read-only
 * client agents issuing conceptual `general`-intent queries. The raw
 * query text is UNRECOVERABLE (retrieval_events keeps only a SHA-256 query_hash;
 * mcp_request_log.params is redacted), so we cannot replay the literal production
 * queries. Instead we replay a RECONSTRUCTED representative set — the labeled real-prose
 * corpus (people / company / how-to / runbook / integration / decision docs) — and
 * measure whether the guarded keyword→semantic fallback (TECH-2739) rescues the keyword
 * misses.
 *
 * Hermetic: frozen ZeroEntropy zembed-1 @1280 document + query vectors, no network — the
 * same rig as eval-realcorpus-gate.serial.test.ts. Serial (top-level mock-free but uses
 * the gateway test seam + module singletons; runs in its own process).
 *
 * WHAT THIS PROVES: the rescue MECHANISM — when keyword returns zero rows and the answer
 * exists, hybridSearchCached (the production fallback leg) surfaces it and the real
 * `search` op labels it match_type:'semantic'. WHAT IT DOES NOT: it does NOT measure what
 * fraction of the live 91% would be rescued. The 20 queries are a hand-authored fixture
 * (shared vocabulary with the ~30-doc corpus by design), so these recall numbers are a
 * mechanism demonstration on a ceiling-regime set, NOT a production magnitude. The rescue
 * floor below is the fallback-ELIGIBLE rate (empty-keyword only — the production fallback
 * fires ONLY on zero keyword rows, never on non-empty-but-irrelevant misses).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { readFileSync } from 'fs';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearchCached } from '../src/core/search/hybrid.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import {
  EMBEDDINGS_PATH,
  EVAL_EMBEDDING_DIMS,
  EVAL_EMBEDDING_MODEL,
  loadCorpus,
  loadQrels,
  type FrozenEmbeddings,
} from './fixtures/eval-realcorpus/loader.ts';

const K = 5;
const LIMIT = 10;

const frozen = JSON.parse(readFileSync(EMBEDDINGS_PATH, 'utf8')) as FrozenEmbeddings;
const corpus = loadCorpus();
const qrels = loadQrels();

// Frozen query-side vectors keyed by exact query TEXT (the embed transport keys on text).
const queryVecByText = new Map<string, Float32Array>();
for (const q of qrels) {
  const vec = frozen.queries[q.query_id];
  if (!vec) throw new Error(`fixture missing query embedding for ${q.query_id}`);
  queryVecByText.set(q.query, Float32Array.from(vec));
}

function titleFor(body: string, slug: string): string {
  const first = body.split('\n', 1)[0]?.trim() ?? '';
  return first.startsWith('# ') ? first.slice(2).trim() : (slug.split('/').pop() ?? slug);
}

let engine: PGLiteEngine;

beforeAll(async () => {
  configureGateway({
    embedding_model: EVAL_EMBEDDING_MODEL,
    embedding_dimensions: EVAL_EMBEDDING_DIMS,
    env: {
      ...process.env,
      ZEROENTROPY_API_KEY: process.env.ZEROENTROPY_API_KEY ?? 'sentinel-not-a-real-key',
    } as Record<string, string | undefined>,
  });
  __setEmbedTransportForTests(async ({ values }: { values: string[] }) => ({
    embeddings: values.map((text) => {
      const vec = queryVecByText.get(text);
      if (!vec) throw new Error(`[TECH-2743] no frozen query vector for: ${JSON.stringify(text)}`);
      return Array.from(vec);
    }),
  }) as any);

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const page of corpus) {
    const vec = frozen.documents[page.slug];
    if (!vec) throw new Error(`fixture missing document embedding for ${page.slug}`);
    await engine.putPage(page.slug, {
      type: page.type,
      title: titleFor(page.body, page.slug),
      compiled_truth: page.body,
      timeline: '',
    });
    await engine.upsertChunks(page.slug, [
      {
        chunk_index: 0,
        chunk_text: page.body,
        chunk_source: 'compiled_truth',
        embedding: Float32Array.from(vec),
        token_count: Math.ceil(page.body.length / 4),
      },
    ]);
  }
  // Deterministic, network-free ranking: reranker/expansion/graph-signals OFF.
  await engine.setConfig('search.mode', 'conservative');
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  if (engine) await engine.disconnect();
});

function hitsRelevant(results: Array<{ slug: string }>, relevant: string[], k = K): boolean {
  const rel = new Set(relevant);
  return results.slice(0, k).some((r) => rel.has(r.slug));
}

describe('TECH-2743 — keyword→semantic fallback rescues keyword misses (reconstructed replay)', () => {
  test('keyword misses a real share of labeled queries; semantic rescues the majority', async () => {
    const total = qrels.length;
    let kwHit = 0;       // keyword surfaces a relevant slug in top-K
    let kwEmpty = 0;     // keyword returns ZERO rows (the exact production fallback trigger)
    let kwMissNonEmpty = 0; // keyword returns rows but none relevant
    let semHit = 0;      // semantic surfaces a relevant slug in top-K
    let rescuedFromEmpty = 0;
    let rescuedFromMiss = 0;

    for (const q of qrels) {
      const kw = await engine.searchKeyword(q.query, { limit: LIMIT });
      const kwFindsRel = hitsRelevant(kw, q.relevant_slugs);
      if (kwFindsRel) kwHit++;
      if (kw.length === 0) kwEmpty++;
      else if (!kwFindsRel) kwMissNonEmpty++;

      const semantic = await hybridSearchCached(engine, q.query, { limit: LIMIT, onMeta: () => {} });
      const semFindsRel = hitsRelevant(semantic, q.relevant_slugs);
      if (semFindsRel) semHit++;
      if (kw.length === 0 && semFindsRel) rescuedFromEmpty++;
      if (kw.length > 0 && !kwFindsRel && semFindsRel) rescuedFromMiss++;
    }

    const kwRecall = kwHit / total;
    const semRecall = semHit / total;
    // The production fallback fires ONLY on zero keyword rows (keyword-fallback.ts), so the
    // fallback-ELIGIBLE rescue rate is rescuedFromEmpty / kwEmpty — NOT a conflated rate over
    // all misses (which would credit non-empty-irrelevant misses the real fallback can't touch).
    const emptyRescueRate = kwEmpty > 0 ? rescuedFromEmpty / kwEmpty : 0;

    // Evidence, echoed to the run log (the durable artifact alongside the assertions).
    console.log(`[TECH-2743] production anchor: 400/439 (91%) live keyword searches returned 0 rows (motivation, not a target).`);
    console.log(`[TECH-2743] reconstructed hand-authored set (labeled corpus): queries=${total}`);
    console.log(`[TECH-2743]   keyword recall@${K} = ${(kwRecall * 100).toFixed(0)}%  (hit ${kwHit}/${total})`);
    console.log(`[TECH-2743]   hybrid  recall@${K} = ${(semRecall * 100).toFixed(0)}%  (hit ${semHit}/${total})`);
    console.log(`[TECH-2743]   keyword returned ZERO rows on ${kwEmpty} queries (fallback-eligible); non-empty-irrelevant=${kwMissNonEmpty}`);
    console.log(`[TECH-2743]   semantic rescued ${rescuedFromEmpty}/${kwEmpty} fallback-eligible = ${(emptyRescueRate * 100).toFixed(0)}%`);

    // Mechanism guard (a ceiling-regime demonstration, not a production magnitude — see header):
    expect(kwEmpty, 'keyword must return ZERO rows on real labeled queries — the exact production fallback trigger').toBeGreaterThan(0);
    expect(semRecall, 'hybrid recall must exceed keyword recall on this set').toBeGreaterThan(kwRecall);
    expect(emptyRescueRate, 'semantic must rescue the fallback-ELIGIBLE (empty-keyword) misses').toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  test('end-to-end: the real `search` op with the knob ON returns NON-EMPTY rescued rows labeled semantic', async () => {
    // The measure test above uses hybridSearchCached directly; this drives the ACTUAL op
    // handler (operationsByName['search']) with search.keyword_semantic_fallback=1 on a query
    // that returns zero keyword rows, and asserts the rescue surfaces real content labeled
    // 'semantic' — the end-to-end path the unit + op-on-empty-brain tests don't cover.
    let emptyQuery: string | null = null;
    for (const q of qrels) {
      const kw = await engine.searchKeyword(q.query, { limit: LIMIT });
      if (kw.length === 0) { emptyQuery = q.query; break; }
    }
    expect(emptyQuery, 'fixture must contain at least one empty-keyword query').not.toBeNull();

    await engine.setConfig('search.keyword_semantic_fallback', '1');
    try {
      const op = operationsByName['search'];
      const ctx = {
        engine, remote: false, config: {}, logger: console, dryRun: false,
        auth: { clientName: 'kf-2743', sourceId: 'default' }, sourceId: 'default',
      } as unknown as OperationContext;
      const out = (await op.handler(ctx, { query: emptyQuery })) as Array<{ match_type?: string }>;
      // Keyword returned nothing, but the seeded corpus HAS the answer → the rescue is
      // non-empty AND every rescued row is labeled a semantic guess (not a keyword match).
      expect(out.length).toBeGreaterThan(0);
      expect(out.every((r) => r.match_type === 'semantic')).toBe(true);
    } finally {
      await engine.setConfig('search.keyword_semantic_fallback', '0');
    }
  }, 120_000);
});
