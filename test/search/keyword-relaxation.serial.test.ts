/**
 * Keyword-leg graceful relaxation (v0.45).
 *
 * `websearch_to_tsquery` is all-or-nothing AND: a single query word absent from
 * the WHOLE corpus (e.g. "production") zeros the entire keyword leg, collapsing
 * the hybrid query to vector-only and into query-space hub noise — where a weak
 * vector-match canonical page never reaches the reranker. On a zero-row keyword
 * leg, hybridSearch retries ANDing the query's DISTINCTIVE tokens so the canonical
 * page still surfaces lexically. See gbrain-entity-vs-topic-ranking-defect.
 *
 * SERIAL: configureGateway + __setEmbedTransportForTests mutate the process-global
 * gateway singleton.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, hybridSearchCached } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import type { PageInput, HybridSearchMeta } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const DIMS = 1536;
// Query embeds to basis dim 0; the answer page embeds ORTHOGONAL to it (basis dim
// 1), so the VECTOR leg cannot surface it — it can only arrive via the keyword leg.
const QUERY_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0));
function emb(dim: number): Float32Array { const v = new Float32Array(DIMS); v[dim] = 1; return v; }

const ANSWER = 'projects/widget-mirror';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // The answer page: contains the distinctive entity tokens "Widget Mirror" + the
  // content word "capture", but NOT "production". Embedded orthogonal to the query.
  await engine.putPage(ANSWER, { type: 'project', title: 'Widget Mirror', compiled_truth: 'Widget Mirror capture is live and running.' } as PageInput);
  await engine.upsertChunks(ANSWER, [{ chunk_index: 0, chunk_text: 'Widget Mirror capture is live and running in the internal pipeline.', chunk_source: 'compiled_truth', embedding: emb(1) }]);
  // A couple of decoys so the corpus isn't trivial; none contain "production".
  for (const [slug, text] of [['playbooks/notes', 'general notes about capture pipelines and status'], ['decisions/misc', 'a decision about the status of things']] as const) {
    await engine.putPage(slug, { type: slug.startsWith('play') ? 'playbook' : 'decision', title: slug, compiled_truth: text } as PageInput);
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', embedding: emb(2) }]);
  }
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => QUERY_EMB) }) as any);
});

afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });

async function run(query: string): Promise<{ meta: HybridSearchMeta | null; slugs: string[] }> {
  let meta: HybridSearchMeta | null = null;
  // Reranker off: isolate the RECALL effect (does the page reach the result set at
  // all), which is what the relaxation fixes — not rerank ordering.
  const results = await hybridSearch(engine, query, { reranker: { enabled: false, topNIn: 30, topNOut: null }, onMeta: (m) => { meta = m; } }) as Array<{ slug?: string }>;
  return { meta, slugs: results.map((r) => r.slug ?? '') };
}

describe('keyword-leg graceful relaxation', () => {
  test('a corpus-absent query word no longer zeros the keyword leg — the distinctive-token page still surfaces', async () => {
    // "production" is in NO chunk → strict websearch AND returns zero → pre-fix this
    // ran vector-only, and the orthogonally-embedded answer never appeared. With
    // relaxation, the distinctive tokens {widget, mirror} match the answer.
    const { meta, slugs } = await run('current Widget Mirror production capture status');
    expect((meta as HybridSearchMeta | null)?.keyword_relaxed).toBe(true);
    expect(slugs).toContain(ANSWER);
  });

  test('a query whose strict keyword leg already matches does NOT relax (relaxation only adds recall)', async () => {
    // Every word present → strict AND matches → no relaxation, keyword_relaxed unset.
    const { meta, slugs } = await run('Widget Mirror capture');
    expect((meta as HybridSearchMeta | null)?.keyword_relaxed).toBeUndefined();
    expect(slugs).toContain(ANSWER);
  });

  test('a query with no distinctive tokens does not relax (nothing to relax to)', async () => {
    // All-lowercase common words, no entity tokens → distinctiveTokens empty →
    // stays vector-only (correctly); no spurious relaxation.
    const { meta } = await run('production status of the pipeline');
    expect((meta as HybridSearchMeta | null)?.keyword_relaxed).toBeUndefined();
  });

  test('keyword_relaxed survives the hybridSearchCached wrapper (the production query path)', async () => {
    // The query/search ops route through hybridSearchCached, whose meta is
    // RECONSTRUCTED field-by-field — a bare-emit-only flag is silently dropped
    // there (the PR #76 wrapper-meta gap). Assert the flag survives the miss-path
    // reconstruction so relaxation firing-rate is observable on real traffic.
    let meta: HybridSearchMeta | null = null;
    await hybridSearchCached(engine, 'current Widget Mirror production capture status', {
      reranker: { enabled: false, topNIn: 30, topNOut: null },
      onMeta: (m) => { meta = m; },
    });
    expect((meta as HybridSearchMeta | null)?.keyword_relaxed).toBe(true);
  });

  test('relaxed on-topic-but-unhelpful candidates are FLOORED, not served as a confident answer (the safety claim)', async () => {
    // adv-1 guard: relaxation ADDS on-topic candidates to the reranker pool. When
    // NONE of them actually answers (reranker scores all below the floor), the
    // abstain floor must reject them — relaxation must not manufacture a confident
    // wrong answer. Reranker stub scores every candidate 0.1; floor 0.5.
    const rerankAllLow = {
      enabled: true, topNIn: 30, topNOut: null,
      rerankerFn: async (input: RerankInput): Promise<RerankResult[]> =>
        input.documents.map((_, i) => ({ index: i, relevanceScore: 0.1 })),
    };
    await engine.setConfig('search.rerank_abstain_floor', '0.5');
    let meta: HybridSearchMeta | null = null;
    const results = await hybridSearch(engine, 'current Widget Mirror production capture status', {
      reranker: rerankAllLow, onMeta: (m) => { meta = m; },
    }) as unknown[];
    // Relaxation fired (surfaced Widget Mirror candidates) but the floor abstains.
    expect((meta as HybridSearchMeta | null)?.keyword_relaxed).toBe(true);
    expect((meta as HybridSearchMeta | null)?.abstained).toBe(true);
    expect(results.length).toBe(0);
    await engine.unsetConfig('search.rerank_abstain_floor');
  });
});
