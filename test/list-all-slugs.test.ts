/**
 * v0.41 — unbounded / cursor-paginated slug enumeration ("enumeration cliff" fix).
 *
 * list_pages is hard-capped at 100 (clampSearchLimit(..., 50, 100)) with no
 * cursor, so reconciliation consumers silently truncate past row 100. This
 * suite pins the replacement primitive at two layers:
 *
 *   - engine.listAllSlugs (PGLite, in-memory): lossless enumeration past 100,
 *     stable keyset cursoring, slug_prefix / updated_after filters,
 *     live-vs-deleted visibility, and single + federated source scoping.
 *   - the list_all_slugs MCP op: { slugs, next_cursor } envelope, lossless
 *     cursor paging past 100, and source-scope threading via sourceScopeOpts
 *     (ctx.sourceId scalar + ctx.auth.allowedSources federated).
 *
 * PGLite in-memory — no Docker, no DATABASE_URL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); // in-memory
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  const tables = [
    'content_chunks', 'links', 'tags', 'raw_data',
    'timeline_entries', 'page_versions', 'ingest_log', 'pages',
  ];
  for (const t of tables) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
}

const basePage: PageInput = {
  type: 'concept',
  title: 'Test Page',
  compiled_truth: 'Body.',
  timeline: '',
  frontmatter: {},
};

/** Build an OperationContext stub for op-handler tests (cast as any at call). */
function makeCtx(extra: Record<string, unknown> = {}) {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...extra,
  };
}

// ─────────────────────────────────────────────────────────────────
// engine.listAllSlugs — the primitive
// ─────────────────────────────────────────────────────────────────

describe('PGLiteEngine: listAllSlugs', () => {
  beforeEach(truncateAll);

  test('returns the COMPLETE set past the list_pages 100-cap (no truncation)', async () => {
    // 150 pages > the 100 cap that list_pages/getAllSlugs-consumers hit.
    const expected: string[] = [];
    for (let i = 0; i < 150; i++) {
      const slug = `bulk/page-${String(i).padStart(3, '0')}`;
      expected.push(slug);
      await engine.putPage(slug, basePage);
    }
    // list_pages (capped) under-reports — this is the cliff being fixed.
    const capped = await engine.listPages({ sort: 'slug', limit: 100 });
    expect(capped.length).toBe(100);

    // listAllSlugs (no limit) returns every slug, slug-ordered.
    const all = await engine.listAllSlugs();
    expect(all.length).toBe(150);
    expect(all).toEqual([...expected].sort());
  });

  test('keyset cursor paging is lossless and gap-free across the full set', async () => {
    const expected: string[] = [];
    for (let i = 0; i < 150; i++) {
      const slug = `bulk/page-${String(i).padStart(3, '0')}`;
      expected.push(slug);
      await engine.putPage(slug, basePage);
    }
    const pageSize = 40;
    const collected: string[] = [];
    let after: string | undefined;
    let guard = 0;
    for (;;) {
      if (++guard > 100) throw new Error('cursor loop did not terminate');
      const page = await engine.listAllSlugs({ after, limit: pageSize });
      collected.push(...page);
      if (page.length < pageSize) break;
      after = page[page.length - 1];
    }
    expect(collected).toEqual([...expected].sort());
    // No duplicates introduced by the keyset.
    expect(new Set(collected).size).toBe(collected.length);
  });

  test('slug_prefix narrows the scan to one tier', async () => {
    await engine.putPage('capture/a', basePage);
    await engine.putPage('capture/b', basePage);
    await engine.putPage('people/alice', basePage);
    const captured = await engine.listAllSlugs({ slugPrefix: 'capture/' });
    expect(captured).toEqual(['capture/a', 'capture/b']);
  });

  test('slug_prefix treats LIKE metacharacters as literals', async () => {
    await engine.putPage('a_b/one', basePage);
    await engine.putPage('axb/two', basePage); // `_` must NOT match `x`
    const res = await engine.listAllSlugs({ slugPrefix: 'a_b/' });
    expect(res).toEqual(['a_b/one']);
  });

  test('updated_after filters to strictly-newer slugs', async () => {
    await engine.putPage('test/old', basePage);
    await new Promise(r => setTimeout(r, 10));
    const cutoff = new Date().toISOString();
    await new Promise(r => setTimeout(r, 10));
    await engine.putPage('test/new', basePage);

    const recent = await engine.listAllSlugs({ updated_after: cutoff });
    expect(recent).toContain('test/new');
    expect(recent).not.toContain('test/old');
  });

  test('live-only by default; include_deleted opts the soft-deleted set back in', async () => {
    await engine.putPage('keep/live', basePage);
    await engine.putPage('gone/dead', basePage);
    await engine.softDeletePage('gone/dead');

    const live = await engine.listAllSlugs();
    expect(live).toContain('keep/live');
    expect(live).not.toContain('gone/dead');

    const withDeleted = await engine.listAllSlugs({ includeDeleted: true });
    expect(withDeleted).toContain('keep/live');
    expect(withDeleted).toContain('gone/dead');
  });

  test('empty brain returns []', async () => {
    expect(await engine.listAllSlugs()).toEqual([]);
  });
});

describe('PGLiteEngine: listAllSlugs source scoping', () => {
  beforeEach(async () => {
    await truncateAll();
    // 'default' is seeded by initSchema; register src-b before inserting into it.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    await engine.putPage('people/alice', basePage, { sourceId: 'default' });
    await engine.putPage('people/bob', basePage, { sourceId: 'src-b' });
    // Same slug in two sources — DISTINCT must collapse it under a union scope.
    await engine.putPage('shared/dup', basePage, { sourceId: 'default' });
    await engine.putPage('shared/dup', basePage, { sourceId: 'src-b' });
  });

  test('scalar sourceId returns only that source', async () => {
    const def = await engine.listAllSlugs({ sourceId: 'default' });
    expect(def).toEqual(['people/alice', 'shared/dup']);
    const b = await engine.listAllSlugs({ sourceId: 'src-b' });
    expect(b).toEqual(['people/bob', 'shared/dup']);
  });

  test('federated sourceIds array returns the deduped union', async () => {
    const union = await engine.listAllSlugs({ sourceIds: ['default', 'src-b'] });
    expect(union).toEqual(['people/alice', 'people/bob', 'shared/dup']);
    // shared/dup appears once despite existing in both sources (DISTINCT slug).
    expect(union.filter(s => s === 'shared/dup').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// list_all_slugs MCP op
// ─────────────────────────────────────────────────────────────────

describe('list_all_slugs MCP op', () => {
  beforeEach(truncateAll);

  test('registered with read scope', () => {
    const op = operationsByName.list_all_slugs;
    expect(op).toBeDefined();
    expect(op!.scope).toBe('read');
    expect(op!.mutating).toBeFalsy();
  });

  test('returns { slugs, next_cursor } and pages past 100 losslessly', async () => {
    const expected: string[] = [];
    for (let i = 0; i < 150; i++) {
      const slug = `bulk/page-${String(i).padStart(3, '0')}`;
      expected.push(slug);
      await engine.putPage(slug, basePage);
    }
    const op = operationsByName.list_all_slugs!;
    const ctx = makeCtx();

    const collected: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    for (;;) {
      if (++guard > 100) throw new Error('cursor loop did not terminate');
      const res = (await op.handler(ctx as any, {
        limit: 40,
        ...(cursor ? { cursor } : {}),
      })) as { slugs: string[]; next_cursor: string | null };
      expect(Array.isArray(res.slugs)).toBe(true);
      collected.push(...res.slugs);
      cursor = res.next_cursor;
      if (cursor === null) break;
    }
    expect(collected).toEqual([...expected].sort());
    expect(new Set(collected).size).toBe(collected.length);
  });

  test('next_cursor is null when a single page covers the whole set', async () => {
    await engine.putPage('only/one', basePage);
    const op = operationsByName.list_all_slugs!;
    const res = (await op.handler(makeCtx() as any, {})) as {
      slugs: string[];
      next_cursor: string | null;
    };
    expect(res.slugs).toEqual(['only/one']);
    expect(res.next_cursor).toBeNull();
  });

  test('limit is clamped to the max page size', async () => {
    const op = operationsByName.list_all_slugs!;
    await engine.putPage('x/1', basePage);
    // A wildly over-cap limit must not throw and must still return the set.
    const res = (await op.handler(makeCtx() as any, { limit: 10_000_000 })) as {
      slugs: string[];
      next_cursor: string | null;
    };
    expect(res.slugs).toEqual(['x/1']);
    expect(res.next_cursor).toBeNull();
  });

  test('honors slug_prefix + include_deleted params', async () => {
    await engine.putPage('capture/live', basePage);
    await engine.putPage('capture/dead', basePage);
    await engine.softDeletePage('capture/dead');
    await engine.putPage('people/alice', basePage);
    const op = operationsByName.list_all_slugs!;

    const liveOnly = (await op.handler(makeCtx() as any, {
      slug_prefix: 'capture/',
    })) as { slugs: string[] };
    expect(liveOnly.slugs).toEqual(['capture/live']);

    const withDeleted = (await op.handler(makeCtx() as any, {
      slug_prefix: 'capture/',
      include_deleted: true,
    })) as { slugs: string[] };
    expect(withDeleted.slugs).toEqual(['capture/dead', 'capture/live']);
  });
});

describe('list_all_slugs MCP op — source scope threading', () => {
  beforeEach(async () => {
    await truncateAll();
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('src-b', 'src-b', '{}'::jsonb) ON CONFLICT DO NOTHING`,
    );
    await engine.putPage('people/alice', basePage, { sourceId: 'default' });
    await engine.putPage('people/bob', basePage, { sourceId: 'src-b' });
  });

  test('ctx.sourceId scalar confines enumeration to that source', async () => {
    const op = operationsByName.list_all_slugs!;
    const res = (await op.handler(makeCtx({ sourceId: 'src-b' }) as any, {})) as {
      slugs: string[];
    };
    expect(res.slugs).toEqual(['people/bob']);
    expect(res.slugs).not.toContain('people/alice');
  });

  test('ctx.auth.allowedSources (federated read) widens to the union', async () => {
    const op = operationsByName.list_all_slugs!;
    const ctx = makeCtx({
      sourceId: 'default', // scalar alone would scope to default-only
      auth: {
        token: 'test',
        clientId: 'test',
        scopes: ['read'],
        sourceId: 'default',
        allowedSources: ['default', 'src-b'], // array wins
      },
    });
    const res = (await op.handler(ctx as any, {})) as { slugs: string[] };
    expect(res.slugs).toContain('people/alice');
    expect(res.slugs).toContain('people/bob');
  });
});
