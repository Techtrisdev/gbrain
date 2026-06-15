/**
 * Tests for src/core/connectors/candidate.ts (TECH-2031).
 *
 * Proves:
 *  1. toRow writes a row to connector_candidates.
 *  2. A second toRow with the same key is a no-op (idempotency).
 *  3. The candidate never appears in any search path (searchKeyword).
 *  4. No pages row is created.
 *  5. candidate.ts contains no page-writing API calls.
 *
 * Canonical PGLite block (R3 + R4 compliant):
 *   one engine per file, beforeEach resets data, afterAll disconnects.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  toRow,
  listCandidates,
  approveCandidate,
  rejectCandidate,
  needsRationale,
  registerPromotionHook,
  NEEDS_RATIONALE_CONFIDENCE,
  type PromotionHook,
} from '../src/core/connectors/candidate.ts';
import { readFileSync } from 'fs';
import { join } from 'path';

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
  await resetPgliteState(engine);
});

// ─────────────────────────────────────────────────────────────────
// Source-text guard (no page-writing APIs)
// ─────────────────────────────────────────────────────────────────
describe('candidate.ts source-text guard', () => {
  test('candidate.ts contains no put_page, ingest_capture, or upsertChunks call', () => {
    const src = readFileSync(
      join(import.meta.dir, '../src/core/connectors/candidate.ts'),
      'utf8',
    );
    // The only allowable occurrences are in comments.
    // Strip block and line comments, then verify the banned names are absent.
    const withoutComments = src
      .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
      .replace(/\/\/[^\n]*/g, '');         // line comments
    expect(withoutComments).not.toContain('put_page');
    expect(withoutComments).not.toContain('ingest_capture');
    expect(withoutComments).not.toContain('upsertChunks');
  });
});

// ─────────────────────────────────────────────────────────────────
// Candidate write + idempotency
// ─────────────────────────────────────────────────────────────────
describe('toRow: write and idempotency', () => {
  // Unique text used later to assert search absence.
  const DISTINCTIVE_TEXT = 'XQZR7B-connector-unique-text-not-in-any-page';

  const item: import('../src/core/connectors/candidate.ts').ConnectorCandidateItem = {
    source_id: 'default',
    source_record_id: 'rec-001',
    version: '1',
    provider: 'test-provider',
    proposed_slug: 'companies/acme-example',
    proposed_markdown: `# ACME Example\n\n${DISTINCTIVE_TEXT}\n\nAn example connector candidate.`,
    confidence: 0.95,
    source_record_ids: ['rec-001', 'rec-001b'],
    redactions: [{ field: 'email', reason: 'pii' }],
  };

  test('toRow inserts a row into connector_candidates', async () => {
    const { written, row } = await toRow(engine, item);

    expect(written).toBe(true);
    expect(row.id).toBeGreaterThan(0);
    expect(row.source_id).toBe('default');
    expect(row.source_record_id).toBe('rec-001');
    expect(row.version).toBe('1');
    expect(row.status).toBe('pending');

    // Verify via direct SQL read
    const rows = await engine.executeRaw<{ id: number; source_record_id: string; status: string }>(
      `SELECT id, source_record_id, status FROM connector_candidates WHERE source_id = 'default'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_record_id).toBe('rec-001');
    expect(rows[0].status).toBe('pending');
  });

  test('toRow is idempotent — second call with same key does not create a duplicate', async () => {
    const first = await toRow(engine, item);
    expect(first.written).toBe(true);

    const second = await toRow(engine, item);
    expect(second.written).toBe(false);

    // Row count must be 1, not 2
    const rows = await engine.executeRaw<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM connector_candidates WHERE source_id = 'default'`,
    );
    expect(rows[0].cnt).toBe('1');
  });

  test('toRow returns the existing row on the second call', async () => {
    const first = await toRow(engine, item);
    const second = await toRow(engine, item);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.source_record_id).toBe('rec-001');
  });

  test('toRow with a different version creates a second independent row', async () => {
    await toRow(engine, item);
    const v2 = await toRow(engine, { ...item, version: '2', proposed_markdown: 'v2 body' });
    expect(v2.written).toBe(true);

    const rows = await engine.executeRaw<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM connector_candidates WHERE source_id = 'default'`,
    );
    expect(rows[0].cnt).toBe('2');
  });
});

// ─────────────────────────────────────────────────────────────────
// No pages row created
// ─────────────────────────────────────────────────────────────────
describe('toRow: no pages row is created', () => {
  test('pages count is unchanged before and after toRow', async () => {
    const before = await engine.executeRaw<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM pages`,
    );
    const pagesBefore = parseInt(before[0].cnt, 10);

    await toRow(engine, {
      source_id: 'default',
      source_record_id: 'pages-guard-test',
      proposed_markdown: 'should not create a page',
    });

    const after = await engine.executeRaw<{ cnt: string }>(
      `SELECT count(*)::text AS cnt FROM pages`,
    );
    const pagesAfter = parseInt(after[0].cnt, 10);

    expect(pagesAfter).toBe(pagesBefore);
  });
});

// ─────────────────────────────────────────────────────────────────
// Search absence: candidate never surfaces in any search path
// ─────────────────────────────────────────────────────────────────
describe('toRow: candidate is absent from all search paths', () => {
  const DISTINCTIVE_TEXT = 'XQZR7B-connector-unique-text-not-in-any-page';
  const PROPOSED_SLUG = 'companies/acme-example-search-test';

  beforeEach(async () => {
    // Write the candidate
    await toRow(engine, {
      source_id: 'default',
      source_record_id: 'search-absence-test-001',
      proposed_slug: PROPOSED_SLUG,
      proposed_markdown: `# ACME\n\n${DISTINCTIVE_TEXT}`,
      provider: 'test-provider',
    });
  });

  test('(a) default search (no source filter) does not return the candidate', async () => {
    const results = await engine.searchKeyword(DISTINCTIVE_TEXT);
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain(PROPOSED_SLUG);
    // Also verify no result chunk_text contains the distinctive text
    const chunks = results.map(r => r.chunk_text ?? '');
    for (const chunk of chunks) {
      expect(chunk).not.toContain(DISTINCTIVE_TEXT);
    }
  });

  test('(b) source-scoped search does not return the candidate', async () => {
    const results = await engine.searchKeyword(DISTINCTIVE_TEXT, { sourceId: 'default' });
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain(PROPOSED_SLUG);
    // Also verify no result chunk_text contains the distinctive text
    const chunks_b = results.map(r => r.chunk_text ?? '');
    for (const chunk of chunks_b) {
      expect(chunk).not.toContain(DISTINCTIVE_TEXT);
    }
  });

  test('(c) broad federated-array search does not return the candidate', async () => {
    // sourceIds: ['default'] searches all federated sources — the broadest path.
    const results = await engine.searchKeyword(DISTINCTIVE_TEXT, { sourceIds: ['default'] });
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain(PROPOSED_SLUG);
    // Also verify no result chunk_text contains the distinctive text
    const chunks_c = results.map(r => r.chunk_text ?? '');
    for (const chunk of chunks_c) {
      expect(chunk).not.toContain(DISTINCTIVE_TEXT);
    }
  });

  test('(d) federated-client-shaped search (sourceIds array) does not return the candidate', async () => {
    // Simulate how a federated OAuth client would search multiple sources.
    const results = await engine.searchKeyword(DISTINCTIVE_TEXT, {
      sourceIds: ['default'],
      limit: 50,
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).not.toContain(PROPOSED_SLUG);
    // Ensure the proposed_markdown text is also not present in any chunk
    for (const r of results) {
      expect(r.chunk_text ?? '').not.toContain(DISTINCTIVE_TEXT);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// JSONB / TEXT[] round-trip sanity
// ─────────────────────────────────────────────────────────────────
describe('toRow: column types round-trip correctly', () => {
  test('source_record_ids TEXT[] and redactions JSONB survive a round-trip', async () => {
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'rtrip-001',
      source_record_ids: ['a', 'b', 'c'],
      redactions: [{ field: 'phone', reason: 'gdpr' }],
    });

    expect(Array.isArray(row.source_record_ids)).toBe(true);
    expect(row.source_record_ids).toEqual(['a', 'b', 'c']);
    expect(Array.isArray(row.redactions)).toBe(true);
    expect((row.redactions as Array<{ field: string }>)[0]?.field).toBe('phone');
  });

  test('confidence NULL when omitted', async () => {
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'conf-null-001',
    });
    expect(row.confidence).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Review queue (TECH-2036): needsRationale flag + list + reject + approve/promotion seam
// ─────────────────────────────────────────────────────────────────
describe('review queue: needsRationale flag (AC4)', () => {
  test('high-confidence with no rationale_ref → flagged', () => {
    expect(needsRationale({ confidence: 0.9, rationale_ref: null })).toBe(true);
    expect(needsRationale({ confidence: NEEDS_RATIONALE_CONFIDENCE, rationale_ref: null })).toBe(true);
  });
  test('high-confidence WITH a rationale_ref → not flagged', () => {
    expect(needsRationale({ confidence: 0.95, rationale_ref: 'takes/why-acme' })).toBe(false);
  });
  test('low-confidence → not flagged regardless of rationale', () => {
    expect(needsRationale({ confidence: 0.4, rationale_ref: null })).toBe(false);
    expect(needsRationale({ confidence: null, rationale_ref: null })).toBe(false);
  });
});

describe('review queue: listCandidates (AC3)', () => {
  beforeEach(async () => {
    await toRow(engine, { source_id: 'default', source_record_id: 'q-1', confidence: 0.9, proposed_markdown: 'cand one' });
    await toRow(engine, { source_id: 'default', source_record_id: 'q-2', confidence: 0.5, rationale_ref: 'takes/r', proposed_markdown: 'cand two' });
    await toRow(engine, { source_id: 'default', source_record_id: 'q-3', confidence: 0.95, proposed_markdown: 'cand three' });
  });

  test('lists pending candidates newest-first with the needs_rationale flag + source name', async () => {
    const { rows, total, page, pages } = await listCandidates(engine, { status: 'pending' });
    expect(total).toBe(3);
    expect(page).toBe(1);
    expect(pages).toBe(1);
    // newest-first (proposed_at DESC, id DESC): q-3 (last inserted) before q-1.
    const ids = rows.map((r) => r.source_record_id);
    expect(ids.indexOf('q-3')).toBeLessThan(ids.indexOf('q-1'));
    const q1 = rows.find((r) => r.source_record_id === 'q-1')!;
    expect(q1.needs_rationale).toBe(true); // 0.9, no rationale
    const q2 = rows.find((r) => r.source_record_id === 'q-2')!;
    expect(q2.needs_rationale).toBe(false); // has rationale
    // source_name is the joined sources.name (or null when unseeded) — the key is present.
    expect('source_name' in q1).toBe(true);
  });

  test('paginates (pageSize clamps the window; total/pages reflect the full set)', async () => {
    const p1 = await listCandidates(engine, { status: 'pending', page: 1, pageSize: 2 });
    expect(p1.rows).toHaveLength(2);
    expect(p1.total).toBe(3);
    expect(p1.pages).toBe(2);
    const p2 = await listCandidates(engine, { status: 'pending', page: 2, pageSize: 2 });
    expect(p2.rows).toHaveLength(1);
  });

  test('status filter excludes acted candidates', async () => {
    const before = await listCandidates(engine, { status: 'pending' });
    const target = before.rows[0];
    await rejectCandidate(engine, target.id, 'admin', 'dup');
    const after = await listCandidates(engine, { status: 'pending' });
    expect(after.total).toBe(2);
    const rejected = await listCandidates(engine, { status: 'rejected' });
    expect(rejected.total).toBe(1);
    expect(rejected.rows[0].id).toBe(target.id);
  });
});

describe('review queue: rejectCandidate (AC3)', () => {
  test('sets rejected + reason + actor/time audit; a second act is a guarded no-op', async () => {
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'rej-1', proposed_markdown: 'x' });
    const rejected = await rejectCandidate(engine, row.id, 'jonathan', 'not relevant');
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe('rejected');
    expect(rejected!.status_reason).toBe('not relevant');
    expect(rejected!.acted_by).toBe('jonathan');
    expect(rejected!.acted_at).not.toBeNull();
    // guarded by status='pending': a second act on the now-rejected row returns null.
    const again = await rejectCandidate(engine, row.id, 'jonathan', 'again');
    expect(again).toBeNull();
  });

  test('a secret pasted into the reject reason is stripped at the write boundary', async () => {
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'rej-2', proposed_markdown: 'x' });
    const rejected = await rejectCandidate(engine, row.id, 'admin', 'leak AKIAIOSFODNN7EXAMPLE here');
    expect(rejected!.status_reason).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(rejected!.status_reason).toContain('[REDACTED]');
  });
});

describe('review queue: approveCandidate + promotion seam (AC3 / TECH-2037 retriable)', () => {
  afterEach(() => registerPromotionHook(null));

  test('with NO hook registered → accepted + promotion pending (retriable, never lost)', async () => {
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'app-1', proposed_markdown: 'x' });
    const res = await approveCandidate(engine, row.id, 'admin');
    expect(res.row!.status).toBe('accepted');
    expect(res.row!.acted_by).toBe('admin');
    expect(res.promotion.invoked).toBe(false);
    expect(res.promotion.pending).toBe(true);
  });

  test('with a hook → it runs with the accepted row + actor and returns pr_url', async () => {
    const seen: { id: number; actor: string }[] = [];
    const hook: PromotionHook = async (_e, cand, actor) => {
      seen.push({ id: cand.id, actor });
      return { prUrl: 'https://github.com/x/y/pull/1' };
    };
    registerPromotionHook(hook);
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'app-2', proposed_markdown: 'x' });
    const res = await approveCandidate(engine, row.id, 'jarvis');
    expect(res.promotion.invoked).toBe(true);
    expect(res.promotion.prUrl).toBe('https://github.com/x/y/pull/1');
    expect(seen).toEqual([{ id: row.id, actor: 'jarvis' }]);
    expect(res.row!.status).toBe('accepted');
  });

  test('hook failure leaves the candidate accepted-pending (retriable), not lost', async () => {
    const hook: PromotionHook = async () => {
      throw new Error('brain bridge 503');
    };
    registerPromotionHook(hook);
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'app-3', proposed_markdown: 'x' });
    const res = await approveCandidate(engine, row.id, 'admin');
    expect(res.row!.status).toBe('accepted'); // committed before the bridge ran
    expect(res.promotion.invoked).toBe(false);
    expect(res.promotion.pending).toBe(true);
    expect(res.promotion.error).toContain('503');
  });

  test('approving a non-pending id is a guarded no-op (row null)', async () => {
    const res = await approveCandidate(engine, 999999, 'admin');
    expect(res.row).toBeNull();
  });
});
