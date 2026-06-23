/**
 * v0.40.x — cache-path telemetry symmetry.
 *
 * Closes the gap where hybridSearchCached recorded cache HITs but the MISS path
 * recorded through the inner hybridSearch meta (no cache field), so cache_miss
 * stayed permanently 0 and cache_hit_rate read a false ~100%. The fix suppresses
 * the inner record and has the wrapper write ONE row carrying cache.status.
 *
 * Mock the embedding surface so the cache path resolves to 'miss' (not 'disabled')
 * without a real provider. hybrid.ts is imported dynamically AFTER the mocks so
 * its static `embedQuery` import is intercepted (ESM hoisting otherwise wins).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { getTelemetryWriter, _resetTelemetryWriterForTest } from '../src/core/search/telemetry.ts';

const DIM = 1536;
function fakeEmb(): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(i * 0.01);
  let s = 0; for (let i = 0; i < DIM; i++) s += v[i] * v[i];
  const m = Math.sqrt(s) || 1; for (let i = 0; i < DIM; i++) v[i] /= m;
  return v;
}

mock.module('../src/core/embedding.ts', () => ({
  embed: async () => fakeEmb(),
  embedQuery: async () => fakeEmb(),
}));
mock.module('../src/core/ai/gateway.ts', () => ({
  isAvailable: () => true,
  embedQueryMultimodal: async () => null,
}));

let hybridSearchCached: (typeof import('../src/core/search/hybrid.ts'))['hybridSearchCached'];
let engine: PGLiteEngine;

beforeAll(async () => {
  ({ hybridSearchCached } = await import('../src/core/search/hybrid.ts'));
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  _resetTelemetryWriterForTest();
  await engine.executeRaw('DELETE FROM search_telemetry');
});

describe('cache-MISS telemetry (closes the cache_miss-always-0 gap)', () => {
  test('a cache MISS records exactly ONE attributed row with cache_miss=1', async () => {
    const w = getTelemetryWriter();
    w.setEngine(engine);

    await hybridSearchCached(engine, 'a query that is not cached', {
      caller: { client: 'jarvis-openclaw', sourceId: 'jarvis-openclaw' },
    });
    await w.flush();

    const rows = await engine.executeRaw<{ client: string; cache_hit: number; cache_miss: number; count: number }>(
      `SELECT client, cache_hit, cache_miss, count FROM search_telemetry WHERE client = 'jarvis-openclaw'`,
    );
    // Inner record suppressed, wrapper records once → exactly one attributed row.
    expect(rows.length).toBe(1);
    expect(rows[0].count).toBe(1);      // no double-count (inner suppressed)
    expect(rows[0].cache_miss).toBe(1); // the MAJOR fix: a miss now increments cache_miss
    expect(rows[0].cache_hit).toBe(0);
  });
  // NOTE: an e2e cache-HIT assertion through hybridSearchCached is harness-limited
  // here — a two-call (miss-stores, hit-serves) approach needs the seeded page to be
  // keyword-searchable so the writeback fires, which requires an indexing step this
  // unit harness doesn't run. The hit branch (cachedMeta, cache.status='hit') is
  // covered by the cache_hit-counter unit test in search-telemetry.test.ts and by
  // adversary review of the call site; the miss test above pins the shared
  // suppress-inner / wrapper-records-once mechanism.
});
