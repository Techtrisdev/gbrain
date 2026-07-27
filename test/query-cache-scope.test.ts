/**
 * Regression test for the federated cache-scope collapse.
 *
 * Before this fix, `sourceScopeOpts` (operations.ts) returned
 * `{sourceIds: [...]}` and left `sourceId` UNDEFINED for any caller holding a
 * non-empty `allowedSources` grant. Both cache boundaries in hybrid.ts passed
 * only `opts?.sourceId`, and query-cache.ts collapsed that to the literal
 * string `'default'`:
 *
 *     const sourceId = opts.sourceId ?? 'default';
 *
 * Every federated OAuth client therefore shared ONE cache namespace regardless
 * of its distinct grant. Measured on the live brain 2026-07-26: 517 of 525
 * query_cache rows were keyed `'default'`, and among them 30 carried
 * capture-events content and 59 carried jarvis-openclaw content — grant-
 * restricted payloads co-resident in one unpartitioned key space. A result set
 * cached for grant {capture-events} was servable to a caller holding only
 * {shared}.
 *
 * The lookup is a *vector-similarity* search, not an exact query-text match, so
 * a hit needs only a semantically near query — and `knobsHash` carries no
 * per-caller state, so it cannot partition callers either.
 *
 * After this fix:
 *   - cacheScopeKey({sourceIds}) → '__set__:<sorted,ids>' — a stable, grant-
 *     specific namespace, order-independent so key generation cannot fragment
 *   - cacheScopeKey({sourceId})  → the scalar id (unchanged behavior)
 *   - cacheScopeKey({})          → 'default' (unchanged behavior)
 *
 * Structurally mirrors query-cache-knobs-hash.test.ts, which pins the
 * equivalent cross-MODE contamination fix. This one pins cross-GRANT.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SemanticQueryCache, cacheRowId, cacheScopeKey } from '../src/core/search/query-cache.ts';
import type { SearchResult, HybridSearchMeta } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM query_cache');
});

const makeEmbedding = (seed: number): Float32Array => {
  const arr = new Float32Array(1536);
  for (let i = 0; i < 1536; i++) arr[i] = Math.sin(seed + i * 0.001);
  let norm = 0;
  for (let i = 0; i < 1536; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < 1536; i++) arr[i] /= norm;
  return arr;
};

const makeResults = (label: string): SearchResult[] => [
  {
    slug: `${label}/secret-page`,
    title: `${label} secret page`,
    chunk_text: `body-of-${label}`,
    chunk_id: 4242,
    score: 0.9,
    chunk_index: 0,
    type: 'note' as const,
    chunk_source: 'compiled_truth' as const,
    page_id: 1,
    stale: false,
  },
];

const META = {} as HybridSearchMeta;

describe('cacheScopeKey — key derivation', () => {
  test('two distinct federated grants produce DIFFERENT keys', () => {
    // The leak, at its root: {a,b} and {a,c} must never share a namespace.
    expect(cacheScopeKey({ sourceIds: ['a', 'b'] })).not.toBe(
      cacheScopeKey({ sourceIds: ['a', 'c'] }),
    );
  });

  test('grant order does not change the key', () => {
    // Without sorting, the same grant arriving in a different order would
    // fragment the cache into duplicate namespaces — a silent hit-rate loss.
    expect(cacheScopeKey({ sourceIds: ['b', 'a'] })).toBe(cacheScopeKey({ sourceIds: ['a', 'b'] }));
  });

  test('a scalar sourceId caller is unchanged', () => {
    expect(cacheScopeKey({ sourceId: 'shared' })).toBe('shared');
  });

  test('empty sourceIds falls through to the scalar id', () => {
    // Mirrors sourceScopeOpts, which deliberately treats `allowedSources: []`
    // as "no federated scope" rather than "no filter" — an attacker-controlled
    // [] must not widen scope.
    expect(cacheScopeKey({ sourceIds: [], sourceId: 'shared' })).toBe('shared');
  });

  test('no scope at all yields the legacy default', () => {
    expect(cacheScopeKey({})).toBe('default');
    expect(cacheScopeKey()).toBe('default');
  });

  test('a federated grant wins over a scalar id when both are present', () => {
    // sourceScopeOpts returns these as mutually exclusive shapes, but the key
    // must be unambiguous if a future caller ever supplies both.
    expect(cacheScopeKey({ sourceIds: ['a', 'b'], sourceId: 'a' })).not.toBe('a');
  });

  test('a federated key cannot collide with a scalar source literally named the same', () => {
    // The '__set__:' prefix keeps the two namespaces disjoint.
    expect(cacheScopeKey({ sourceIds: ['a'] })).not.toBe(cacheScopeKey({ sourceId: 'a' }));
  });
});

describe('cacheRowId is bifurcated by scope key', () => {
  test('same query + knobs, different grants → different row IDs', () => {
    const a = cacheRowId('what did we decide', cacheScopeKey({ sourceIds: ['a', 'b'] }), 'k');
    const b = cacheRowId('what did we decide', cacheScopeKey({ sourceIds: ['a', 'c'] }), 'k');
    expect(a).not.toBe(b);
  });
});

describe('the production call sites actually use the scoped key', () => {
  /**
   * Adversarial review caught a real gap: every other test in this file calls
   * `cacheScopeKey()` at the test site, so reverting BOTH hybrid.ts call sites
   * back to the buggy `opts?.sourceId` would leave the entire suite green
   * while the leak returned. A correct helper wired to nothing is not a fix.
   *
   * A full e2e assertion through `hybridSearchCached` is harness-limited here,
   * and not by my hand: `test/telemetry-cache-miss.serial.test.ts` documents
   * the same wall — a cache writeback requires the seeded page to be
   * keyword-searchable, which needs an indexing step the unit harness does not
   * run. Rather than fake that, this pins the wiring directly. It fails the
   * moment either call site stops deriving a scoped key, which is precisely
   * the regression the review was worried about.
   */
  const hybridSource = readFileSync(
    new URL('../src/core/search/hybrid.ts', import.meta.url),
    'utf-8',
  );

  test('the cache LOOKUP derives a scoped key, not the bare scalar', () => {
    expect(hybridSource).toContain('cache.lookup(queryEmbedding, { sourceId: cacheScopeKey(opts)');
  });

  test('the cache STORE derives a scoped key, not the bare scalar', () => {
    expect(hybridSource).toMatch(/\.store\([^)]*sourceId: cacheScopeKey\(opts\)/s);
  });

  test('neither cache site passes the raw opts.sourceId any more', () => {
    // The exact pre-fix expression. Its return anywhere near a cache call is
    // the bug coming back.
    const cacheCalls = hybridSource
      .split('\n')
      .filter((line) => line.includes('cache.lookup(') || line.includes('.store(query,'));
    expect(cacheCalls.length).toBeGreaterThanOrEqual(2);
    for (const line of cacheCalls) {
      expect(line).not.toContain('sourceId: opts?.sourceId');
    }
  });

  test('cacheScopeKey is imported where it is used', () => {
    expect(hybridSource).toMatch(/import\s*\{[^}]*cacheScopeKey[^}]*\}\s*from\s*'\.\/query-cache\.ts'/s);
  });
});

describe('SemanticQueryCache — cross-grant isolation end to end', () => {
  test('a row stored under grant {a,b} is NOT served to grant {a,c}', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(1);
    const knobsHash = 'k';

    await cache.store('what did we decide', emb, makeResults('grant-ab'), META, {
      sourceId: cacheScopeKey({ sourceIds: ['a', 'b'] }),
      knobsHash,
    });

    // Identical embedding — an exact vector match. The ONLY thing that may
    // prevent this hit is scope isolation. If this returns a hit, the leak is
    // live.
    const hit = await cache.lookup(emb, {
      sourceId: cacheScopeKey({ sourceIds: ['a', 'c'] }),
      knobsHash,
    });

    expect(hit.hit).toBe(false);
  });

  test('a row stored under grant {a,b} IS served back to the same grant', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(2);
    const knobsHash = 'k';
    const scope = cacheScopeKey({ sourceIds: ['a', 'b'] });

    await cache.store('what did we decide', emb, makeResults('grant-ab'), META, {
      sourceId: scope,
      knobsHash,
    });
    const hit = await cache.lookup(emb, { sourceId: scope, knobsHash });

    expect(hit.hit).toBe(true);
  });

  test('grant order does not cause a spurious miss', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(3);
    const knobsHash = 'k';

    await cache.store('what did we decide', emb, makeResults('grant-ab'), META, {
      sourceId: cacheScopeKey({ sourceIds: ['a', 'b'] }),
      knobsHash,
    });
    const hit = await cache.lookup(emb, {
      sourceId: cacheScopeKey({ sourceIds: ['b', 'a'] }),
      knobsHash,
    });

    expect(hit.hit).toBe(true);
  });

  test('scalar-source callers are unaffected by the change', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(4);
    const knobsHash = 'k';

    await cache.store('what did we decide', emb, makeResults('shared'), META, {
      sourceId: cacheScopeKey({ sourceId: 'shared' }),
      knobsHash,
    });
    const hit = await cache.lookup(emb, {
      sourceId: cacheScopeKey({ sourceId: 'shared' }),
      knobsHash,
    });

    expect(hit.hit).toBe(true);
  });

  test('a scalar caller cannot read a federated grant row', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(5);
    const knobsHash = 'k';

    await cache.store('what did we decide', emb, makeResults('grant-ab'), META, {
      sourceId: cacheScopeKey({ sourceIds: ['a', 'b'] }),
      knobsHash,
    });
    const hit = await cache.lookup(emb, {
      sourceId: cacheScopeKey({ sourceId: 'a' }),
      knobsHash,
    });

    expect(hit.hit).toBe(false);
  });
});
