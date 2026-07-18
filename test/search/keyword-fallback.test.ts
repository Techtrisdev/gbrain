/**
 * v0.42 — keyword→semantic fallback for the `search` op (TECH-2739 / U5).
 *
 * Unit-tests the pure decision/labeling helper with an INJECTED fallback fn, so
 * no live model / engine is needed (the `rerankerFn`-stub precedent). Covers the
 * ACs: knob off = inert; knob on + keyword hits = labeled 'keyword', no
 * fallback; knob on + empty = semantic rescue labeled 'semantic' + fallback_fired;
 * existence-check labeling (AE1); and abort/error propagation.
 */

import { describe, test, expect } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';
import { applyKeywordSemanticFallback } from '../../src/core/search/keyword-fallback.ts';

function r(slug: string): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'note',
    chunk_text: `body of ${slug}`, chunk_source: 'compiled_truth',
    chunk_id: 1000, chunk_index: 0, score: 0.5, stale: false, source_id: 'default',
  };
}

describe('applyKeywordSemanticFallback', () => {
  test('knob OFF: returns input untouched, no labels, no fallback call (bit-for-bit)', async () => {
    let called = 0;
    const kw = [r('a'), r('b')];
    const out = await applyKeywordSemanticFallback(kw, false, async () => { called += 1; return [r('z')]; });
    expect(out.fallback_fired).toBe(false);
    expect(out.results).toBe(kw); // same array reference, untouched
    expect(out.results.every((x) => x.match_type === undefined)).toBe(true);
    expect(called).toBe(0);
  });

  test('knob OFF + empty keyword: returns empty, no fallback call', async () => {
    let called = 0;
    const out = await applyKeywordSemanticFallback([], false, async () => { called += 1; return [r('z')]; });
    expect(out.results).toEqual([]);
    expect(out.fallback_fired).toBe(false);
    expect(called).toBe(0);
  });

  test('knob ON + keyword hits: labels keyword, no fallback call, fallback_fired false', async () => {
    let called = 0;
    const out = await applyKeywordSemanticFallback([r('a'), r('b')], true, async () => { called += 1; return [r('z')]; });
    expect(out.fallback_fired).toBe(false);
    expect(out.results.map((x) => x.match_type)).toEqual(['keyword', 'keyword']);
    expect(called).toBe(0);
  });

  test('knob ON + empty keyword: runs semantic fallback, labels semantic, fallback_fired true', async () => {
    let called = 0;
    const out = await applyKeywordSemanticFallback([], true, async () => { called += 1; return [r('x'), r('y')]; });
    expect(called).toBe(1);
    expect(out.fallback_fired).toBe(true);
    expect(out.results.map((x) => x.slug)).toEqual(['x', 'y']);
    expect(out.results.every((x) => x.match_type === 'semantic')).toBe(true);
  });

  test('AE1 existence-check: empty keyword under flag → every rescued row is semantic (a guess, never an exact match)', async () => {
    const out = await applyKeywordSemanticFallback([], true, async () => [r('n1'), r('n2'), r('n3')]);
    expect(out.fallback_fired).toBe(true);
    expect(out.results.some((x) => x.match_type === 'keyword')).toBe(false);
    expect(out.results.every((x) => x.match_type === 'semantic')).toBe(true);
  });

  test('abort/error in the fallback propagates (rejects) — no partial result', async () => {
    await expect(
      applyKeywordSemanticFallback([], true, async () => { throw new Error('aborted'); }),
    ).rejects.toThrow('aborted');
  });
});
