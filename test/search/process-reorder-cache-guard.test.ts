/**
 * v0.40.x — regression tests for the two adversary-flagged defects in the Option-A
 * process reorder:
 *   BLOCKER (cache): process_reorder_enabled must participate in knobsHash, else a
 *     config flip serves stale pre-flip (reorder-off) cache rows for up to the TTL.
 *   MAJOR (federated guard): the entity guard must check the FULL source scope the
 *     search reads, not a hardcoded 'default' — else a person in a federated source
 *     escapes the guard and gets demoted.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { knobsHash, resolveSearchMode } from '../../src/core/search/mode.ts';
import { referencesKnownEntity } from '../../src/core/search/process-reorder.ts';
import type { PageInput } from '../../src/core/types.ts';

describe('BLOCKER fix — process_reorder is folded into knobsHash (cache segregation)', () => {
  test('reorder ON vs OFF produce DIFFERENT knobsHashes', () => {
    const on = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { process_reorder_enabled: true } }));
    const off = knobsHash(resolveSearchMode({ mode: 'balanced', perCall: { process_reorder_enabled: false } }));
    // Without the pr= term + version bump, these collide and a reorder-on write is
    // served to a reorder-off read (and vice-versa on rollback).
    expect(on).not.toBe(off);
  });
});

describe('MAJOR fix — referencesKnownEntity honors the full source scope', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('people/simon', {
      type: 'note', title: 'Simon', compiled_truth: 'x', timeline: '', frontmatter: {},
    } as PageInput);
  });
  afterAll(async () => { await engine.disconnect(); });

  test('a scope that INCLUDES the person source matches; one that does not, does not', async () => {
    // people/simon is in the default source.
    expect(await referencesKnownEntity(engine, 'how does Simon work', ['default'])).toBe(true);
    // A scope WITHOUT the person's source does not match — proving the guard no longer
    // collapses to a hardcoded 'default' but applies the passed scope (the federated bug).
    expect(await referencesKnownEntity(engine, 'how does Simon work', ['some-other-source'])).toBe(false);
    // A multi-source (federated) scope that includes the person's source → matched.
    expect(await referencesKnownEntity(engine, 'how does Simon work', ['acme', 'default'])).toBe(true);
  });

  test('a non-entity process query does not match (no over-suppression here)', async () => {
    expect(await referencesKnownEntity(engine, 'how does promotion work', ['default'])).toBe(false);
  });
});
