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

  test('abstention propagates through hybridSearchCached (miss-path finalMeta)', async () => {
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    let meta: HybridSearchMeta | null = null;
    const results = await hybridSearchCached(engine, 'loyalty', {
      reranker: rerankOn(0.1),
      onMeta: (m) => { meta = m; },
    });
    expect(meta?.abstained).toBe(true);
    expect(meta?.abstain_reason).toBe('below_confidence_threshold');
    expect(results.length).toBe(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });
});
