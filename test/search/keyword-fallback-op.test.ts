/**
 * TECH-2740 / N4 — op-level wiring for the keyword→semantic fallback telemetry.
 *
 * Runs the REAL `search` operation handler end-to-end (via operationsByName) so the
 * single load-bearing line — operations.ts recording `results_count:
 * keywordResults.length` (0 on a miss) + `fallback_fired`, and passing
 * `_suppressTelemetry` on the rescue leg — is pinned. The prior telemetry tests call
 * recordSearchTelemetry directly and would NOT catch a regression of that line back to
 * `results.length` (which would re-mask the keyword miss) or a dropped suppression flag
 * (which would double-count the rescue as a semantic call).
 *
 * No mock: an empty PGLite brain makes searchKeyword return [] (a miss); the real
 * hybridSearchCached rescue returns [] too on the empty brain, but fallback_fired is
 * still true (the fallback RAN), which is exactly the recorded signal.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { getTelemetryWriter, _resetTelemetryWriterForTest } from '../../src/core/search/telemetry.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  _resetTelemetryWriterForTest();
  await engine.executeRaw('DELETE FROM search_telemetry');
});

function ctx(): OperationContext {
  return {
    engine,
    remote: false,
    config: {},
    logger: console,
    dryRun: false,
    auth: { clientName: 'kf-op', sourceId: 'kf-src' },
    sourceId: 'kf-src',
  } as unknown as OperationContext;
}

describe('search op — keyword→semantic fallback telemetry wiring (TECH-2740 / N4)', () => {
  test('knob ON + keyword MISS: ONE keyword bucket, results_count=0 + fallback_fired=1 (no semantic double-count)', async () => {
    await engine.setConfig('search.keyword_semantic_fallback', '1');
    const op = operationsByName['search'];
    // Empty brain → searchKeyword returns [] (a miss). Fallback fires; the rescue
    // returns [] on the empty brain but still counts as fired.
    await op.handler(ctx(), { query: 'zzznomatchzzz-tech2740' });
    await getTelemetryWriter().flush();

    const rows = await engine.executeRaw<{ mode: string; count: number; sum_results: number; fallback_fired: number }>(
      `SELECT mode, count, sum_results, fallback_fired FROM search_telemetry`,
    );
    // N1: exactly ONE row — the rescue's semantic-mode telemetry is suppressed, so a
    // rescued call is NOT double-counted (no phantom 'balanced'/'conservative' row).
    expect(rows.length).toBe(1);
    expect(rows[0].mode).toBe('keyword');
    // N4: the load-bearing line. sum_results = the KEYWORD count (0 on a miss), NOT the
    // rescued semantic count; fallback_fired is the rescue overlay.
    expect(rows[0].count).toBe(1);
    expect(rows[0].sum_results).toBe(0);
    expect(rows[0].fallback_fired).toBe(1);
  });

  test('knob OFF: keyword miss records fallback_fired=0 and no semantic row', async () => {
    await engine.setConfig('search.keyword_semantic_fallback', '0');
    const op = operationsByName['search'];
    await op.handler(ctx(), { query: 'zzznomatchzzz-tech2740' });
    await getTelemetryWriter().flush();

    const rows = await engine.executeRaw<{ mode: string; fallback_fired: number }>(
      `SELECT mode, fallback_fired FROM search_telemetry`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].mode).toBe('keyword');
    expect(rows[0].fallback_fired).toBe(0);
  });
});
