/**
 * v0.46 — fail-open degradation is REPORTED, not silent.
 *
 * Every stage covered here was previously an empty `catch {}` whose comment said
 * "non-fatal". Fail-open is correct: search must still answer when a boost stage
 * errors. The defect was that it failed open *silently*, so a ranking missing a
 * boost was byte-identical to a healthy one and nobody could learn the stage was
 * broken. gbrain already solved this class at v0.42 for the reranker
 * (`_meta.reranker_failed`); these tests pin the same contract for the stages that
 * wave did not reach.
 *
 * Two properties per stage, and BOTH matter:
 *   1. the failure is reported (the new behaviour)
 *   2. results still come back (the old behaviour, unchanged)
 *
 * Asserting only (1) would let a fix that turned these fatal pass, which would be
 * a far worse regression than the silence it replaced.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { runPostFusionStages, cosineReScore, hybridSearch } from '../../src/core/search/hybrid.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { SearchResult, PageInput, HybridSearchMeta } from '../../src/core/types.ts';

function results(): SearchResult[] {
  return [
    { slug: 'a', title: 'A', score: 1.0, chunk_id: 1, page_id: 1 } as SearchResult,
    { slug: 'b', title: 'B', score: 0.5, chunk_id: 2, page_id: 2 } as SearchResult,
  ];
}

const BOOM = new Error('simulated DB outage');

/**
 * An engine whose every boost-source method throws. Each test enables exactly one
 * stage, so the stage under test is the only one that can report.
 */
function throwingEngine(): BrainEngine {
  return {
    getBacklinkCounts: async () => { throw BOOM; },
    getSalienceScores: async () => { throw BOOM; },
    getEffectiveDates: async () => { throw BOOM; },
    getAdjacencyBoosts: async () => { throw BOOM; },
    getEmbeddingsByChunkIds: async () => { throw BOOM; },
  } as unknown as BrainEngine;
}

describe('post-fusion stages report fail-open instead of swallowing', () => {
  test('backlink stage failure is reported, and results survive', async () => {
    const seen: string[] = [];
    const rs = results();
    await runPostFusionStages(throwingEngine(), rs, {
      applyBacklinks: true,
      salience: 'off',
      recency: 'off',
      onStageFailure: (stage) => seen.push(stage),
    });
    expect(seen).toEqual(['backlink']);
    expect(rs).toHaveLength(2); // fail-OPEN preserved, not fail-closed
  });

  test('salience stage failure is reported, and results survive', async () => {
    const seen: string[] = [];
    const rs = results();
    await runPostFusionStages(throwingEngine(), rs, {
      applyBacklinks: false,
      salience: 'on',
      recency: 'off',
      onStageFailure: (stage) => seen.push(stage),
    });
    expect(seen).toEqual(['salience']);
    expect(rs).toHaveLength(2);
  });

  test('recency stage failure is reported, and results survive', async () => {
    const seen: string[] = [];
    const rs = results();
    await runPostFusionStages(throwingEngine(), rs, {
      applyBacklinks: false,
      salience: 'off',
      recency: 'on',
      onStageFailure: (stage) => seen.push(stage),
    });
    expect(seen).toEqual(['recency']);
    expect(rs).toHaveLength(2);
  });

  test('graph-signals reports through onGraphMeta, NOT the stage-failure sink', async () => {
    // This stage is architecturally different from the other three and the test
    // says so deliberately. applyGraphSignals catches its OWN error, logs it, sets
    // meta.errored and returns — it never throws, so the try/catch wrapping it
    // never fires. An earlier version of this test asserted onStageFailure and
    // failed; the mechanism, not the expectation, is what's authoritative.
    const seen: string[] = [];
    let graphErrored = false;
    const rs = results();
    await runPostFusionStages(throwingEngine(), rs, {
      applyBacklinks: false,
      salience: 'off',
      recency: 'off',
      graphSignalsEnabled: true,
      onStageFailure: (stage) => seen.push(stage),
      onGraphMeta: (m) => { if (m.errored) graphErrored = true; },
    });
    expect(graphErrored).toBe(true);
    expect(seen).toEqual([]); // it does NOT throw — this is the point
    expect(rs).toHaveLength(2);
  });

  // NOT TESTED, deliberately, and recorded rather than quietly omitted: the
  // try/catch wrapping the graph-signals stage is retained as a backstop for a
  // throw that escapes applyGraphSignals entirely — realistically only a failure
  // of the dynamic `import('./graph-signals.ts')`. I could not construct that
  // trigger: an engine-level error is caught by the stage's own try (verified
  // above, including via a Proxy that throws on property access, which is
  // evaluated inside that try). So the backstop is unproven, not proven-dead.
  // Its reachable failure mode is fully covered by the onGraphMeta path.

  test('a healthy run reports nothing', async () => {
    const seen: string[] = [];
    const healthy = {
      getBacklinkCounts: async () => new Map(),
      getSalienceScores: async () => new Map(),
      getEffectiveDates: async () => new Map(),
    } as unknown as BrainEngine;
    await runPostFusionStages(healthy, results(), {
      applyBacklinks: true,
      salience: 'on',
      recency: 'on',
      onStageFailure: (stage) => seen.push(stage),
    });
    expect(seen).toEqual([]);
  });

  test('the sink is optional — an omitted callback must not turn a skip into a throw', async () => {
    const rs = results();
    // The pre-v0.46 callers pass no sink. If `opts.onStageFailure?.()` were ever
    // written as a bare call, this is the test that catches it.
    await runPostFusionStages(throwingEngine(), rs, {
      applyBacklinks: true,
      salience: 'on',
      recency: 'on',
      graphSignalsEnabled: true,
    });
    expect(rs).toHaveLength(2);
  });
});

describe('cosineReScore reports its DB fail-open', () => {
  test('a DB error is reported AND the un-rescored results are still returned', async () => {
    let reported: unknown = null;
    const rs = results();
    const out = await cosineReScore(
      throwingEngine(),
      rs,
      new Float32Array([1, 0, 0]),
      'embedding',
      (err) => { reported = err; },
    );
    expect(reported).toBe(BOOM);
    // Fail-open contract: the ORIGINAL RRF order comes back untouched.
    expect(out).toBe(rs);
    expect(out.map(r => r.slug)).toEqual(['a', 'b']);
  });

  test('a successful rescore reports nothing', async () => {
    let reported: unknown = null;
    const engine = {
      getEmbeddingsByChunkIds: async () => new Map([
        [1, new Float32Array([1, 0, 0])],
        [2, new Float32Array([0, 1, 0])],
      ]),
    } as unknown as BrainEngine;
    await cosineReScore(engine, results(), new Float32Array([1, 0, 0]), 'embedding',
      (err) => { reported = err; });
    expect(reported).toBeNull();
  });

  test('no rows to rescore is not a degradation', async () => {
    let reported: unknown = null;
    // chunk_id all null → early return BEFORE the try block. This must not be
    // reported: "nothing to do" is not "the DB is down".
    const noChunks = [{ slug: 'a', title: 'A', score: 1, chunk_id: null } as unknown as SearchResult];
    const out = await cosineReScore(throwingEngine(), noChunks, new Float32Array([1, 0, 0]),
      'embedding', (err) => { reported = err; });
    expect(reported).toBeNull();
    expect(out).toBe(noChunks);
  });
});

/**
 * Wiring coverage. The unit tests above prove the SINKS fire; these prove the
 * signal actually reaches `_meta`, which is the only part a retrieval caller can
 * see. Testing the sink alone would leave `noteDegraded -> _meta.degraded_stages`
 * entirely unpinned — the exact "built, tested, connected to nothing" shape this
 * whole change is about.
 */
describe('degraded stages reach _meta on the real search path', () => {
  let engine: PGLiteEngine;
  const savedKey = process.env.OPENAI_API_KEY;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const page: PageInput = {
      type: 'person',
      title: 'Alice Example',
      compiled_truth: 'placeholder',
      timeline: '',
    };
    await engine.putPage('people/alice-example', page);
    // putPage ALONE leaves the page unsearchable — FTS reads content_chunks, so
    // without this every query returns zero rows, runPostFusionStages early-returns
    // on `results.length === 0`, and the stages under test never run at all. The
    // first version of this suite missed that and passed a stub that was never
    // called, which would have "verified" nothing.
    await engine.upsertChunks('people/alice-example', [
      { chunk_index: 0, chunk_text: 'Alice Example is a test person for degraded-stage tests.', chunk_source: 'compiled_truth' },
    ]);
    delete process.env.OPENAI_API_KEY; // keyword-only path; no embedding calls
  });

  afterAll(async () => {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
    await engine.disconnect();
  });

  async function metaFor(query: string): Promise<HybridSearchMeta | null> {
    let captured: HybridSearchMeta | null = null;
    await hybridSearch(engine, query, { onMeta: (m) => { captured = m; } });
    return captured;
  }

  test('a healthy search omits degraded_stages entirely', async () => {
    const meta = await metaFor('Alice');
    // ABSENT, not an empty array: happy-path meta must stay byte-identical to
    // pre-v0.46, which is what the "only emitted when non-empty" contract means.
    expect(meta?.degraded_stages).toBeUndefined();
  });

  test('a backlink outage surfaces on _meta.degraded_stages', async () => {
    const original = engine.getBacklinkCounts.bind(engine);
    (engine as unknown as { getBacklinkCounts: unknown }).getBacklinkCounts = async () => {
      throw new Error('simulated backlink outage');
    };
    try {
      const meta = await metaFor('Alice');
      expect(meta?.degraded_stages).toContain('backlink');
      // Fail-open preserved end to end: the query still answered.
      expect(meta).not.toBeNull();
    } finally {
      (engine as unknown as { getBacklinkCounts: unknown }).getBacklinkCounts = original;
    }
  });

  test('a graph-signals outage surfaces on _meta.degraded_stages via the bridge', async () => {
    // Pins the onGraphMeta bridge specifically. Mutation-checked: deleting the
    // noteDegraded call inside onGraphMeta must fail THIS test. Without it the
    // bridge was unpinned — graph-signals errors reached the failure log and
    // never the search response, which is the exact gap this change closes.
    const original = (engine as unknown as { getAdjacencyBoosts: unknown }).getAdjacencyBoosts;
    (engine as unknown as { getAdjacencyBoosts: unknown }).getAdjacencyBoosts = async () => {
      throw new Error('simulated adjacency outage');
    };
    try {
      const meta = await metaFor('Alice');
      expect(meta?.degraded_stages).toContain('graph_signals');
    } finally {
      (engine as unknown as { getAdjacencyBoosts: unknown }).getAdjacencyBoosts = original;
    }
  });

  // KNOWN COVERAGE GAP, measured and recorded rather than left implied.
  //
  // The cache-HIT carry of `degraded_stages` (hybrid.ts, the `hit.meta?.…` object)
  // is NOT pinned. Mutation-checked: replacing it with `{}` kills no test.
  //
  // Reaching it needs a semantic-cache hit, which needs a query embedding, which
  // needs an embedding provider — the same blocker that keeps `cosine_rescore` off
  // the integration path here (it is unit-tested directly instead).
  //
  // Deliberately not papered over with a mock: the whole cache-hit meta projection
  // is untested, including the four PRE-EXISTING siblings shipped with the v0.42
  // reranker wave (`vector_result_count`, `vector_requested_k`, `reranker_failed`,
  // `keyword_relaxed`). No test in the repo drives that object. So this line is at
  // the coverage level of the precedent it copies, not below it — but "no worse
  // than the neighbours" is a reason to name the gap, not to stop seeing it.
  // Closing it properly means a mock-embedding harness for the cache-hit path,
  // which would pin all five at once and is worth doing as its own change.

  test('recovery is not sticky — the next search is clean again', async () => {
    // Guards against collecting degradation in module scope instead of per-call.
    const meta = await metaFor('Alice');
    expect(meta?.degraded_stages).toBeUndefined();
  });
});
