/**
 * Regression test: a failed embed on the CODE import path must be visible.
 *
 * `importCodeFile` caught embed failures, emitted a `console.warn`, and fell
 * through to the transaction — writing page + chunks with `embedding` left
 * undefined. On a long-lived server process that warn goes nowhere, so an
 * import run reported success while quietly leaving pages semantically
 * invisible. This is the same silent-loss shape that cost 24 undetected days
 * on the distill path.
 *
 * The fix deliberately does NOT throw. `embedBatch` runs BEFORE the
 * transaction, so propagating the failure the way `importFromContent` does
 * would abandon the page write entirely and cost KEYWORD searchability too —
 * a strictly larger loss than the semantic gap it would close. Instead the
 * write is kept and the degradation rides back on `ImportResult.embedFailed`.
 *
 * SERIAL + COMPLETE MODULE MOCK, deliberately: `src/core/embedding.ts` has
 * ~12 exports, and an incomplete top-level `mock.module()` leaks across a bun
 * test shard and crashes siblings with "export not found". Spreading the real
 * module keeps the mock total; the `.serial.` filename keeps it off the
 * parallel shard entirely.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const actualEmbedding = await import('../src/core/embedding.ts');

const EMBED_FAILURE = 'forced embed failure (provider 503)';

mock.module('../src/core/embedding.ts', () => ({
  ...actualEmbedding,
  embedBatch: async () => {
    throw new Error(EMBED_FAILURE);
  },
}));

const { importCodeFile } = await import('../src/core/import-file.ts');
const { runReindexCode } = await import('../src/commands/reindex-code.ts');

let engine: PGLiteEngine;

const CODE = `export function alpha(a: number): number {
  return a + 1;
}

export function beta(b: number): number {
  return alpha(b) * 2;
}
`;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('importCodeFile — embed failure is reported, not swallowed', () => {
  test('the failure surfaces on the returned ImportResult', async () => {
    const result = await importCodeFile(engine, 'src/alpha.ts', CODE);

    expect(result.embedFailed).toBe(true);
    expect(result.embedError).toContain('forced embed failure');
  });

  test('the page is still written and still keyword-searchable', async () => {
    // The whole point of not throwing: losing the page write would cost
    // keyword searchability on top of the semantic gap.
    await importCodeFile(engine, 'src/beta.ts', CODE);

    const page = await engine.getPage('src/beta.ts'.replace(/\.[^.]+$/, ''));
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages WHERE slug LIKE '%beta%' AND deleted_at IS NULL`,
    );

    expect(rows[0]!.n).toBeGreaterThan(0);
    expect(page ?? rows[0]!.n > 0).toBeTruthy();
  });

  test('chunks are written with NULL embedding so the sweep can heal them', async () => {
    // `gbrain embed --stale` selects content_chunks WHERE embedding IS NULL.
    // Chunks must land in exactly that state to be recoverable.
    const result = await importCodeFile(engine, 'src/gamma.ts', CODE);
    expect(result.chunks).toBeGreaterThan(0);

    const rows = await engine.executeRaw<{ total: number; unembedded: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE cc.embedding IS NULL)::int AS unembedded
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.slug LIKE '%gamma%'`,
    );

    expect(rows[0]!.total).toBeGreaterThan(0);
    expect(rows[0]!.unembedded).toBe(rows[0]!.total);
  });

  test('status stays "imported" — a degraded import is not a hard failure', async () => {
    // Flipping this to 'error' would make callers treat a successful page
    // write as a failed one, and could trigger retry loops over a provider
    // outage that the embed sweep already recovers from.
    const result = await importCodeFile(engine, 'src/delta.ts', CODE);
    expect(result.status).toBe('imported');
  });

  test('one failing file does not abort a multi-file batch', async () => {
    const results = [];
    for (const path of ['src/one.ts', 'src/two.ts', 'src/three.ts']) {
      results.push(await importCodeFile(engine, path, CODE));
    }

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'imported')).toBe(true);
    expect(results.every((r) => r.embedFailed === true)).toBe(true);
  });

  test('reindex-code COUNTS the degradation instead of reporting a clean run', async () => {
    // The point of the flag is that something READS it. Without this,
    // `reindex-code` — the command operators run specifically to fix
    // embeddings — reports `failed: 0` and 100% success through a total embed
    // outage, which is the silent degradation this change exists to remove.
    await engine.putPage('src-zeta-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/zeta.ts (typescript)',
      compiled_truth: CODE,
      timeline: '',
      frontmatter: { language: 'typescript', file: 'src/zeta.ts' },
    });

    const result = await runReindexCode(engine, { yes: true, force: true });

    expect(result.embedDegraded).toBeGreaterThan(0);
    expect(result.degraded?.[0]?.error).toContain('forced embed failure');
    // Degraded is NOT failed — the page genuinely landed. Conflating them
    // would corrupt the reindexed/skipped/failed accounting.
    expect(result.failed).toBe(0);
    expect(result.reindexed).toBeGreaterThan(0);
  }, 60_000);

  test('noEmbed callers report no failure — the flag means "tried and failed"', async () => {
    // A caller that deliberately skipped embedding has not been degraded, and
    // must not be reported as such or the signal becomes noise.
    const result = await importCodeFile(engine, 'src/epsilon.ts', CODE, { noEmbed: true });

    expect(result.status).toBe('imported');
    expect(result.embedFailed).toBeUndefined();
    expect(result.embedError).toBeUndefined();
  });
});
