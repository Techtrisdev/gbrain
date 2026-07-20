/**
 * Answerability guard gate (v0.43) — integration through hybridSearch.
 *
 * SERIAL: configureGateway + __setEmbedTransportForTests mutate the process-global
 * gateway singleton. The judge is stubbed via opts.answerabilityJudgeFn (no LLM
 * call). Asserts the tri-state contract (off/shadow/enforce), the band-gate
 * (above + below), fail-open, reranker-off, and the two false-abstain safety
 * exemptions: known-entity queries and image modality are never judged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { _resetAnswerabilityCacheForTest } from '../../src/core/search/answerability.ts';
import type { PageInput, HybridSearchMeta } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));
function stubEmbeddings(): void {
  __setEmbedTransportForTests(async (args: any) => ({ embeddings: args.values.map(() => FAKE_EMB) }) as any);
}
// Reranker stub that puts every candidate at a fixed score → controls the band.
const rerankAt = (score: number) => ({
  enabled: true, topNIn: 30, topNOut: null,
  rerankerFn: async (input: RerankInput): Promise<RerankResult[]> =>
    input.documents.map((_, i) => ({ index: i, relevanceScore: score })),
});

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // Non-entity conceptual pages sharing a token so a candidate pool forms. Titles
  // are NOT people/companies/deals, so referencesKnownEntity returns false.
  const pages: Array<[string, PageInput, string]> = [
    ['playbooks/governance', { type: 'playbook', title: 'Governance rules', compiled_truth: 'governance approval process' }, 'governance approval process for changes'],
    ['playbooks/notes', { type: 'playbook', title: 'General notes', compiled_truth: 'general process notes' }, 'general process notes and context'],
    // A companies/ page so referencesKnownEntity matches "Widgetco" → entity query.
    ['companies/widgetco', { type: 'company', title: 'Widgetco', compiled_truth: 'Widgetco governance approval process' }, 'widgetco governance approval process notes'],
  ];
  for (const [slug, page, chunk] of pages) {
    await engine.putPage(slug, page);
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: chunk, chunk_source: 'compiled_truth' }]);
  }
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  stubEmbeddings();
});
afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });

async function run(query: string, opts: Parameters<typeof hybridSearch>[2] = {}): Promise<{ meta: HybridSearchMeta | null; results: unknown[] }> {
  _resetAnswerabilityCacheForTest();
  let meta: HybridSearchMeta | null = null;
  const results = await hybridSearch(engine, query, { ...opts, onMeta: (m) => { meta = m; } });
  return { meta, results };
}

const yes = async () => 'YES';
const no = async () => 'NO';

describe('answerability guard gate', () => {
  test("off: guard is inert (no outcome emitted) even with a NO judge", async () => {
    await engine.setConfig('search.answerability_guard', 'off');
    const { meta, results } = await run('governance process', { reranker: rerankAt(0.7), answerabilityJudgeFn: no });
    expect(meta?.answerability_outcome).toBeUndefined();
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.answerability_guard');
  });

  test('shadow + NO: judges + logs would_abstain but SERVES NORMALLY (never abstains)', async () => {
    await engine.setConfig('search.answerability_guard', 'shadow');
    const { meta, results } = await run('governance process', { reranker: rerankAt(0.7), answerabilityJudgeFn: no });
    expect(meta?.answerability_outcome).toBe('not_answered');
    expect(meta?.answerability_would_abstain).toBe(true);
    expect(meta?.abstained).toBe(false);        // shadow does NOT change the result set
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.answerability_guard');
  });

  test('enforce + NO: abstains with abstain_reason not_answerable', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    const { meta, results } = await run('governance process', { reranker: rerankAt(0.7), answerabilityJudgeFn: no });
    expect(meta?.answerability_outcome).toBe('not_answered');
    expect(meta?.abstained).toBe(true);
    expect(meta?.abstain_reason).toBe('not_answerable');
    expect(results.length).toBe(0);
    await engine.unsetConfig('search.answerability_guard');
  });

  test('enforce + YES: serves normally (judge confirms the answer)', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    const { meta, results } = await run('governance process', { reranker: rerankAt(0.7), answerabilityJudgeFn: yes });
    expect(meta?.answerability_outcome).toBe('answered');
    expect(meta?.abstained).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.answerability_guard');
  });

  test('band-gate: a top score ABOVE the band (trusted) is not judged', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    const { meta } = await run('governance process', { reranker: rerankAt(0.95), answerabilityJudgeFn: no });
    expect(meta?.answerability_outcome).toBeUndefined(); // 0.95 > 0.85 hi → skipped
    await engine.unsetConfig('search.answerability_guard');
  });

  test('band-gate: a top score BELOW the band (floor territory) is not judged', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    const { meta } = await run('governance process', { reranker: rerankAt(0.3), answerabilityJudgeFn: no });
    expect(meta?.answerability_outcome).toBeUndefined(); // 0.3 < 0.5 lo → skipped
    await engine.unsetConfig('search.answerability_guard');
  });

  test('fail-open: a judge that errors serves normally, never abstains', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    const { meta, results } = await run('governance process', {
      reranker: rerankAt(0.7),
      answerabilityJudgeFn: async () => { throw new Error('gateway down'); },
    });
    expect(meta?.answerability_outcome).toBe('error');
    expect(meta?.abstained).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.answerability_guard');
  });

  test('reranker off: guard never runs (no rerank score to band-gate on)', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    const { meta } = await run('governance process', {
      reranker: { enabled: false, topNIn: 30, topNOut: null },
      answerabilityJudgeFn: no,
    });
    expect(meta?.answerability_outcome).toBeUndefined();
    await engine.unsetConfig('search.answerability_guard');
  });

  test('known-entity query is EXEMPT (never judged — reranker strength, false-abstain exposure)', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    // "Widgetco" matches companies/widgetco title → referencesKnownEntity true → skip.
    const { meta, results } = await run('Widgetco governance', { reranker: rerankAt(0.7), answerabilityJudgeFn: no });
    expect(meta?.answerability_outcome).toBeUndefined();
    expect(meta?.abstained).toBe(false);
    expect(results.length).toBeGreaterThan(0);
    await engine.unsetConfig('search.answerability_guard');
  });

  test('non-text modality is EXEMPT (the judge/reranker are text-only, mirror the floor)', async () => {
    await engine.setConfig('search.answerability_guard', 'enforce');
    // crossModal 'both' → effectiveModality != 'text' → abstainModalityOk false → skip.
    const { meta } = await run('governance process', { reranker: rerankAt(0.7), answerabilityJudgeFn: no, crossModal: 'both' });
    expect(meta?.answerability_outcome).toBeUndefined();
    await engine.unsetConfig('search.answerability_guard');
  });
});
