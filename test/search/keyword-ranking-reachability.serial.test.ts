/**
 * BM25 PR1 — reachability of the `search.keyword_ranking` knob through the TWO
 * production retrieval paths (adv-1).
 *
 * The engine-direct keyword-ranking.serial suite proves the or_idf SQL is
 * CORRECT, but a green engine suite says NOTHING about whether flipping the
 * `search.keyword_ranking` config actually REACHES the engine. Both live paths
 * build their own SearchOpts:
 *   - hybrid 'query'  → hybrid.ts rebuilds SearchOpts as an EXPLICIT allowlist
 *     (a field not added there is silently dropped before engine.searchKeyword).
 *   - op    'search'  → operations.ts builds opts inline for the keyword-only tool.
 * If either drops keyword_ranking, flipping the config is a silent no-op that only
 * cold-starts the query cache (the knob still folds into knobsHash). These tests
 * would FAIL before the threading fix and pin it against regression — they are the
 * coverage the direct-engine suite structurally cannot provide.
 *
 * SERIAL: mutates engine DB-plane config (search.keyword_ranking) and monkeypatches
 * engine.searchKeyword to spy the threaded opt — must own its bun process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { PageInput, SearchOpts, SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

// 'zorplex' is a rare entity present in ONE page; 'production' appears NOWHERE in
// the corpus. Query 'zorplex production' trips the boolean-AND zero-row cliff under
// legacy 'and' (→ keyword empty), but survives under or_idf (ranked-OR).
const ZORPLEX = 'projects/zorplex';

async function seedCorpus(e: PGLiteEngine): Promise<void> {
  await e.putPage(ZORPLEX, { type: 'project', title: 'Zorplex', compiled_truth: 'Zorplex techtris capture status' } as PageInput);
  await e.upsertChunks(ZORPLEX, [{ chunk_index: 0, chunk_text: 'zorplex techtris capture status', chunk_source: 'compiled_truth' } as any]);
  for (const [slug, text] of [
    ['integrations/toast', 'techtris capture event stream'],
    ['clients/acme', 'techtris capture client onboarding'],
  ] as const) {
    await e.putPage(slug, { type: 'integration', title: slug, compiled_truth: text } as PageInput);
    await e.upsertChunks(slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth' } as any]);
  }
}

// Record the keyword_ranking each engine.searchKeyword call receives, delegating
// to the real impl. Proves the resolved knob crossed the SearchOpts rebuild.
function spyKeywordRanking(e: PGLiteEngine): { seen: Array<string | undefined>; restore: () => void } {
  const seen: Array<string | undefined> = [];
  const orig = e.searchKeyword.bind(e);
  (e as unknown as { searchKeyword: PGLiteEngine['searchKeyword'] }).searchKeyword = ((q: string, opts?: SearchOpts) => {
    seen.push(opts?.keyword_ranking);
    return orig(q, opts);
  }) as PGLiteEngine['searchKeyword'];
  return { seen, restore: () => { (e as unknown as { searchKeyword: PGLiteEngine['searchKeyword'] }).searchKeyword = orig; } };
}

function opCtx(): OperationContext {
  return {
    engine,
    remote: false,
    config: {},
    logger: console,
    dryRun: false,
    auth: { clientName: 'kwr-op', sourceId: 'default' },
    sourceId: 'default',
  } as unknown as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedCorpus(engine);
  await engine.refreshCorpusTermStats('default');
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  // Baseline each case at the legacy default so a prior case can't leak state.
  await engine.setConfig('search.keyword_ranking', 'and');
});

describe('keyword_ranking reachability through production paths (adv-1)', () => {
  // (adv-1a) hybrid 'query' path: the resolved knob must survive the SearchOpts
  // allowlist-rebuild and reach engine.searchKeyword.
  test("hybrid 'query': config or_idf THREADS to engine.searchKeyword + kills the cliff", async () => {
    await engine.setConfig('search.keyword_ranking', 'or_idf');
    const spy = spyKeywordRanking(engine);
    try {
      const rows: SearchResult[] = await hybridSearch(engine, 'zorplex production', { sourceId: 'default', limit: 5 });
      // Threading proof: EVERY searchKeyword call in this request saw 'or_idf'
      // (before the fix the rebuild dropped the field → undefined → legacy).
      expect(spy.seen.length).toBeGreaterThan(0);
      expect(spy.seen.every((v) => v === 'or_idf')).toBe(true);
      // End-to-end: no gateway ⇒ empty vector leg ⇒ the or_idf keyword leg drives
      // the result; the cliff query still surfaces the rare-entity page.
      expect(rows.map((r) => r.slug)).toContain(ZORPLEX);
    } finally {
      spy.restore();
    }
  });

  test("hybrid 'query': default 'and' reaches the engine as 'and' (legacy cliff holds)", async () => {
    await engine.setConfig('search.keyword_ranking', 'and');
    const spy = spyKeywordRanking(engine);
    try {
      const rows = await hybridSearch(engine, 'zorplex production', { sourceId: 'default', limit: 5 });
      expect(spy.seen.length).toBeGreaterThan(0);
      expect(spy.seen.every((v) => v === 'and')).toBe(true);
      // 'and' cliff: 'production' corpus-absent → keyword zero; empty vector leg →
      // page NOT surfaced. The two configs demonstrably diverge through ONE path.
      expect(rows.map((r) => r.slug)).not.toContain(ZORPLEX);
    } finally {
      spy.restore();
    }
  });

  // (adv-1b) op 'search' path: the keyword-only tool (JARVIS's dominant path) must
  // also honor the knob — it builds opts inline, not via the mode bundle.
  test("op 'search': config or_idf surfaces the cliff query; 'and' returns it empty", async () => {
    const op = operationsByName['search'];

    await engine.setConfig('search.keyword_ranking', 'and');
    const andRows = (await op.handler(opCtx(), { query: 'zorplex production' })) as SearchResult[];
    // keyword_semantic_fallback is unset (off) → no rescue → true keyword miss.
    expect(andRows.map((r) => r.slug)).not.toContain(ZORPLEX);

    await engine.setConfig('search.keyword_ranking', 'or_idf');
    const orRows = (await op.handler(opCtx(), { query: 'zorplex production' })) as SearchResult[];
    expect(orRows.map((r) => r.slug)).toContain(ZORPLEX);
  });
});
