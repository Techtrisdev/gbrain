/**
 * v0.40.x — Option A validation harness: post-rerank process reorder through
 * hybridSearch WITH the reranker ENABLED (stubbed rerankerFn reproducing the
 * defect). This is the test the prior pre-rerank boost could not pass — it proves
 * the reorder changes the FINAL (post-reranker) order, not a washed-out RRF score.
 *
 * Proves:
 *   - reorder OFF → reranker leaves the person result ABOVE the playbook (defect);
 *   - process query + reorder ON → playbook ranks above the person result;
 *   - "who is Simon" → person stays #1 (not a process query → no reorder);
 *   - "how does Simon work" → person NOT demoted (structural entity guard suppresses);
 *   - mixed process+person query → entity result not regressed.
 *
 * Both chunks share the query keywords (promotion/process/work/simon) so every query
 * returns both pages; distinct rerank markers let the stub order them deterministically.
 * Reranker stubbed via opts.reranker.rerankerFn; embeddings stubbed — no API keys.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch, type HybridSearchOpts } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { PageInput, SearchResult } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));
function stubEmbeddings(): void {
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => FAKE_EMB),
  }) as any);
}

// rerankerFn that REPRODUCES the defect: returns the head ordered person FIRST, then
// playbook — i.e. the cross-encoder ranks the person result above the how-to doc (the
// exact prod failure the reorder must correct). Identifies docs by their markers.
const defectReranker = async (input: RerankInput): Promise<RerankResult[]> => {
  const docs = input.documents;
  const personIdx = docs.findIndex(d => d.includes('SIMON_TIMELINE'));
  const playbookIdx = docs.findIndex(d => d.includes('PROMOTION_PLAYBOOK'));
  const order: number[] = [];
  if (personIdx >= 0) order.push(personIdx);
  if (playbookIdx >= 0) order.push(playbookIdx);
  for (let i = 0; i < docs.length; i++) if (i !== personIdx && i !== playbookIdx) order.push(i);
  return order.map((idx, rankPos) => ({ index: idx, relevanceScore: 1 - rankPos * 0.05 }));
};

const rerankerOpts = { enabled: true, topNIn: 30, topNOut: null, rerankerFn: defectReranker };
const isSimon = (r: SearchResult) => r.slug === 'people/simon';
const isPlaybook = (r: SearchResult) => r.slug === 'playbooks/retention-promotion';
const rankOf = (out: SearchResult[], pred: (r: SearchResult) => boolean) => out.findIndex(pred);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Both chunks carry promotion/process/work/simon → every test query returns both
  // pages. Distinct markers (SIMON_TIMELINE / PROMOTION_PLAYBOOK) drive the stub.
  const pages: Array<[string, PageInput, string]> = [
    ['people/simon',
      { type: 'note', title: 'Simon', compiled_truth: 'Simon profile', timeline: '', frontmatter: {} },
      'promotion process work simon person SIMON_TIMELINE'],
    ['playbooks/retention-promotion',
      { type: 'note', title: 'Retention Promotion Playbook', compiled_truth: 'how retention gets promoted', timeline: '', frontmatter: {} },
      'promotion process work simon howto PROMOTION_PLAYBOOK'],
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

describe('post-rerank process reorder (Option A)', () => {
  test('DEFECT — reorder OFF: reranker leaves the person result ABOVE the playbook', async () => {
    const opts: HybridSearchOpts = { limit: 10, reranker: rerankerOpts };
    const out = await hybridSearch(engine, 'how does promotion work', opts);
    expect(rankOf(out, isSimon)).toBeGreaterThanOrEqual(0);
    expect(rankOf(out, isPlaybook)).toBeGreaterThanOrEqual(0);
    expect(rankOf(out, isSimon)).toBeLessThan(rankOf(out, isPlaybook)); // the defect
  });

  test('FIX — reorder ON: process query ranks the playbook ABOVE the person result', async () => {
    const opts: HybridSearchOpts = { limit: 10, process_reorder_enabled: true, reranker: rerankerOpts };
    const out = await hybridSearch(engine, 'how does promotion work', opts);
    expect(rankOf(out, isPlaybook)).toBeLessThan(rankOf(out, isSimon)); // playbook now wins
  });

  test('ENTITY — "who is Simon" keeps the person result #1 (not a process query)', async () => {
    const opts: HybridSearchOpts = { limit: 10, process_reorder_enabled: true, reranker: rerankerOpts };
    const out = await hybridSearch(engine, 'who is Simon', opts);
    expect(rankOf(out, isSimon)).toBe(0);
  });

  test('GUARD — "how does Simon work" does NOT demote the person (structural entity guard)', async () => {
    const opts: HybridSearchOpts = { limit: 10, process_reorder_enabled: true, reranker: rerankerOpts };
    const out = await hybridSearch(engine, 'how does Simon work', opts);
    // Playbook IS in the pool (it shares the keywords) but is NOT promoted: the guard
    // suppressed the reorder, so the person keeps the reranker's #1 slot.
    expect(rankOf(out, isSimon)).toBe(0);
    expect(rankOf(out, isSimon)).toBeLessThan(rankOf(out, isPlaybook));
  });

  test('MIXED — "how does the promotion process work for Simon" does NOT regress the entity', async () => {
    const opts: HybridSearchOpts = { limit: 10, process_reorder_enabled: true, reranker: rerankerOpts };
    const out = await hybridSearch(engine, 'how does the promotion process work for Simon', opts);
    expect(rankOf(out, isSimon)).toBe(0); // entity guard → no regression
  });
});
