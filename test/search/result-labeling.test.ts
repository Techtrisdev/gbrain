/**
 * v0.42 — result labeling for the keyword→semantic fallback (TECH-2738 / U4).
 *
 * SearchResult gains an optional `match_type` ('keyword' | 'semantic') and
 * HybridSearchMeta gains an optional `fallback_fired`. Both are additive and
 * optional, unpopulated until the `search`-handler fallback branch lands
 * (TECH-2739). This suite pins their shape + JSON round-trip so a later unit
 * can rely on them being present, optional, and serialization-safe.
 */

import { describe, test, expect } from 'bun:test';
import type { SearchResult, HybridSearchMeta } from '../../src/core/types.ts';

function baseResult(slug: string): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: `body of ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1000,
    chunk_index: 0,
    score: 0.5,
    stale: false,
    source_id: 'default',
  };
}

describe('v0.42 result labeling — SearchResult.match_type', () => {
  test('a result stamped semantic round-trips match_type through JSON', () => {
    const r: SearchResult = { ...baseResult('x'), match_type: 'semantic' };
    const back = JSON.parse(JSON.stringify(r)) as SearchResult;
    expect(back.match_type).toBe('semantic');
  });

  test('match_type is optional — absent means the historical keyword default', () => {
    const r = baseResult('x');
    // Absent → callers treat it as an exact keyword match (only the fallback
    // path stamps 'semantic'), so an existence check is not misled.
    expect(r.match_type).toBeUndefined();
    const stamped: SearchResult = { ...r, match_type: 'keyword' };
    expect(stamped.match_type).toBe('keyword');
  });

  test('the only valid values are keyword and semantic', () => {
    const kw: SearchResult['match_type'] = 'keyword';
    const sem: SearchResult['match_type'] = 'semantic';
    expect([kw, sem]).toEqual(['keyword', 'semantic']);
  });
});

describe('v0.42 result labeling — HybridSearchMeta.fallback_fired', () => {
  const baseMeta: HybridSearchMeta = {
    vector_enabled: true,
    detail_resolved: 'medium',
    expansion_applied: false,
  };

  test('fallback_fired carries on the meta without disturbing existing fields', () => {
    const meta: HybridSearchMeta = { ...baseMeta, fallback_fired: true };
    expect(meta.fallback_fired).toBe(true);
    // existing required fields untouched
    expect(meta.vector_enabled).toBe(true);
    expect(meta.detail_resolved).toBe('medium');
    expect(meta.expansion_applied).toBe(false);
    const back = JSON.parse(JSON.stringify(meta)) as HybridSearchMeta;
    expect(back.fallback_fired).toBe(true);
  });

  test('fallback_fired is optional — absent when no fallback, false when keyword had hits', () => {
    expect(baseMeta.fallback_fired).toBeUndefined();
    const off: HybridSearchMeta = { ...baseMeta, fallback_fired: false };
    expect(off.fallback_fired).toBe(false);
  });
});
