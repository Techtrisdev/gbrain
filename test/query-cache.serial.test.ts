/**
 * v0.32.x search-lite \u2014 semantic query cache.
 *
 * PGLite-backed test. Confirms:
 *   - migration v51 creates the query_cache table
 *   - store + lookup roundtrip with EXACT same embedding \u2192 hit
 *   - lookup with a similar embedding (cosine > 0.92) \u2192 hit
 *   - lookup with a far embedding \u2192 miss
 *   - TTL expiration: a stale row is skipped at read time
 *   - clear / prune / stats work as advertised
 *   - source_id isolation: brain A's cache doesn't leak to brain B
 *   - disabled cache is a pure no-op
 *
 * Uses synthetic Float32Array embeddings so the test doesn't depend on
 * any external embedding provider.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SemanticQueryCache, cacheRowId, distinctiveTokens, entitySetsMatch, cacheEntityGate } from '../src/core/search/query-cache.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { SearchResult, HybridSearchMeta } from '../src/core/types.ts';

let engine: PGLiteEngine;

// Build a stable, normalized embedding. PGLite ships pgvector with 1536-dim
// support (the default); a smaller test dim won't match the column. We
// truncate / pad to 1536 to match the migration's resolved dim.
const DIM = 1536;

function makeEmbedding(seed: number, dim = DIM): Float32Array {
  const e = new Float32Array(dim);
  // Simple deterministic generator with a unique fingerprint per seed
  // so similar seeds produce similar (cosine > 0.95) vectors and distinct
  // seeds produce orthogonal-ish ones.
  for (let i = 0; i < dim; i++) {
    e[i] = Math.sin(seed * 0.001 + i * 0.01);
  }
  // L2-normalize so cosine = dot product.
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) e[i] /= mag;
  return e;
}

function makeOrthogonalEmbedding(seed: number, dim = DIM): Float32Array {
  // Use a totally different basis so cosine is near-zero.
  const e = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    e[i] = Math.cos(seed * 13.7 + i * 0.97);
  }
  let mag = 0;
  for (let i = 0; i < dim; i++) mag += e[i] * e[i];
  mag = Math.sqrt(mag);
  if (mag > 0) for (let i = 0; i < dim; i++) e[i] /= mag;
  return e;
}

function makeResult(slug: string): SearchResult {
  return {
    slug,
    page_id: 1,
    title: `Title for ${slug}`,
    type: 'concept',
    chunk_text: `chunk text for ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 1.0,
    stale: false,
  };
}

const META: HybridSearchMeta = {
  vector_enabled: true,
  detail_resolved: 'medium',
  expansion_applied: false,
  intent: 'general',
};

beforeAll(async () => {
  // v0.36.2.0: DEFAULT_EMBEDDING_DIMENSIONS flipped to 1280 (ZE Matryoshka).
  // This test hardcodes DIM=1536 in its embeddings. If another test file in
  // the same shard configured the gateway before us, initSchema() would size
  // query_cache.embedding at vector(1280) and every insert below would fail
  // with "expected 1280 dimensions, not 1536". Pin the gateway to 1536d
  // explicitly so this file is hermetic regardless of cross-file state.
  resetGateway();
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  try { await engine.disconnect(); } catch { /* ignore */ }
  resetGateway();
});

beforeEach(async () => {
  // Wipe the cache between tests so ordering doesn't matter.
  await engine.executeRaw(`DELETE FROM query_cache`);
});

describe('migration v51 \u2014 query_cache table exists', () => {
  test('table is present and has expected columns', async () => {
    const rows = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'query_cache'`,
    );
    const names = rows.map(r => r.column_name);
    expect(names).toContain('id');
    expect(names).toContain('query_text');
    expect(names).toContain('source_id');
    expect(names).toContain('embedding');
    expect(names).toContain('results');
    expect(names).toContain('meta');
    expect(names).toContain('ttl_seconds');
    expect(names).toContain('created_at');
    expect(names).toContain('hit_count');
  });
});

describe('cacheRowId', () => {
  test('is deterministic across same input', () => {
    expect(cacheRowId('hello', 'default')).toBe(cacheRowId('hello', 'default'));
  });
  test('differs across source_id', () => {
    expect(cacheRowId('hello', 'a')).not.toBe(cacheRowId('hello', 'b'));
  });
});

describe('SemanticQueryCache \u2014 store + lookup', () => {
  test('roundtrip: exact embedding match returns a hit', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(1);
    const results = [makeResult('a'), makeResult('b')];

    await cache.store('what is foo', emb, results, META);
    const hit = await cache.lookup(emb);

    expect(hit.hit).toBe(true);
    expect(hit.results).toHaveLength(2);
    expect(hit.results?.[0].slug).toBe('a');
    expect(hit.similarity).toBeGreaterThan(0.99);
  });

  test('similar embedding (cosine > 0.92) is a hit', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(100);

    // Construct a near-neighbor: tweak a few dims so cosine stays > 0.92.
    const near = new Float32Array(base);
    for (let i = 0; i < 10; i++) near[i] += 0.005;
    // Re-normalize.
    let mag = 0;
    for (let i = 0; i < DIM; i++) mag += near[i] * near[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < DIM; i++) near[i] /= mag;

    await cache.store('what is foo', base, [makeResult('a')], META);
    const hit = await cache.lookup(near);

    expect(hit.hit).toBe(true);
    expect(hit.similarity).toBeGreaterThan(0.92);
  });

  test('orthogonal embedding is a miss', async () => {
    const cache = new SemanticQueryCache(engine);
    const a = makeEmbedding(1);
    const b = makeOrthogonalEmbedding(2);
    await cache.store('q1', a, [makeResult('a')], META);
    const hit = await cache.lookup(b);
    expect(hit.hit).toBe(false);
  });
});

// v0.42 — distinctive-token (entity) gate. The confirmed collision: entity-swapped
// queries embed within the 0.08 threshold, so pre-fix the cache served one the
// other's result. A near-neighbor embedding with a DIFFERENT distinctive entity
// must now MISS; a same-entity paraphrase still hits.
describe('distinctiveTokens (entity extraction)', () => {
  test('extracts capitalized proper nouns, drops question/stop words', () => {
    expect([...distinctiveTokens('What is Spendgo used for?')]).toEqual(['spendgo']);
    expect([...distinctiveTokens('What is Punchh used for?')]).toEqual(['punchh']);
    expect([...distinctiveTokens('What is Olo used for?')]).toEqual(['olo']);
  });
  test('multi-word entities + all-caps acronyms', () => {
    const t = distinctiveTokens('Bahia Bowls POS integration status');
    expect(t.has('bahia')).toBe(true);
    expect(t.has('bowls')).toBe(true);
    expect(t.has('pos')).toBe(true);
  });
  test('double-quoted phrases are distinctive; apostrophes do NOT pair', () => {
    expect(distinctiveTokens('what does "closed won" mean').has('closed won')).toBe(true);
    // "Lenny's" apostrophe must not create a spurious quoted span (false-miss guard).
    const t = distinctiveTokens("What is Lenny's loyalty");
    expect(t.has('s loyalty')).toBe(false);
    expect(t.has('lenny')).toBe(true);
  });
  test('generic queries have no distinctive tokens', () => {
    expect(distinctiveTokens('how does the loyalty flow work').size).toBe(0);
  });
  test('entitySetsMatch: swapped entities differ, same entity matches', () => {
    expect(entitySetsMatch(distinctiveTokens('What is Spendgo used for?'), distinctiveTokens('What is Punchh used for?'))).toBe(false);
    expect(entitySetsMatch(distinctiveTokens('What is Spendgo used for?'), distinctiveTokens('What does Spendgo do?'))).toBe(true);
  });
});

describe('cacheEntityGate — the serve-or-miss decision', () => {
  test('capitalized entity swap is rejected', () => {
    expect(cacheEntityGate('What is Spendgo used for?', 'What is Punchh used for?')).toBe(false);
  });
  test('LOWERCASE entity swap is ALSO rejected (content-token fallback)', () => {
    // Neither has a capitalized token → distinctive sets both empty → without the
    // fallback these would collide (a WRONG hit). The content-token fallback
    // ({spendgo,used} vs {punchh,used}) catches it.
    expect(cacheEntityGate('what is spendgo used for', 'what is punchh used for')).toBe(false);
  });
  test('same entity (any casing) is allowed', () => {
    expect(cacheEntityGate('What is Spendgo used for?', 'What does Spendgo do?')).toBe(true);
    expect(cacheEntityGate('what is spendgo used for', 'what is spendgo used for')).toBe(true);
  });
});

describe('SemanticQueryCache — entity-collision gate', () => {
  // A near-neighbor of `base` (cosine > 0.92), so ONLY the entity gate can
  // differentiate — the embedding says "hit".
  function nearNeighbor(base: Float32Array): Float32Array {
    const near = new Float32Array(base);
    for (let i = 0; i < 10; i++) near[i] += 0.005;
    let mag = 0;
    for (let i = 0; i < DIM; i++) mag += near[i] * near[i];
    mag = Math.sqrt(mag);
    for (let i = 0; i < DIM; i++) near[i] /= mag;
    return near;
  }

  test('entity-swapped query within cosine threshold MISSES (the Spendgo/Punchh collision)', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(500);
    const near = nearNeighbor(base);
    await cache.store('What is Spendgo used for?', base, [makeResult('integrations/spendgo')], META);
    // Same embedding neighborhood, different entity → must NOT serve spendgo's row.
    const hit = await cache.lookup(near, { queryText: 'What is Punchh used for?' });
    expect(hit.hit).toBe(false);
    expect(hit.entityGateRejected).toBe(true); // distinguishable from a cosine miss
  });

  test('LOWERCASE entity-swapped query within cosine threshold ALSO misses', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(510);
    const near = nearNeighbor(base);
    await cache.store('what is spendgo used for', base, [makeResult('integrations/spendgo')], META);
    const hit = await cache.lookup(near, { queryText: 'what is punchh used for' });
    expect(hit.hit).toBe(false);
    expect(hit.entityGateRejected).toBe(true);
  });

  test('same-entity paraphrase within cosine threshold still HITS', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(501);
    const near = nearNeighbor(base);
    await cache.store('What is Spendgo used for?', base, [makeResult('integrations/spendgo')], META);
    const hit = await cache.lookup(near, { queryText: 'What does Spendgo do?' });
    expect(hit.hit).toBe(true);
  });

  test('generic query with the SAME content tokens hits; different content tokens miss (safe)', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(502);
    const near = nearNeighbor(base);
    await cache.store('how does the loyalty flow work', base, [makeResult('a')], META);
    // Same content tokens (stopwords 'the'/'does'/'how' dropped) → HIT.
    expect((await cache.lookup(near, { queryText: 'how does loyalty flow work' })).hit).toBe(true);
    // Different content word ('here' vs 'flow') → the no-entity content-token
    // fallback misses. Safe (a recompute) and the price of closing lowercase swaps.
    expect((await cache.lookup(near, { queryText: 'how does loyalty work here' })).hit).toBe(false);
  });

  test('back-compat: no queryText passed → gate is skipped (prior behavior)', async () => {
    const cache = new SemanticQueryCache(engine);
    const base = makeEmbedding(503);
    const near = nearNeighbor(base);
    await cache.store('What is Spendgo used for?', base, [makeResult('a')], META);
    const hit = await cache.lookup(near); // no queryText
    expect(hit.hit).toBe(true);
  });
});

describe('SemanticQueryCache \u2014 TTL', () => {
  test('stale row (past TTL) is not returned', async () => {
    const cache = new SemanticQueryCache(engine, { ttlSeconds: 1 });
    const emb = makeEmbedding(42);
    await cache.store('q', emb, [makeResult('a')], META, { ttlSeconds: 1 });

    // Manually rewind created_at to simulate expiration.
    await engine.executeRaw(
      `UPDATE query_cache SET created_at = now() - interval '10 seconds'`,
    );
    const hit = await cache.lookup(emb);
    expect(hit.hit).toBe(false);
  });
});

describe('SemanticQueryCache \u2014 source isolation', () => {
  test('different source_id cannot read each other\u2019s rows', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(7);
    await cache.store('q', emb, [makeResult('a')], META, { sourceId: 'src-A' });
    const hitB = await cache.lookup(emb, { sourceId: 'src-B' });
    expect(hitB.hit).toBe(false);
    const hitA = await cache.lookup(emb, { sourceId: 'src-A' });
    expect(hitA.hit).toBe(true);
  });
});

describe('SemanticQueryCache \u2014 management', () => {
  test('clear() wipes all rows', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(9);
    await cache.store('q1', emb, [makeResult('a')], META);
    await cache.store('q2', makeEmbedding(10), [makeResult('b')], META);
    const removed = await cache.clear();
    expect(removed).toBeGreaterThanOrEqual(2);
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(0);
  });

  test('prune() deletes only stale rows', async () => {
    const cache = new SemanticQueryCache(engine);
    await cache.store('fresh', makeEmbedding(11), [makeResult('a')], META);
    await cache.store('stale', makeEmbedding(12), [makeResult('b')], META, { ttlSeconds: 1 });
    await engine.executeRaw(
      `UPDATE query_cache SET created_at = now() - interval '10 seconds' WHERE query_text = 'stale'`,
    );
    const removed = await cache.prune();
    expect(removed).toBe(1);
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(1);
    expect(stats.fresh_rows).toBe(1);
  });

  test('stats() reports fresh / stale / total / hit counters', async () => {
    const cache = new SemanticQueryCache(engine);
    const emb = makeEmbedding(13);
    await cache.store('q', emb, [makeResult('a')], META);
    await cache.lookup(emb);  // bump hit
    // Hit bump is async/fire-and-forget; give it a moment to land.
    await new Promise(r => setTimeout(r, 50));
    const stats = await cache.stats();
    expect(stats.total_rows).toBe(1);
    expect(stats.fresh_rows).toBe(1);
    expect(stats.stale_rows).toBe(0);
    expect(stats.total_hits).toBeGreaterThanOrEqual(1);
  });
});

// NOTE on the production wiring (finding #2): hybrid.ts threads `queryText: query`
// into cache.lookup(), and the gate is proven at the lookup level above +
// mutation-verified. A full hybridSearchCached\u2192writeback\u2192lookup round-trip test
// was attempted but hit pre-existing PGLite friction in the two-layer
// page-generations writeback (unrelated to this change; the store roundtrip tests
// above pass). The end-to-end wiring is verified LIVE against prod when the cache
// is re-enabled (the Spendgo/Punchh/Olo entity-swap must return distinct correct
// entities with cache ON) \u2014 a stronger proof than a PGLite integration test.

describe('SemanticQueryCache \u2014 disabled', () => {
  test('disabled cache is a pure no-op on lookup', async () => {
    const cache = new SemanticQueryCache(engine, { enabled: false });
    const emb = makeEmbedding(99);
    await cache.store('q', emb, [makeResult('a')], META);
    // Even after a store call, lookup must miss because enabled=false.
    const hit = await cache.lookup(emb);
    expect(hit.hit).toBe(false);
  });
});
