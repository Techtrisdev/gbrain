/**
 * connector-context-mirror.test.ts — the Context Mirror SaaSConnector.
 *
 * Context Mirror is POLL-ONLY and INTERNAL: it has no external API and no webhook. Its
 * backfill reads the Brain's OWN `capture-events` pages (via engine.listPages) and lands
 * one candidate per page under the SAME source, feeding the existing consolidation pipeline.
 *
 * Focus areas (mirrors connector-granola.test.ts, swapping the fetch stub for a listPages
 * stub since there is no HTTP API):
 *
 *   normalize  — a capture Page → a generic-profile record; summary carries compiled_truth
 *     (+ timeline only when non-empty); sourceRecordId/proposedSlug = page slug.
 *   toCandidate — proposed_markdown = summary, version = '1', confidence = 0.9.
 *   backfill   — lists pages, lands candidates via the consolidate path, advances the
 *     watermark to the newest page; empty pages → returns 0 and writes no watermark; the
 *     re-poll is idempotent.
 *   redaction  — a secret-shaped string in the capture text is masked by strip() in the
 *     landing path.
 *   poll-only  — verifyWebhook fails closed, accountFromPayload returns null.
 *
 * Candidate writes + the surgical jsonb_set watermark write go through a fake engine that
 * captures params; engine.listPages is stubbed to return the capture pages under test.
 */

import { describe, test, expect, mock } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page, PageFilters } from '../src/core/types.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';

const { contextMirrorConnector, readWatermark } = await import(
  '../src/core/connectors/context-mirror.ts'
);

// ── Fake engine: captures connector_candidates INSERTs + the watermark jsonb_set ──
//   and stubs listPages with the capture pages supplied per test.

function makeFakeEngine(opts: { pages?: Page[] } = {}) {
  const inserts: {
    source_record_id: string;
    version: unknown;
    provider: unknown;
    proposed_slug: unknown;
    proposed_markdown: string;
    redactions: unknown[];
    allParams: unknown[];
  }[] = [];
  const watermarkWrites: { watermark: string; id: string }[] = [];
  const listPagesCalls: (PageFilters | undefined)[] = [];
  const seenKeys = new Set<string>();

  const executeRaw = async (sql: string, params?: unknown[]) => {
    const p = params ?? [];
    if (/INSERT INTO connector_candidates/.test(sql)) {
      const key = `${p[0]}|${p[1]}|${p[2]}`;
      if (seenKeys.has(key)) return []; // ON CONFLICT DO NOTHING
      seenKeys.add(key);
      inserts.push({
        source_record_id: p[1] as string,
        version: p[2],
        provider: p[4],
        proposed_slug: p[5],
        proposed_markdown: p[6] as string,
        redactions: p[8] as unknown[],
        allParams: p,
      });
      return [{ id: inserts.length }];
    }
    // ON CONFLICT re-fetch SELECT
    if (/SELECT .* FROM connector_candidates WHERE/.test(sql)) {
      return [];
    }
    // Surgical watermark write: jsonb_set(COALESCE(config,…),'{connectors,context_mirror,watermark}',…)
    if (/'\{connectors,context_mirror,watermark\}'/.test(sql)) {
      watermarkWrites.push({ watermark: p[0] as string, id: p[1] as string });
      return [];
    }
    // Consolidation load (SELECT config FROM sources …) + any other read → empty.
    return [];
  };

  const listPages = async (filters?: PageFilters) => {
    listPagesCalls.push(filters);
    return opts.pages ?? [];
  };

  const engine = {
    kind: 'pglite',
    executeRaw,
    listPages,
    transaction: (fn: (e: BrainEngine) => unknown) => fn(engine as BrainEngine),
  } as unknown as BrainEngine;
  return { engine, inserts, watermarkWrites, listPagesCalls };
}

const { landRecords } = await import('../src/core/connectors/base.ts');

function source(config: Record<string, unknown> = {}): ConnectorSource {
  return { id: 'capture-events', config };
}

/** Build a capture Page; only slug/compiled_truth/timeline/updated_at are read by the connector. */
function mkPage(p: { slug: string; compiled_truth?: string; timeline?: string; updated_at: string }): Page {
  return {
    id: 1,
    slug: p.slug,
    type: 'note',
    title: p.slug,
    compiled_truth: p.compiled_truth ?? '',
    timeline: p.timeline ?? '',
    frontmatter: {},
    created_at: new Date(p.updated_at),
    updated_at: new Date(p.updated_at),
  } as unknown as Page;
}

// ── Tests ─────────────────────────────────────────────────────────────────────────

describe('Context Mirror normalize', () => {
  test('capture page → generic record: summary carries compiled_truth, ids = slug', () => {
    const records = contextMirrorConnector.normalize(
      [mkPage({ slug: 'capture-events/2026-06-29-abc', compiled_truth: 'Decided to ship the mirror connector.', updated_at: '2026-06-29T10:00:00Z' })],
      source(),
    );
    expect(records.length).toBe(1);
    const r = records[0];
    expect(r.sourceRecordId).toBe('capture-events/2026-06-29-abc');
    expect(r.proposedSlug).toBe('capture-events/2026-06-29-abc');
    expect(r.profile).toBe('generic');
    expect(r.item.sourceRecordId).toBe('capture-events/2026-06-29-abc');
    expect(r.item.summary).toBe('Decided to ship the mirror connector.');
    // body is never carried (only the summary can reach a candidate)
    expect(r.item.body).toBeUndefined();
  });

  test('timeline is appended (blank-line separated) only when non-empty', () => {
    const withTimeline = contextMirrorConnector.normalize(
      [mkPage({ slug: 's1', compiled_truth: 'Compiled.', timeline: '## Timeline\n- 2026-06-29 noted', updated_at: '2026-06-29T10:00:00Z' })],
      source(),
    );
    expect(withTimeline[0].item.summary).toBe('Compiled.\n\n## Timeline\n- 2026-06-29 noted');

    const emptyTimeline = contextMirrorConnector.normalize(
      [mkPage({ slug: 's2', compiled_truth: 'Compiled only.', timeline: '   ', updated_at: '2026-06-29T10:00:00Z' })],
      source(),
    );
    // whitespace-only timeline is treated as empty — no blank line appended
    expect(emptyTimeline[0].item.summary).toBe('Compiled only.');
  });

  test('a page with no slug is skipped (defensive)', () => {
    const records = contextMirrorConnector.normalize(
      [{ slug: undefined } as unknown as Page, mkPage({ slug: 'ok', compiled_truth: 'x', updated_at: '2026-06-29T10:00:00Z' })],
      source(),
    );
    expect(records.map((r) => r.sourceRecordId)).toEqual(['ok']);
  });
});

describe('Context Mirror toCandidate', () => {
  test('proposed_markdown = summary, version = 1, confidence = 0.9, slug + ids set', () => {
    const [record] = contextMirrorConnector.normalize(
      [mkPage({ slug: 'capture-events/x', compiled_truth: 'body text', updated_at: '2026-06-29T10:00:00Z' })],
      source(),
    );
    const cand = contextMirrorConnector.toCandidate(record, 'capture-events');
    expect(cand.source_id).toBe('capture-events');
    expect(cand.source_record_id).toBe('capture-events/x');
    expect(cand.version).toBe('1');
    expect(cand.provider).toBe('context_mirror');
    expect(cand.proposed_slug).toBe('capture-events/x');
    expect(cand.proposed_markdown).toBe('body text');
    expect(cand.confidence).toBe(0.9);
  });
});

describe('Context Mirror backfill', () => {
  test('lists pages, lands a candidate per page, advances the watermark to the newest', async () => {
    const pages = [
      mkPage({ slug: 'capture-events/older', compiled_truth: 'first capture', updated_at: '2026-06-28T09:00:00Z' }),
      mkPage({ slug: 'capture-events/newer', compiled_truth: 'second capture', updated_at: '2026-06-29T09:00:00Z' }),
    ];
    const { engine, inserts, watermarkWrites, listPagesCalls } = makeFakeEngine({ pages });

    const landed = await contextMirrorConnector.backfill!(engine, source());
    expect(landed).toBe(2);
    expect(inserts.map((i) => i.source_record_id).sort()).toEqual(['capture-events/newer', 'capture-events/older']);
    // candidate body = capture text; provider/version/slug correct
    expect(inserts.every((i) => i.provider === 'context_mirror')).toBe(true);
    expect(inserts.every((i) => i.version === '1')).toBe(true);
    // listPages scoped to the source, oldest-first, no watermark on first run
    expect(listPagesCalls.length).toBe(1);
    expect(listPagesCalls[0]).toEqual({ sourceId: 'capture-events', updated_after: undefined, slugPrefix: undefined, sort: 'updated_asc' });
    // watermark advanced to the NEWEST page (last in updated_asc order), normalized to UTC
    expect(watermarkWrites.at(-1)?.watermark).toBe('2026-06-29T09:00:00.000Z');
    expect(watermarkWrites.at(-1)?.id).toBe('capture-events');
  });

  test('passes the stored watermark as updated_after on a later poll', async () => {
    const { engine, listPagesCalls } = makeFakeEngine({ pages: [] });
    await contextMirrorConnector.backfill!(
      engine,
      source({ connectors: { context_mirror: { watermark: '2026-06-29T00:00:00.000Z' } } }),
    );
    expect(listPagesCalls[0]?.updated_after).toBe('2026-06-29T00:00:00.000Z');
  });

  test('read_slug_prefix scopes listPages to distilled captures only (never raw per-turn)', async () => {
    const { engine, listPagesCalls } = makeFakeEngine({ pages: [] });
    await contextMirrorConnector.backfill!(
      engine,
      source({ connectors: { context_mirror: { read_slug_prefix: 'distilled/' } } }),
    );
    expect(listPagesCalls[0]?.slugPrefix).toBe('distilled/');
  });

  test('empty page set → returns 0 and writes NO watermark', async () => {
    const { engine, inserts, watermarkWrites } = makeFakeEngine({ pages: [] });
    const landed = await contextMirrorConnector.backfill!(engine, source());
    expect(landed).toBe(0);
    expect(inserts.length).toBe(0);
    expect(watermarkWrites.length).toBe(0);
  });

  test('works when invoked UNBOUND (poll.ts does `const backfill = connector.backfill; backfill(...)`)', async () => {
    // poll.ts captures the backfill fn into a local and calls it without the connector as
    // receiver, so `this` is undefined inside backfill. The connector must NOT rely on `this`.
    const pages = [mkPage({ slug: 'capture-events/unbound', compiled_truth: 'capture body', updated_at: '2026-06-29T09:00:00Z' })];
    const { engine, inserts, watermarkWrites } = makeFakeEngine({ pages });
    const backfill = contextMirrorConnector.backfill!; // unbound reference, exactly like poll.ts
    const landed = await backfill(engine, source());
    expect(landed).toBe(1);
    expect(inserts.length).toBe(1);
    expect(inserts[0].provider).toBe('context_mirror');
    expect(watermarkWrites.at(-1)?.watermark).toBe('2026-06-29T09:00:00.000Z');
  });

  test('re-running backfill is idempotent (ON CONFLICT — no duplicate candidates)', async () => {
    const pages = [mkPage({ slug: 'capture-events/dup', compiled_truth: 's', updated_at: '2026-06-29T09:00:00Z' })];
    const { engine, inserts } = makeFakeEngine({ pages });
    const cfg = source();
    await contextMirrorConnector.backfill!(engine, cfg);
    await contextMirrorConnector.backfill!(engine, cfg);
    expect(inserts.length).toBe(1); // second run dedupes
  });
});

describe('Context Mirror redaction', () => {
  test('a secret-shaped string in the capture text is masked by strip() in the landing path', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = contextMirrorConnector.normalize(
      [mkPage({ slug: 'capture-events/sec', compiled_truth: 'deploy key AKIAIOSFODNN7EXAMPLE noted', updated_at: '2026-06-29T09:00:00Z' })],
      source(),
    );
    await landRecords(engine, 'capture-events', contextMirrorConnector, records);
    expect(inserts[0].proposed_markdown).toContain('[REDACTED]');
    expect(inserts[0].proposed_markdown).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('Context Mirror config + poll-only contract', () => {
  test('readWatermark: value when set, null on first run', () => {
    expect(readWatermark(source({ connectors: { context_mirror: { watermark: '2026-06-29T00:00:00.000Z' } } }))).toBe(
      '2026-06-29T00:00:00.000Z',
    );
    expect(readWatermark(source())).toBeNull();
  });

  test('verifyWebhook fails closed (no inbound webhooks)', () => {
    expect(contextMirrorConnector.verifyWebhook(Buffer.from(''), {}, 'secret')).toBe(false);
  });

  test('accountFromPayload returns null', () => {
    expect(contextMirrorConnector.accountFromPayload({})).toBeNull();
  });

  test('provider name is underscore-cased (matches /^[a-z0-9_]+$/)', () => {
    expect(contextMirrorConnector.provider).toBe('context_mirror');
    expect(/^[a-z0-9_]+$/.test(contextMirrorConnector.provider)).toBe(true);
  });
});

describe('Context Mirror live scheduling — distill_before_poll', () => {
  test('distill_before_poll=true distills (sourceId + idleHours) before consolidating; absent skips it', async () => {
    const distillSpy = mock(async (_engine: unknown, _opts: { sourceId?: string; idleHours?: number }) => ({
      source_id: 'capture-events', idle_hours_threshold: 6, dry_run: false,
    }));
    mock.module('../src/core/connectors/distill.ts', () => ({ distillCaptureSessions: distillSpy }));
    const { engine } = makeFakeEngine({ pages: [] });

    await contextMirrorConnector.backfill!(engine, source({ connectors: { context_mirror: {} } }));
    expect(distillSpy).toHaveBeenCalledTimes(0);

    await contextMirrorConnector.backfill!(
      engine,
      source({ connectors: { context_mirror: { distill_before_poll: true, distill_idle_hours: 3 } } }),
    );
    expect(distillSpy).toHaveBeenCalledTimes(1);
    expect(distillSpy.mock.calls[0]?.[1]).toMatchObject({ sourceId: 'capture-events', idleHours: 3 });
  });

  test('a distill failure is non-fatal — consolidation still proceeds', async () => {
    const distillSpy = mock(async () => {
      throw new Error('gateway down');
    });
    mock.module('../src/core/connectors/distill.ts', () => ({ distillCaptureSessions: distillSpy }));
    const { engine } = makeFakeEngine({ pages: [] });
    const landed = await contextMirrorConnector.backfill!(
      engine,
      source({ connectors: { context_mirror: { distill_before_poll: true } } }),
    );
    expect(landed).toBe(0); // empty pages → 0, but NO throw (failure isolated)
  });
});
