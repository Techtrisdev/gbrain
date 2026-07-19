/**
 * TECH-2743 — reconstructed empty-keyword → semantic rescue evidence.
 *
 * PRODUCTION ANCHOR (retrieval_events, 2026-07): 400 of 439 keyword `search` calls
 * returned ZERO results — a 91% keyword-miss rate, almost entirely from read-only agents
 * (codex-readonly, simon-hermes) issuing conceptual `general`-intent queries. The raw
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
import { applyKeywordSemanticFallback } from '../src/core/search/keyword-fallback.ts';
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

      // Prove the PRODUCTION fallback helper (TECH-2739) does exactly this on an empty
      // keyword result: it fires and labels the rescued rows 'semantic'.
      if (kw.length === 0) {
        const fb = await applyKeywordSemanticFallback(kw, true, async () => semantic);
        expect(fb.fallback_fired).toBe(true);
        expect(fb.results.every((r) => (r as { match_type?: string }).match_type === 'semantic')).toBe(true);
      }
    }

    const kwRecall = kwHit / total;
    const semRecall = semHit / total;
    const keywordMisses = kwEmpty + kwMissNonEmpty;
    const rescued = rescuedFromEmpty + rescuedFromMiss;
    const rescueRate = keywordMisses > 0 ? rescued / keywordMisses : 0;

    // Evidence, echoed to the run log (the durable artifact alongside the assertions).
    console.log(`[TECH-2743] production anchor: 400/439 (91%) live keyword searches returned 0 results.`);
    console.log(`[TECH-2743] reconstructed set (labeled corpus): queries=${total}`);
    console.log(`[TECH-2743]   keyword  recall@${K} = ${(kwRecall * 100).toFixed(0)}%  (hit ${kwHit}/${total})`);
    console.log(`[TECH-2743]   semantic recall@${K} = ${(semRecall * 100).toFixed(0)}%  (hit ${semHit}/${total})`);
    console.log(`[TECH-2743]   keyword misses = ${keywordMisses} (empty=${kwEmpty}, non-empty-irrelevant=${kwMissNonEmpty})`);
    console.log(`[TECH-2743]   semantic rescued ${rescued}/${keywordMisses} misses = ${(rescueRate * 100).toFixed(0)}% rescue rate`);

    // The reconstructed corpus reproduces the production pattern: keyword fails on a real
    // share of queries, and the guarded semantic fallback recovers the majority.
    expect(keywordMisses, 'keyword must miss real labeled queries (else nothing to rescue)').toBeGreaterThan(0);
    expect(semRecall, 'semantic recall must exceed keyword recall').toBeGreaterThan(kwRecall);
    expect(rescueRate, 'semantic must rescue a majority of keyword misses').toBeGreaterThanOrEqual(0.6);
  }, 120_000);
});
