/**
 * Rerank-abstention gate (v0.41).
 *
 * When search.rerank_abstain_floor is set and the reranker ran but NO candidate
 * cleared the floor, hybridSearch returns no answer (empty list) and marks the
 * meta abstained:true — the Brain refusing to serve confident hub-noise for a
 * query nothing in the corpus actually answers. See the JARVIS/TARS contract in
 * the gbrain-entity-vs-topic-ranking-defect notes.
 *
 * SERIAL: configureGateway + __setEmbedTransportForTests mutate the process-
 * global gateway singleton, which leaks across a parallel shard. This file gets
 * its own bun process via run-serial-tests.
 *
 * The embed transport is stubbed (no network) so hybridSearch takes the main RRF
 * path and reaches applyReranker — the keyword-only fallback early-returns before
 * the reranker, so a keyword-only setup would never exercise the gate. The
 * reranker itself is stubbed via opts.reranker.rerankerFn to assign the exact
 * scores that drive the gate. The floor is set through engine config so the full
 * loadSearchModeConfig → resolveSearchMode → gate path runs.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, hybridSearchCached } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { PageInput, HybridSearchMeta } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));

function stubEmbeddings(): void {
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => FAKE_EMB),
  }) as any);
}

// Assign every candidate the same rerank score, so a single knob controls
// whether the whole set is above or below the floor.
const rerankOn = (score: number) => ({
  enabled: true,
  topNIn: 30,
  topNOut: null,
  rerankerFn: async (input: RerankInput): Promise<RerankResult[]> =>
    input.documents.map((_, i) => ({ index: i, relevanceScore: score })),
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // upsertChunks so keyword search has rows; a shared token ('loyalty') yields a
  // multi-candidate pool for the reranker to score.
  const pages: Array<[string, PageInput, string]> = [
    ['clients/acme', { type: 'client', title: 'Acme Corp', compiled_truth: 'Acme loyalty integration' }, 'acme loyalty integration delivery partner'],
    ['integrations/loyalty-x', { type: 'integration', title: 'Loyalty X', compiled_truth: 'Loyalty X integration' }, 'loyalty x integration used by acme'],
    ['playbooks/loyalty-notes', { type: 'playbook', title: 'Loyalty notes', compiled_truth: 'loyalty notes' }, 'general loyalty and delivery notes'],
  ];
  for (const [slug, page, chunkText] of pages) {
    await engine.putPage(slug, page);
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' }]);
  }
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  stubEmbeddings();
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

async function metaFor(query: string, opts: Parameters<typeof hybridSearch>[2] = {}): Promise<{ meta: HybridSearchMeta | null; results: unknown[] }> {
  let meta: HybridSearchMeta | null = null;
  const results = await hybridSearch(engine, query, { ...opts, onMeta: (m) => { meta = m; } });
  return { meta, results };
}

describe('rerank-abstention gate', () => {
  test('abstains when every candidate is below the floor', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    const { meta, results } = await metaFor('loyalty', { reranker: rerankOn(0.1) });
    expect(meta?.abstained).toBe(true);
    expect(meta?.abstain_reason).toBe('below_confidence_threshold');
    expect(meta?.candidate_count ?? 0).toBeGreaterThan(0);
    // Abstention returns NO answer, not the weak candidates.
    expect(results.length).toBe(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('does NOT abstain when a candidate clears the floor', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    const { meta, results } = await metaFor('loyalty', { reranker: rerankOn(0.9) });
    expect(meta?.abstained).toBe(false);
    expect(meta?.abstain_reason).toBeUndefined();
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('an empty candidate set is NOT abstention (TARS: empty list alone never sets abstained)', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    // A token matching no page → zero candidates → the reranker sees nothing →
    // no rerank signal exists, so the gate must NOT read the empty result as
    // "no confident answer". This is a genuine no-match, a distinct outcome.
    const { meta, results } = await metaFor('zzznomatchtoken', { reranker: rerankOn(0.9) });
    expect(results.length).toBe(0);
    expect(meta?.abstained).toBe(false);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('never abstains when the reranker is disabled (no rerank signal to gate on)', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    const { meta, results } = await metaFor('loyalty', { reranker: { enabled: false, topNIn: 30, topNOut: null } });
    expect(meta?.abstained).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('never abstains when the floor is unset (default OFF), even with low scores', async () => {
    const { meta, results } = await metaFor('loyalty', { reranker: rerankOn(0.01) });
    expect(meta?.abstained).toBe(false);
    expect(results.length).toBeGreaterThan(0);
  });

  test('fail-open reranker (throws → no scores) does NOT abstain', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    // applyReranker returns the input unmodified on any error → no rerank_score
    // on any item → the gate has no signal and must fall through to results,
    // NOT read the absence of a signal as "no confident answer".
    const throwingReranker = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async (): Promise<RerankResult[]> => { throw new Error('reranker down'); },
    };
    const { meta, results } = await metaFor('loyalty', { reranker: throwingReranker });
    expect(meta?.abstained).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('a score exactly at the floor passes (boundary: < floor, not <=)', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    const { meta, results } = await metaFor('loyalty', { reranker: rerankOn(0.5) });
    expect(meta?.abstained).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('abstentions are NOT written to cache (writeback requires results.length>0)', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    // First call abstains (empty) — must not be cached. A second identical call
    // re-runs the pipeline (cache miss again), not served an abstained [] from
    // cache. We assert the second call still abstains via a fresh evaluation:
    // if the empty had been cached AS a plain no-result, abstained could be lost.
    let firstMeta: HybridSearchMeta | null = null;
    await hybridSearchCached(engine, 'loyalty', { reranker: rerankOn(0.1), onMeta: (m) => { firstMeta = m; } });
    expect((firstMeta as HybridSearchMeta | null)?.abstained).toBe(true);
    expect((firstMeta as HybridSearchMeta | null)?.cache?.status).not.toBe('hit');

    let secondMeta: HybridSearchMeta | null = null;
    await hybridSearchCached(engine, 'loyalty', { reranker: rerankOn(0.1), onMeta: (m) => { secondMeta = m; } });
    // Not served from cache (an abstained [] was never stored), and it still
    // carries the abstention flag from a fresh evaluation.
    expect((secondMeta as HybridSearchMeta | null)?.cache?.status).not.toBe('hit');
    expect((secondMeta as HybridSearchMeta | null)?.abstained).toBe(true);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('abstention propagates through hybridSearchCached (miss-path finalMeta)', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    let captured: HybridSearchMeta | null = null;
    const results = await hybridSearchCached(engine, 'loyalty', {
      reranker: rerankOn(0.1),
      onMeta: (m) => { captured = m; },
    });
    const meta = captured as HybridSearchMeta | null;
    expect(meta?.abstained).toBe(true);
    expect(meta?.abstain_reason).toBe('below_confidence_threshold');
    expect(results.length).toBe(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });
});

// v0.42 — recall-health signal (degraded-mode honesty, T9). vector_result_count
// makes a degraded-recall abstention (vector recall returned nothing / a short
// list — e.g. an HNSW cold/under-load miss) DISTINGUISHABLE from a genuine
// no-answer, instead of both looking identical (`vector_enabled:true`,
// `abstained:true`). Without this, a transient recall miss silently withholds an
// answer the Brain has, indistinguishable from "the Brain has nothing".
describe('recall-health signal (vector_result_count)', () => {
  test('degraded recall (vector returned nothing) stamps vector_result_count=0 on the abstention', async () => {
    // Harness chunks have NULL embeddings → searchVector returns [] → the classic
    // silent-abstain surface: vector contributed nothing, keyword candidates all
    // rerank below the floor, and the abstention would otherwise look identical to
    // a healthy one. The 0 count is the fingerprint that flags it.
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    const { meta } = await metaFor('loyalty', { reranker: rerankOn(0.1) });
    expect(meta?.abstained).toBe(true);
    expect(meta?.vector_result_count).toBe(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });

  test('healthy vector recall stamps vector_result_count > 0', async () => {
    // Force searchVector to return a non-empty neighbor list (simulating healthy
    // recall) so the count reflects real recall, not the NULL-embedding artifact.
    const orig = (engine as any).searchVector.bind(engine);
    (engine as any).searchVector = async () => ([
      { slug: 'clients/acme', page_id: 1, title: 'Acme Corp', type: 'client', score: 0.9, chunk_text: 'acme loyalty', chunk_source: 'compiled_truth', source_id: 'default' },
      { slug: 'integrations/loyalty-x', page_id: 2, title: 'Loyalty X', type: 'integration', score: 0.8, chunk_text: 'loyalty x', chunk_source: 'compiled_truth', source_id: 'default' },
    ] as any);
    try {
      await engine.setConfig('search.rerank_abstain_floor', '0.5');
      // rerankOn(0.9) → clears the floor → not abstained, but the count is still stamped.
      const { meta } = await metaFor('loyalty', { reranker: rerankOn(0.9) });
      expect(meta?.abstained).toBe(false);
      expect((meta?.vector_result_count ?? 0)).toBeGreaterThan(0);
      await engine.unsetConfig('search.rerank_abstain_floor');
    } finally {
      (engine as any).searchVector = orig;
    }
  });

  test('a THROWING vector/embed failure takes the keyword-only path (vector_enabled=false), never abstains', async () => {
    // The other degraded surface: a THROWN embed/vector failure is caught and
    // downgraded to a SIGNALED keyword-only answer (vector_enabled:false), which
    // returns BEFORE the abstain gate — so it must never abstain (a silent
    // withhold), it returns whatever keyword found.
    __setEmbedTransportForTests(async () => { throw new Error('embed gateway down'); });
    try {
      await engine.setConfig('search.rerank_abstain_floor', '0.5');
      const { meta, results } = await metaFor('loyalty', { reranker: rerankOn(0.1) });
      expect(meta?.vector_enabled).toBe(false);
      expect(meta?.abstained).not.toBe(true);
      expect(results.length).toBeGreaterThan(0); // keyword results served, not withheld
      await engine.unsetConfig('search.rerank_abstain_floor');
    } finally {
      stubEmbeddings();
    }
  });
});
