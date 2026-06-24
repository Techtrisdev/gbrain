/**
 * v0.40.x — unit tests for the Option-A pure functions: the process detector and
 * the bounded reorder. (The structural entity guard `referencesKnownEntity` needs
 * the corpus, so it is covered by the reranker e2e fixture, not here.)
 */
import { describe, expect, test } from 'bun:test';
import { isProcessQuery } from '../../src/core/search/query-intent.ts';
import { applyProcessReorder } from '../../src/core/search/process-reorder.ts';
import type { SearchResult } from '../../src/core/types.ts';

describe('isProcessQuery (pure detector)', () => {
  test('fires for process / how-to questions', () => {
    expect(isProcessQuery('how does a learning get promoted')).toBe(true);
    expect(isProcessQuery('how do we promote learnings')).toBe(true);
    expect(isProcessQuery('what is the process for promotion')).toBe(true);
    expect(isProcessQuery('steps to promote a candidate')).toBe(true);
    expect(isProcessQuery('how does promotion work')).toBe(true);
  });
  test('does not fire for plain entity / lookup phrasings', () => {
    expect(isProcessQuery('who is Simon')).toBe(false);
    expect(isProcessQuery('Simon Hermes')).toBe(false);
    expect(isProcessQuery('retention')).toBe(false);
  });
  test('"how does <person> work" is process-shaped — entity exclusion is the structural guard, NOT a phrase blocklist', () => {
    expect(isProcessQuery('how does Simon work')).toBe(true);
  });
});

describe('applyProcessReorder (bounded, conservative)', () => {
  const mk = (slug: string): SearchResult =>
    ({ slug, chunk_source: 'compiled_truth', score: 1 } as unknown as SearchResult);

  test('lifts the top process doc above the highest person result', () => {
    const r = [mk('people/simon'), mk('people/jane'), mk('playbooks/x'), mk('notes/y')];
    applyProcessReorder(r);
    expect(r.map(x => x.slug)).toEqual(['playbooks/x', 'people/simon', 'people/jane', 'notes/y']);
  });
  test('no-op when the process doc is already above the person', () => {
    const r = [mk('playbooks/x'), mk('people/simon'), mk('notes/y')];
    const before = r.map(x => x.slug);
    applyProcessReorder(r);
    expect(r.map(x => x.slug)).toEqual(before);
  });
  test('no-op when no process doc is present', () => {
    const r = [mk('people/simon'), mk('notes/y'), mk('companies/z')];
    const before = r.map(x => x.slug);
    applyProcessReorder(r);
    expect(r.map(x => x.slug)).toEqual(before);
  });
  test('no-op when no person result is present', () => {
    const r = [mk('notes/y'), mk('playbooks/x')];
    const before = r.map(x => x.slug);
    applyProcessReorder(r);
    expect(r.map(x => x.slug)).toEqual(before);
  });
  test('bounded: a process doc OUTSIDE the window is not promoted', () => {
    const r = [mk('people/simon'), ...Array.from({ length: 9 }, (_, i) => mk('notes/n' + i)), mk('playbooks/x')];
    applyProcessReorder(r, 10); // playbooks/x is at index 10, outside the window
    expect(r[0]!.slug).toBe('people/simon');
  });
});
