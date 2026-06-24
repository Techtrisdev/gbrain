/**
 * v0.40.x — keyword `search` op telemetry. The keyword op bypasses hybridSearch, so
 * it was invisible in search_telemetry. It now records with mode='keyword' — a DISTINCT
 * rollup bucket that does not merge with or distort the semantic modes (conservative/
 * balanced/tokenmax) or the cache_hit_rate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import {
  recordSearchTelemetry,
  getTelemetryWriter,
  _resetTelemetryWriterForTest,
} from '../../src/core/search/telemetry.ts';
import type { HybridSearchMeta } from '../../src/core/types.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { _resetTelemetryWriterForTest(); await engine.executeRaw('DELETE FROM search_telemetry'); });

const meta = (o: Partial<HybridSearchMeta> = {}): HybridSearchMeta => ({
  vector_enabled: false, detail_resolved: null, expansion_applied: false, intent: 'general', mode: 'balanced', ...o,
});

describe('keyword-op telemetry (mode=keyword) is a distinct rollup bucket', () => {
  test('keyword records SEPARATELY from semantic modes; no cache-rate distortion', async () => {
    const w = getTelemetryWriter(); w.setEngine(engine);
    const caller = { client: 'support-agent-demo', sourceId: 'support-demo' };
    // keyword op (the new instrumentation): no vector, no cache.
    recordSearchTelemetry(engine, meta({ mode: 'keyword', vector_enabled: false, intent: 'general' }), { results_count: 5 }, caller);
    // semantic ops (query/think): balanced (reranker on, cache miss) + conservative (cache hit).
    recordSearchTelemetry(engine, meta({ mode: 'balanced', vector_enabled: true, intent: 'general', cache: { status: 'miss' } }), { results_count: 7 }, caller);
    recordSearchTelemetry(engine, meta({ mode: 'conservative', vector_enabled: true, intent: 'entity', cache: { status: 'hit' } }), { results_count: 3 }, caller);
    await w.flush();

    const rows = await engine.executeRaw<{ mode: string; intent: string; count: number; cache_hit: number; cache_miss: number; sum_results: number }>(
      `SELECT mode, intent, count, cache_hit, cache_miss, sum_results FROM search_telemetry WHERE client='support-agent-demo' ORDER BY mode`);
    // Three distinct buckets — keyword is its OWN row, never merged with semantic.
    expect(rows.map(r => r.mode).sort()).toEqual(['balanced', 'conservative', 'keyword']);
    const kw = rows.find(r => r.mode === 'keyword')!;
    expect(kw.count).toBe(1);
    expect(kw.sum_results).toBe(5);
    expect(kw.cache_hit).toBe(0);   // keyword has no cache → does NOT feed cache_hit_rate
    expect(kw.cache_miss).toBe(0);
    // Semantic cache activity is untouched by the keyword row.
    expect(rows.find(r => r.mode === 'balanced')!.cache_miss).toBe(1);
    expect(rows.find(r => r.mode === 'conservative')!.cache_hit).toBe(1);
  });

  test('PROOF QUERY — rollup distinguishes semantic vs keyword + rerank (implied by mode)', async () => {
    const w = getTelemetryWriter(); w.setEngine(engine);
    recordSearchTelemetry(engine, meta({ mode: 'keyword' }), { results_count: 5 }, { client: 'c', sourceId: 's' });
    recordSearchTelemetry(engine, meta({ mode: 'balanced', cache: { status: 'miss' } }), { results_count: 7 }, { client: 'c', sourceId: 's' });
    recordSearchTelemetry(engine, meta({ mode: 'conservative', cache: { status: 'miss' } }), { results_count: 3 }, { client: 'c', sourceId: 's' });
    await w.flush();

    // The exact live-diagnostic shape: classify each mode bucket.
    const diag = await engine.executeRaw<{ traffic_type: string; rerank: string; mode: string; calls: number }>(
      `SELECT
         CASE WHEN mode = 'keyword' THEN 'keyword' ELSE 'semantic' END                  AS traffic_type,
         CASE WHEN mode IN ('balanced','tokenmax') THEN 'on'
              WHEN mode = 'conservative'           THEN 'off'
              ELSE 'n/a' END                                                            AS rerank,
         mode, sum(count)::int AS calls
       FROM search_telemetry GROUP BY mode ORDER BY mode`);
    const byMode = Object.fromEntries(diag.map(d => [d.mode, d]));
    expect(byMode['keyword'].traffic_type).toBe('keyword');
    expect(byMode['balanced'].traffic_type).toBe('semantic');
    expect(byMode['balanced'].rerank).toBe('on');         // rerank implied by mode
    expect(byMode['conservative'].rerank).toBe('off');
    expect(byMode['keyword'].rerank).toBe('n/a');         // keyword has no reranker
  });
});
