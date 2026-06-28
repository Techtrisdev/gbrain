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

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  toRow,
  captureConsolidated,
  listCandidates,
  sweepExpiredCandidates,
  approveCandidate,
  resolveInboxTarget,
  rejectCandidate,
  needsRationale,
  coerceCandidateRow,
  registerPromotionHook,
  NEEDS_RATIONALE_CONFIDENCE,
  type ConnectorCandidateRow,
  type PromotionHook,
} from '../src/core/connectors/candidate.ts';
import {
  landRecords,
  type SaaSConnector,
  type NormalizedRecord,
} from '../src/core/connectors/base.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import {
  CONSOLIDATION_EXTRACT_SYSTEM,
  CONSOLIDATION_CLASSIFY_SYSTEM,
  compiledTruthHash,
} from '../src/core/connectors/consolidate.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { Page, SearchResult, SearchOpts } from '../src/core/types.ts';
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
  // Shard isolation: bun distributes individual TESTS across shards, so the U3
  // consolidation-seam tests can run first in a shard and inherit a leaked
  // chat/embed transport or gateway config from a prior file. The U3 describe's
  // afterEach only cleans up AFTER a test; establish a clean gateway baseline
  // before EVERY test so none inherits ambient state. resetGateway() nulls
  // _config + both transports; the explicit resets are belt-and-suspenders.
  resetGateway();
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null);
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

// ─────────────────────────────────────────────────────────────────
// U3 — self-cleaning queue: listCandidates expiry filter + the sweep
// ─────────────────────────────────────────────────────────────────
describe('U3 — listCandidates expiry filter', () => {
  test('excludes expired rows from BOTH the row list and the count; NULL + future still list', async () => {
    const past = new Date(Date.now() - 60_000); // expired a minute ago
    const future = new Date(Date.now() + 60 * 60 * 1000); // expires in an hour
    await toRow(engine, { source_id: 'default', source_record_id: 'exp-past', proposed_markdown: 'x', expires_at: past });
    await toRow(engine, { source_id: 'default', source_record_id: 'exp-future', proposed_markdown: 'x', expires_at: future });
    await toRow(engine, { source_id: 'default', source_record_id: 'exp-null', proposed_markdown: 'x' }); // expires_at NULL (back-compat)

    const { rows, total } = await listCandidates(engine, { status: 'pending' });
    const ids = rows.map((r) => r.source_record_id);
    expect(ids).toContain('exp-future');
    expect(ids).toContain('exp-null'); // legacy/non-consolidation rows always list
    expect(ids).not.toContain('exp-past'); // expired → filtered even before the sweep
    // Count query and row query agree (no "shows 3, returns 2" skew) — the predicate
    // is applied to both.
    expect(total).toBe(rows.length);
    expect(total).toBe(2);
  });
});

describe('U3 — sweepExpiredCandidates (self-cleaning)', () => {
  test('hard-deletes expired non-accepted rows, NEVER accepted, idempotent + counts', async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60 * 60 * 1000);
    // expired pending → swept
    await toRow(engine, { source_id: 'default', source_record_id: 'sw-pending', status: 'pending', proposed_markdown: 'x', expires_at: past });
    // expired rejected → swept
    await toRow(engine, { source_id: 'default', source_record_id: 'sw-rejected', status: 'rejected', proposed_markdown: 'x', expires_at: past });
    // expired ACCEPTED → NEVER swept (may have an in-flight/merged promotion PR)
    await toRow(engine, { source_id: 'default', source_record_id: 'sw-accepted', status: 'accepted', proposed_markdown: 'x', expires_at: past });
    // not yet expired + NULL TTL → survive
    await toRow(engine, { source_id: 'default', source_record_id: 'sw-future', status: 'pending', proposed_markdown: 'x', expires_at: future });
    await toRow(engine, { source_id: 'default', source_record_id: 'sw-null', status: 'pending', proposed_markdown: 'x' });

    const n1 = await sweepExpiredCandidates(engine);
    expect(n1).toBe(2); // the expired pending + the expired rejected

    const survivors = await engine.executeRaw<{ source_record_id: string }>(
      `SELECT source_record_id FROM connector_candidates WHERE source_id = 'default' ORDER BY source_record_id`,
    );
    const ids = survivors.map((r) => r.source_record_id);
    expect(ids).toContain('sw-accepted'); // the load-bearing guard: accepted survives expiry
    expect(ids).toContain('sw-future');
    expect(ids).toContain('sw-null');
    expect(ids).not.toContain('sw-pending');
    expect(ids).not.toContain('sw-rejected');

    // Idempotent: a second sweep with nothing newly expired removes 0.
    const n2 = await sweepExpiredCandidates(engine);
    expect(n2).toBe(0);
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

  // TECH-2109: approveCandidate now takes a reviewer-selected target. Default 'inbox'.
  const INBOX: import('../src/core/connectors/promotion.ts').PromotionTarget = { kind: 'inbox', path: '' };

  test('with NO hook registered → accepted + promotion pending (retriable, never lost)', async () => {
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'app-1', proposed_markdown: 'x' });
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.row!.status).toBe('accepted');
    expect(res.row!.acted_by).toBe('admin');
    expect(res.promotion.invoked).toBe(false);
    expect(res.promotion.pending).toBe(true);
    // Target + artifact_hash are persisted in the SAME accept UPDATE.
    expect(res.row!.target_kind).toBe('inbox');
    expect(res.row!.artifact_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('with a hook → it runs with the accepted row + actor + target and returns pr_url', async () => {
    const seen: { id: number; actor: string; kind: string }[] = [];
    const hook: PromotionHook = async (_e, cand, actor, target) => {
      seen.push({ id: cand.id, actor, kind: target.kind });
      return { prUrl: 'https://github.com/x/y/pull/1' };
    };
    registerPromotionHook(hook);
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'app-2', proposed_markdown: 'x' });
    const res = await approveCandidate(engine, row.id, 'jarvis', INBOX);
    expect(res.promotion.invoked).toBe(true);
    expect(res.promotion.prUrl).toBe('https://github.com/x/y/pull/1');
    expect(seen).toEqual([{ id: row.id, actor: 'jarvis', kind: 'inbox' }]);
    expect(res.row!.status).toBe('accepted');
  });

  test('hook failure leaves the candidate accepted-pending (retriable), not lost', async () => {
    const hook: PromotionHook = async () => {
      throw new Error('brain bridge 503');
    };
    registerPromotionHook(hook);
    const { row } = await toRow(engine, { source_id: 'default', source_record_id: 'app-3', proposed_markdown: 'x' });
    const res = await approveCandidate(engine, row.id, 'admin', INBOX);
    expect(res.row!.status).toBe('accepted'); // committed before the bridge ran
    expect(res.promotion.invoked).toBe(false);
    expect(res.promotion.pending).toBe(true);
    expect(res.promotion.error).toContain('503');
  });

  test('approving a non-pending id is a guarded no-op (row null)', async () => {
    const res = await approveCandidate(engine, 999999, 'admin', INBOX);
    expect(res.row).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// Connector-management route SQL (TECH-2036): jsonb_set path binding
// Proves the exact statements /admin/api/connectors/:provider/{disconnect,config}
// run — a JS array bound as $::text[] for the jsonb_set path, to_jsonb($::boolean)
// for enabled, and $::jsonb for an object — work against the engine and are surgical
// (a sibling key like the webhook secret is preserved, never clobbered).
// ─────────────────────────────────────────────────────────────────
describe('resolveInboxTarget — default inbox path derivation (bridge inbox-path fix)', () => {
  const mkRow = (over: Partial<ConnectorCandidateRow> = {}): ConnectorCandidateRow => ({
    id: 11, source_id: 'default', source_record_id: 'rec', version: '1',
    source_record_ids: [], provider: 'granola',
    proposed_slug: 'granola-note-not_pIDrQnzk7ENW6c', proposed_markdown: 'x', confidence: 0.9,
    redactions: [], expires_at: null, as_of: new Date('2026-06-18T15:02:03.441Z'),
    rationale_ref: null, status: 'pending', status_reason: null, acted_by: null, acted_at: null,
    superseded_by: null, target_kind: null, target_path: null, promotion_status: null,
    promotion_pr_url: null, promotion_branch: null, promoted_at: null, artifact_hash: null,
    base_compiled_hash: null, timeline_entry: null, classification: null,
    proposed_at: new Date('2026-06-18T15:02:03.441Z'), ...over,
  });
  // The Brain receiver's contract (promote_candidate.py _INBOX_PATH_RE) that REJECTED the empty path.
  const INBOX_RE = /^inbox\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

  test('default inbox (empty path) → canonical inbox/YYYY-MM-DD-<slug>.md, slug sanitized', () => {
    const out = resolveInboxTarget(mkRow(), { kind: 'inbox', path: '' });
    expect(out.path).toBe('inbox/2026-06-18-granola-note-not-pidrqnzk7enw6c.md');
    expect(out.path).toMatch(INBOX_RE); // now passes the schema that rejected ''
  });

  test('uses as_of, falling back to proposed_at when as_of is null', () => {
    const out = resolveInboxTarget(
      mkRow({ as_of: null, proposed_at: new Date('2026-01-05T00:00:00Z'), proposed_slug: 'foo' }),
      { kind: 'inbox', path: '' },
    );
    expect(out.path).toBe('inbox/2026-01-05-foo.md');
  });

  test('null/blank slug → stable <provider>-<id> fallback, still schema-valid', () => {
    const out = resolveInboxTarget(mkRow({ proposed_slug: null, id: 42 }), { kind: 'inbox', path: '' });
    expect(out.path).toBe('inbox/2026-06-18-granola-42.md');
    expect(out.path).toMatch(INBOX_RE);
  });

  test('inbox already pathed by the reviewer → returned unchanged', () => {
    const t = { kind: 'inbox' as const, path: 'inbox/2026-06-18-custom.md' };
    expect(resolveInboxTarget(mkRow(), t)).toBe(t);
  });

  test('existing_page → returned unchanged (never derived)', () => {
    const t = { kind: 'existing_page' as const, path: 'projects/x.md' };
    expect(resolveInboxTarget(mkRow(), t)).toBe(t);
  });

  test('extreme/out-of-4-digit-year as_of → falls back, path stays receiver-valid (adv-1)', () => {
    const out = resolveInboxTarget(
      mkRow({ as_of: new Date(8.64e15), proposed_at: new Date('2026-03-09T00:00:00Z'), proposed_slug: 'foo' }),
      { kind: 'inbox', path: '' },
    );
    expect(out.path).toBe('inbox/2026-03-09-foo.md');
    expect(out.path).toMatch(INBOX_RE);
  });

  test('NaN as_of → falls back to proposed_at', () => {
    const out = resolveInboxTarget(
      mkRow({ as_of: new Date('not-a-date'), proposed_at: new Date('2026-03-09T00:00:00Z'), proposed_slug: 'foo' }),
      { kind: 'inbox', path: '' },
    );
    expect(out.path).toBe('inbox/2026-03-09-foo.md');
  });

  test('hostile/edge slugs all sanitize to a receiver-valid path confined to inbox/', () => {
    const cases = ['../../etc/passwd', 'a/b', 'a b', '日本語', '***', '-foo-', 'A'.repeat(200)];
    for (const slug of cases) {
      const out = resolveInboxTarget(mkRow({ proposed_slug: slug }), { kind: 'inbox', path: '' });
      expect(out.path).toMatch(INBOX_RE);          // [a-z0-9-] only — no traversal survives
      expect(out.path!.startsWith('inbox/')).toBe(true);
      expect(out.path).not.toContain('..');
      expect(out.path).not.toContain('/etc/');
    }
  });
});

describe('connector config jsonb_set (route SQL primitive)', () => {
  beforeEach(async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
      ['src-cfg', 'cfg source', { connectors: { linear: { enabled: true, account: 'acme', secret: 'sek' } } }],
    );
  });

  const readCfg = async () => {
    const [row] = await engine.executeRaw<{ config: Record<string, unknown> | string }>(
      `SELECT config FROM sources WHERE id = 'src-cfg'`,
    );
    return (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as any;
  };

  test('disconnect: jsonb_set on a text[]-bound path disables in place, preserving siblings', async () => {
    await engine.executeRaw(
      `UPDATE sources SET config = jsonb_set(config, $2::text[], 'false'::jsonb, true) WHERE id = $1`,
      ['src-cfg', ['connectors', 'linear', 'enabled']],
    );
    const cfg = await readCfg();
    expect(cfg.connectors.linear.enabled).toBe(false);
    expect(cfg.connectors.linear.secret).toBe('sek'); // surgical — secret untouched
    expect(cfg.connectors.linear.account).toBe('acme');
  });

  test('config: to_jsonb($::boolean) for enabled + $::jsonb for a selection object', async () => {
    await engine.executeRaw(
      `UPDATE sources SET config = jsonb_set(config, $2::text[], to_jsonb($3::boolean), true) WHERE id = $1`,
      ['src-cfg', ['connectors', 'linear', 'enabled'], false],
    );
    await engine.executeRaw(
      `UPDATE sources SET config = jsonb_set(config, $2::text[], $3::jsonb, true) WHERE id = $1`,
      ['src-cfg', ['connectors', 'linear', 'selection'], { labels: ['bug', 'feature'] }],
    );
    const cfg = await readCfg();
    expect(cfg.connectors.linear.enabled).toBe(false);
    expect(cfg.connectors.linear.selection).toEqual({ labels: ['bug', 'feature'] });
    expect(cfg.connectors.linear.account).toBe('acme'); // sibling preserved across both writes
  });

  test('F1: config parent-ensure makes a leaf write persist on a source with NO connectors key', async () => {
    // Without the parent-ensure, jsonb_set on a deep path is a SILENT no-op when the
    // intermediate `connectors` object is absent — the route would return 200 'updated'
    // having written nothing. Prove the COALESCE-merge pre-create fixes it, and that a
    // pre-existing sibling (a secret) survives.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
      ['src-fresh', 'fresh source', { webhook_secret: 'TOPSECRET' }],
    );
    // The route's parent-ensure pre-write (creates connectors + connectors.slack as {}).
    await engine.executeRaw(
      `UPDATE sources SET config = jsonb_set(
         jsonb_set(config, '{connectors}', COALESCE(config->'connectors', '{}'::jsonb), true),
         $2::text[], COALESCE(config #> $2, '{}'::jsonb), true
       ) WHERE id = $1`,
      ['src-fresh', ['connectors', 'slack']],
    );
    // The leaf write now persists (parent exists).
    await engine.executeRaw(
      `UPDATE sources SET config = jsonb_set(config, $2::text[], to_jsonb($3::boolean), true) WHERE id = $1`,
      ['src-fresh', ['connectors', 'slack', 'enabled'], true],
    );
    const [row] = await engine.executeRaw<{ config: Record<string, unknown> | string }>(
      `SELECT config FROM sources WHERE id = 'src-fresh'`,
    );
    const cfg = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as any;
    expect(cfg.connectors.slack.enabled).toBe(true); // the leaf actually persisted
    expect(cfg.webhook_secret).toBe('TOPSECRET'); // pre-existing sibling preserved
  });
});

describe('coerceCandidateRow — BigInt id serialization (TECH-2120)', () => {
  test('coerces a BigInt id + superseded_by to number, leaving the row JSON-serializable', () => {
    // The Postgres driver returns bigint columns as JS BigInt; res.json / JSON.stringify throw
    // on a BigInt (the TECH-2120 500 on every admin approve/reject/list). The coercion must
    // produce a row that serializes cleanly.
    const raw = {
      id: BigInt(7), superseded_by: BigInt(3),
      source_id: 'default', source_record_id: 'r', version: '1', source_record_ids: [],
      provider: 'x', proposed_slug: null, proposed_markdown: null, confidence: null,
      redactions: [], expires_at: null, as_of: null, rationale_ref: null,
      status: 'pending', status_reason: null, acted_by: null, acted_at: null,
      target_kind: null, target_path: null, promotion_status: null, promotion_pr_url: null,
      promotion_branch: null, promoted_at: null, artifact_hash: null,
    } as unknown as ConnectorCandidateRow;
    const coerced = coerceCandidateRow(raw);
    expect(typeof coerced.id).toBe('number');
    expect(coerced.id).toBe(7);
    expect(typeof coerced.superseded_by).toBe('number');
    expect(coerced.superseded_by).toBe(3);
    // The load-bearing assertion: a BigInt id would make this throw.
    expect(() => JSON.stringify(coerced)).not.toThrow();
    expect(JSON.parse(JSON.stringify(coerced)).id).toBe(7);
  });

  test('null superseded_by stays null; a plain-number id is unchanged', () => {
    const raw = { id: 4, superseded_by: null } as unknown as ConnectorCandidateRow;
    const coerced = coerceCandidateRow(raw);
    expect(coerced.id).toBe(4);
    expect(coerced.superseded_by).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────
// U3 — consolidation wired into landRecords + the full target persisted
//
// Drives the REAL U1→U2 pipeline through landRecords' POLL-only seam: chat is
// stubbed (routed by system prompt: extract vs classify), embedding is a ZE
// gateway + embed-transport stub, and searchVector/getPage are proxied over the
// real PGLite engine so candidate persistence (toRow, FKs, the decision log) is
// genuine while the classifier's inputs are controlled.
// ─────────────────────────────────────────────────────────────────
describe('U3 — landRecords consolidation seam + target persistence', () => {
  /** A granola-shaped poll-only connector (mirrors granola.ts:toCandidate). */
  const granolaLike: SaaSConnector = {
    provider: 'granola',
    signatureHeader: 'x-granola-unused',
    verifyWebhook: () => false,
    accountFromPayload: () => null,
    normalize: () => [],
    toCandidate: (record, sourceId) => ({
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      provider: 'granola',
      proposed_slug: record.proposedSlug,
      proposed_markdown: record.item.summary,
      confidence: 0.9,
    }),
  };

  /** Build a NormalizedRecord (a granola summary capture). */
  function rec(id: string, summary: string): NormalizedRecord {
    return {
      sourceRecordId: id,
      profile: 'docs',
      item: { sourceRecordId: id, summary, metadata: {} },
      proposedSlug: `granola-note-${id}`,
    };
  }

  /** Turn on consolidation for granola on the default source. */
  async function enableGranolaConsolidation(): Promise<void> {
    await engine.executeRaw(
      `UPDATE sources SET config = $1::jsonb WHERE id = 'default'`,
      [{ connectors: { granola: { enabled: true, consolidation_enabled: true } } }],
    );
  }

  function fakePage(slug: string, compiled_truth: string, source_id = 'shared'): Page {
    return {
      id: 1, slug, type: 'note', title: slug, compiled_truth, timeline: '',
      frontmatter: {}, created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'), source_id,
    };
  }
  function fakeHit(slug: string, score: number, source_id = 'shared'): SearchResult {
    return {
      slug, page_id: 1, title: slug, type: 'note',
      chunk_text: 'a chunk — NOT the page body', chunk_source: 'compiled_truth',
      chunk_id: 1, chunk_index: 0, score, stale: false, source_id,
    };
  }

  /** Proxy the real engine, overriding only searchVector/getPage so the classifier
   *  sees canned Tier-1 hits + decomposed pages while persistence stays real. */
  function withClassifierIO(
    real: BrainEngine,
    io: { hits?: SearchResult[]; pages?: Record<string, Page> },
  ): BrainEngine {
    return new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === 'searchVector') {
          return async (_emb: Float32Array, o?: SearchOpts): Promise<SearchResult[]> => {
            const scope = o?.sourceId;
            return (io.hits ?? []).filter((h) => scope == null || (h.source_id ?? 'default') === scope);
          };
        }
        if (prop === 'getPage') {
          return async (slug: string): Promise<Page | null> => io.pages?.[slug] ?? null;
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as BrainEngine;
  }

  /** ZE embedding gateway + embed stub so isAvailable('embedding') is true. */
  function configureEmbedding(): void {
    configureGateway({
      embedding_model: 'zeroentropyai:zembed-1',
      embedding_dimensions: 1280,
      env: { ZEROENTROPY_API_KEY: 'sk-fake' },
    });
    __setEmbedTransportForTests((async (args: { values: unknown[] }) => ({
      embeddings: args.values.map(() => Array.from({ length: 1280 }, () => 0.1)),
    })) as unknown as Parameters<typeof __setEmbedTransportForTests>[0]);
  }

  /** Install a chat transport routed by the system prompt (extract vs classify). */
  function stubChatRouting(handlers: {
    extract?: (opts: ChatOpts) => string;
    classify?: (opts: ChatOpts) => string;
  }): { calls: ChatOpts[] } {
    const calls: ChatOpts[] = [];
    __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
      calls.push(opts);
      let text = '';
      if (opts.system === CONSOLIDATION_EXTRACT_SYSTEM) text = handlers.extract?.(opts) ?? '';
      else if (opts.system === CONSOLIDATION_CLASSIFY_SYSTEM) text = handlers.classify?.(opts) ?? '';
      return {
        text, blocks: [], stopReason: 'end',
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub', providerId: 'test',
      };
    });
    return { calls };
  }

  afterEach(() => {
    __setChatTransportForTests(null);
    __setEmbedTransportForTests(null);
    resetGateway();
  });

  test('OFF: opts.consolidate with the connector flag disabled is byte-identical to the no-opts passthrough', async () => {
    // default source config has NO granola consolidation (reset → {federated:true}).
    const { calls } = stubChatRouting({ extract: () => JSON.stringify({ facts: ['x'], confidence: 1 }) });
    await landRecords(engine, 'default', granolaLike, [rec('plain-1', 'Same summary body.')]); // webhook-style (no opts)
    await landRecords(engine, 'default', granolaLike, [rec('gated-1', 'Same summary body.')], { consolidate: true });
    expect(calls.length).toBe(0); // gate (consolidation_enabled false) → no extraction
    const cols =
      'proposed_markdown, confidence, status, status_reason, target_kind, target_path, classification, timeline_entry, base_compiled_hash';
    const [plain] = await engine.executeRaw<Record<string, unknown>>(
      `SELECT ${cols} FROM connector_candidates WHERE source_record_id = 'plain-1'`,
    );
    const [gated] = await engine.executeRaw<Record<string, unknown>>(
      `SELECT ${cols} FROM connector_candidates WHERE source_record_id = 'gated-1'`,
    );
    expect(gated).toEqual(plain); // byte-identical content (consolidation columns all null, confidence 0.9)
    expect(gated.classification).toBeNull();
    expect(gated.confidence).toBe(0.9);
  });

  test('webhook/synchronous path (no consolidate flag) is structurally NOT consolidated, even with the connector flag ON', async () => {
    await enableGranolaConsolidation();
    const { calls } = stubChatRouting({ extract: () => JSON.stringify({ facts: ['x'], confidence: 1 }) });
    // No opts → the synchronous webhook-shaped call. The LLM must never run.
    const res = await landRecords(engine, 'default', granolaLike, [rec('wh-1', 'real durable content')]);
    expect(res.written).toBe(1);
    expect(calls.length).toBe(0);
    const [row] = await engine.executeRaw<{ classification: string | null }>(
      `SELECT classification FROM connector_candidates WHERE source_record_id = 'wh-1'`,
    );
    expect(row.classification).toBeNull(); // raw passthrough
  });

  test('idempotency pre-check: an already-landed tuple is skipped — no re-extraction, no LLM', async () => {
    await enableGranolaConsolidation();
    // A prior poll already landed this record.
    await toRow(engine, { source_id: 'default', source_record_id: 'idem-1', provider: 'granola', proposed_markdown: 'prior' });
    const { calls } = stubChatRouting({ extract: () => JSON.stringify({ facts: ['x'], confidence: 1 }) });
    const res = await landRecords(engine, 'default', granolaLike, [rec('idem-1', 'new content')], { consolidate: true });
    expect(res.written).toBe(0); // existing tuple → skipped, no new row
    expect(calls.length).toBe(0); // pre-check short-circuits BEFORE extraction (no re-pay)
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM connector_candidates WHERE source_record_id = 'idem-1'`,
    );
    expect(Number(n)).toBe(1);
  });

  test('NOOP (no-signal capture): row is classification=NOOP / status=rejected, off the pending queue + logged', async () => {
    await enableGranolaConsolidation();
    stubChatRouting({ extract: () => JSON.stringify({ facts: [], confidence: 0.7 }) }); // empty facts → NOOP, no classify LLM
    const res = await landRecords(engine, 'default', granolaLike, [rec('noop-1', 'hi — thanks, talk soon')], { consolidate: true });
    expect(res.written).toBe(1);
    const [row] = await engine.executeRaw<{ classification: string; status: string; status_reason: string; confidence: number }>(
      `SELECT classification, status, status_reason, confidence FROM connector_candidates WHERE source_record_id = 'noop-1'`,
    );
    expect(row.classification).toBe('NOOP');
    expect(row.status).toBe('rejected');
    expect(row.status_reason).toBe('NOOP');
    expect(row.confidence).toBeCloseTo(0.7, 5); // extraction confidence carried through
    // Off the pending queue — the existing status='pending' filter excludes it (no query change).
    const pending = await listCandidates(engine, { status: 'pending' });
    expect(pending.rows.find((r) => r.source_record_id === 'noop-1')).toBeUndefined();
    // Decision log recorded the NOOP, keyed on the tuple.
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM consolidation_decisions WHERE source_record_id = 'noop-1' AND classification = 'NOOP'`,
    );
    expect(Number(n)).toBe(1);
  });

  test('UPDATE: persists update_page + resolved .md path + merged body + timeline_entry + base_compiled_hash', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    const targetBody = 'Acme is a Series B customer.\n\nRenewal: pending.';
    const mergedBody = 'Acme is a Series B customer.\n\nRenewal: SIGNED (Q3).';
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['Acme signed the Q3 renewal'], confidence: 0.8 }),
      classify: () =>
        JSON.stringify({
          classification: 'UPDATE',
          targets: ['clients/acme'],
          merged_body: mergedBody,
          timeline_entry: '2026-06-27 — Renewal signed.',
          confidence: 0.82,
        }),
    });
    const wrapped = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.5, 'shared')],
      pages: { 'clients/acme': fakePage('clients/acme', targetBody, 'shared') },
    });
    const res = await landRecords(wrapped, 'default', granolaLike, [rec('upd-1', 'Acme renewal signed')], { consolidate: true });
    expect(res.written).toBe(1);
    const [row] = await engine.executeRaw<{
      classification: string; target_kind: string; target_path: string;
      proposed_markdown: string; timeline_entry: string; base_compiled_hash: string;
      confidence: number; status: string;
    }>(
      `SELECT classification, target_kind, target_path, proposed_markdown, timeline_entry,
              base_compiled_hash, confidence, status
         FROM connector_candidates WHERE source_record_id = 'upd-1'`,
    );
    expect(row.classification).toBe('UPDATE');
    expect(row.target_kind).toBe('update_page');
    expect(row.target_path).toBe('clients/acme.md'); // slug → repo path (U4/U5 use it directly)
    expect(row.proposed_markdown).toContain('SIGNED (Q3)'); // merged body persisted (via strip())
    expect(row.timeline_entry).toBe('2026-06-27 — Renewal signed.');
    // hash is over the FULL decomposed compiled_truth — the byte-identical twin of U5's parse.
    expect(row.base_compiled_hash).toBe(compiledTruthHash(targetBody));
    expect(row.confidence).toBeCloseTo(0.82, 5); // real classifier confidence, not the 0.9 default
    expect(row.status).toBe('pending');
  });

  test('single-writer-per-page (KTD9): a second same-batch UPDATE on an already-targeted page → NEEDS_REVIEW', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['a fact'], confidence: 0.8 }),
      classify: () =>
        JSON.stringify({
          classification: 'UPDATE',
          targets: ['clients/acme'],
          merged_body: 'Acme body, updated.',
          timeline_entry: '2026-06-27 — change.',
          confidence: 0.8,
        }),
    });
    const wrapped = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.5, 'shared')],
      pages: { 'clients/acme': fakePage('clients/acme', 'Acme body.', 'shared') },
    });
    // Two captures in ONE batch, both resolving to clients/acme.
    const res = await landRecords(wrapped, 'default', granolaLike, [rec('sw-a', 'cap a'), rec('sw-b', 'cap b')], { consolidate: true });
    expect(res.written).toBe(2);
    const rows = await engine.executeRaw<{ source_record_id: string; classification: string; target_kind: string | null; status: string; status_reason: string | null }>(
      `SELECT source_record_id, classification, target_kind, status, status_reason FROM connector_candidates WHERE source_record_id IN ('sw-a', 'sw-b')`,
    );
    const a = rows.find((r) => r.source_record_id === 'sw-a')!;
    const b = rows.find((r) => r.source_record_id === 'sw-b')!;
    expect(a.classification).toBe('UPDATE'); // first wins the page
    expect(a.target_kind).toBe('update_page');
    expect(a.status).toBe('pending'); // surfaced (0.8 >= 0.70 default)
    expect(b.classification).toBe('NEEDS_REVIEW'); // second downgraded (no competing writer)
    expect(b.target_kind).toBeNull();
    // U1: the single-writer downgrade lands OFF the pending queue too — a downgraded
    // double-writer should not pester the human either.
    expect(b.status).toBe('rejected');
    expect(b.status_reason).toBe('NEEDS_REVIEW');
    const pending = await listCandidates(engine, { status: 'pending' });
    expect(pending.rows.find((r) => r.source_record_id === 'sw-a')).toBeDefined();
    expect(pending.rows.find((r) => r.source_record_id === 'sw-b')).toBeUndefined();
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM connector_candidates WHERE target_kind = 'update_page' AND target_path = 'clients/acme.md'`,
    );
    expect(Number(n)).toBe(1); // exactly one in-flight update_page per page
  });

  test('redaction invariant: a secret in the classifier merged body is redacted by toRow before persistence', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['a fact'], confidence: 0.8 }),
      classify: () =>
        JSON.stringify({
          classification: 'UPDATE',
          targets: ['clients/acme'],
          merged_body: `Acme update. Leaked key ${secret} here.`,
          timeline_entry: '2026-06-27 — change.',
          confidence: 0.8,
        }),
    });
    const wrapped = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.5, 'shared')],
      pages: { 'clients/acme': fakePage('clients/acme', 'Acme body.', 'shared') },
    });
    await landRecords(wrapped, 'default', granolaLike, [rec('sec-1', 'cap')], { consolidate: true });
    const [row] = await engine.executeRaw<{ proposed_markdown: string }>(
      `SELECT proposed_markdown FROM connector_candidates WHERE source_record_id = 'sec-1'`,
    );
    expect(row.proposed_markdown).not.toContain(secret);
    expect(row.proposed_markdown).toContain('[REDACTED]');
  });

  test('degrade: an unexpected throw on one record lands it as raw passthrough AND the batch continues', async () => {
    await enableGranolaConsolidation();
    // Make ONLY the poison record's idempotency pre-check throw (a transient backend
    // hiccup). The degrade path's toRow INSERT (a different SQL) is unaffected.
    const failing = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[]) => {
            if (
              sql.includes('consolidation-idempotency-precheck') &&
              Array.isArray(params) &&
              params.includes('poison')
            ) {
              throw new Error('simulated transient DB failure on the pre-check');
            }
            return (target as unknown as BrainEngine).executeRaw(sql, params);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as BrainEngine;
    stubChatRouting({ extract: () => JSON.stringify({ facts: [], confidence: 0.7 }) }); // good record → NOOP
    const res = await landRecords(failing, 'default', granolaLike, [rec('poison', 'bad'), rec('good', 'ok')], { consolidate: true });
    expect(res.written).toBe(2); // both landed despite the throw on one
    const [poison] = await engine.executeRaw<{ classification: string | null }>(
      `SELECT classification FROM connector_candidates WHERE source_record_id = 'poison'`,
    );
    expect(poison.classification).toBeNull(); // degraded to raw passthrough
    const [good] = await engine.executeRaw<{ classification: string | null }>(
      `SELECT classification FROM connector_candidates WHERE source_record_id = 'good'`,
    );
    expect(good.classification).toBe('NOOP'); // batch continued + consolidated
  });

  test('decision log: one row per classification, keyed on the (source, record, version) tuple', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['a fact'], confidence: 0.8 }),
      classify: () =>
        JSON.stringify({
          classification: 'UPDATE',
          targets: ['clients/acme'],
          merged_body: 'Acme body, updated.',
          timeline_entry: '2026-06-27 — change.',
          confidence: 0.77,
        }),
    });
    const wrapped = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.5, 'shared')],
      pages: { 'clients/acme': fakePage('clients/acme', 'Acme body.', 'shared') },
    });
    await landRecords(wrapped, 'default', granolaLike, [rec('dl-1', 'cap')], { consolidate: true });
    const [row] = await engine.executeRaw<{ classification: string; target_path: string; confidence: number; model: string }>(
      `SELECT classification, target_path, confidence, model
         FROM consolidation_decisions WHERE source_record_id = 'dl-1' AND version = '1'`,
    );
    expect(row.classification).toBe('UPDATE');
    expect(row.target_path).toBe('clients/acme.md'); // the resolved repo path
    expect(row.confidence).toBeCloseTo(0.77, 5);
    expect(row.model).toBe('anthropic:claude-sonnet-4-6'); // resolved reasoning-tier fallback
  });

  test('MINOR-1: a loadConsolidation failure (config read) degrades the WHOLE batch to raw passthrough, no abort', async () => {
    await enableGranolaConsolidation();
    const { calls } = stubChatRouting({ extract: () => JSON.stringify({ facts: ['x'], confidence: 1 }) });
    // Fail the one-time source-config read inside loadConsolidation (which runs
    // OUTSIDE the per-record try/catch). An unguarded throw there would abort the
    // whole poll; KTD4 requires it degrade to passthrough instead.
    const failingLoad = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[]) => {
            if (/SELECT config FROM sources/i.test(sql)) {
              throw new Error('simulated sources-config read failure');
            }
            return (target as unknown as BrainEngine).executeRaw(sql, params);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as BrainEngine;
    const res = await landRecords(failingLoad, 'default', granolaLike, [rec('ld-1', 'a'), rec('ld-2', 'b')], { consolidate: true });
    expect(res.written).toBe(2); // batch NOT aborted — both records landed
    expect(calls.length).toBe(0); // consolidation disabled for the whole batch → no LLM
    const rows = await engine.executeRaw<{ classification: string | null }>(
      `SELECT classification FROM connector_candidates WHERE source_record_id IN ('ld-1', 'ld-2')`,
    );
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.classification === null)).toBe(true); // raw passthrough
  });

  test('MINOR-2: a decision-log write failure is non-fatal — the consolidated row persists, not re-degraded', async () => {
    await enableGranolaConsolidation();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {}); // silence the expected warning
    // Fail ONLY the decision-log INSERT (it runs AFTER the consolidated row is
    // already committed). It must not reach the outer degrade path.
    const failingLog = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'executeRaw') {
          return async (sql: string, params?: unknown[]) => {
            if (/INSERT INTO consolidation_decisions/i.test(sql)) {
              throw new Error('simulated decision-log write failure');
            }
            return (target as unknown as BrainEngine).executeRaw(sql, params);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as BrainEngine;
    stubChatRouting({ extract: () => JSON.stringify({ facts: [], confidence: 0.7 }) }); // empty facts → NOOP
    const res = await landRecords(failingLog, 'default', granolaLike, [rec('dlf-1', 'cap')], { consolidate: true });
    expect(res.written).toBe(1); // persisted, NOT re-degraded
    const [row] = await engine.executeRaw<{ classification: string; status: string; status_reason: string }>(
      `SELECT classification, status, status_reason FROM connector_candidates WHERE source_record_id = 'dlf-1'`,
    );
    expect(row.classification).toBe('NOOP'); // consolidated verdict intact (NOT a raw null)
    expect(row.status).toBe('rejected');
    expect(row.status_reason).toBe('NOOP');
    // Exactly one row — the degrade path did NOT run a second toRow.
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM connector_candidates WHERE source_record_id = 'dlf-1'`,
    );
    expect(Number(n)).toBe(1);
    // The audit row was dropped (the write failed) — but the candidate is intact.
    const [{ d }] = await engine.executeRaw<{ d: number }>(
      `SELECT count(*)::int AS d FROM consolidation_decisions WHERE source_record_id = 'dlf-1'`,
    );
    expect(Number(d)).toBe(0);
    errSpy.mockRestore();
  });

  // ── U1: NEEDS_REVIEW leaves the human review queue (the system absorbs ambiguity) ──
  test('U1: a NEEDS_REVIEW verdict lands rejected/NEEDS_REVIEW, OFF the pending queue, still logged', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['an ambiguous multi-topic fact'], confidence: 0.8 }),
      classify: () => JSON.stringify({ classification: 'NEEDS_REVIEW', confidence: 0.45 }),
    });
    const wrapped = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.5, 'shared')], // mid-band → escalate to the LLM
      pages: { 'clients/acme': fakePage('clients/acme', 'Acme body.', 'shared') },
    });
    const res = await landRecords(wrapped, 'default', granolaLike, [rec('nr-1', 'cap')], { consolidate: true });
    expect(res.written).toBe(1);
    const [row] = await engine.executeRaw<{ classification: string; status: string; status_reason: string; target_kind: string | null }>(
      `SELECT classification, status, status_reason, target_kind FROM connector_candidates WHERE source_record_id = 'nr-1'`,
    );
    expect(row.classification).toBe('NEEDS_REVIEW'); // classification preserved for audit
    expect(row.status).toBe('rejected'); // mirrors NOOP — off the pending queue
    expect(row.status_reason).toBe('NEEDS_REVIEW');
    expect(row.target_kind).toBeNull();
    // Absent from the default pending review (the human never triages it).
    const pending = await listCandidates(engine, { status: 'pending' });
    expect(pending.rows.find((r) => r.source_record_id === 'nr-1')).toBeUndefined();
    // Still recorded in the decision log (audit + Tier-1 calibration unaffected).
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM consolidation_decisions WHERE source_record_id = 'nr-1' AND classification = 'NEEDS_REVIEW'`,
    );
    expect(Number(n)).toBe(1);
  });

  // ── U2: confidence-gate ADD/UPDATE surfacing ──────────────────────────────
  test('U2: a low-confidence ADD (0.50 < 0.70 default) lands rejected/low_confidence, OFF pending, still logged', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['a novel fact'], confidence: 0.8 }),
      classify: () => JSON.stringify({ classification: 'ADD', confidence: 0.5 }),
    });
    const wrapped = withClassifierIO(engine, { hits: [fakeHit('clients/acme', 0.5, 'shared')] });
    const res = await landRecords(wrapped, 'default', granolaLike, [rec('lc-add-1', 'cap')], { consolidate: true });
    expect(res.written).toBe(1);
    const [row] = await engine.executeRaw<{ classification: string; status: string; status_reason: string; confidence: number }>(
      `SELECT classification, status, status_reason, confidence FROM connector_candidates WHERE source_record_id = 'lc-add-1'`,
    );
    expect(row.classification).toBe('ADD'); // classification KEPT (only the status changes)
    expect(row.status).toBe('rejected');
    expect(row.status_reason).toBe('low_confidence');
    expect(row.confidence).toBeCloseTo(0.5, 5);
    const pending = await listCandidates(engine, { status: 'pending' });
    expect(pending.rows.find((r) => r.source_record_id === 'lc-add-1')).toBeUndefined();
    const [{ n }] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM consolidation_decisions WHERE source_record_id = 'lc-add-1' AND classification = 'ADD'`,
    );
    expect(Number(n)).toBe(1); // decision log records it despite being held back
  });

  test('U2: a high-confidence ADD (0.93 >= 0.70) surfaces as a pending candidate (no over-suppression)', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['a novel durable fact'], confidence: 0.9 }),
      classify: () => JSON.stringify({ classification: 'ADD', confidence: 0.93 }),
    });
    const wrapped = withClassifierIO(engine, { hits: [fakeHit('clients/acme', 0.5, 'shared')] });
    await landRecords(wrapped, 'default', granolaLike, [rec('hc-add-1', 'cap')], { consolidate: true });
    const [row] = await engine.executeRaw<{ classification: string; status: string; status_reason: string | null; confidence: number }>(
      `SELECT classification, status, status_reason, confidence FROM connector_candidates WHERE source_record_id = 'hc-add-1'`,
    );
    expect(row.classification).toBe('ADD');
    expect(row.status).toBe('pending');
    expect(row.status_reason).toBeNull();
    expect(row.confidence).toBeCloseTo(0.93, 5);
    const pending = await listCandidates(engine, { status: 'pending' });
    expect(pending.rows.find((r) => r.source_record_id === 'hc-add-1')).toBeDefined();
  });

  test('U2: the surface threshold is read from config — raising it to 0.90 holds back a 0.87 UPDATE (target fields kept)', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    await engine.setConfig('connectors.consolidation_surface_min_confidence', '0.90');
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['a fact'], confidence: 0.8 }),
      classify: () =>
        JSON.stringify({
          classification: 'UPDATE',
          targets: ['clients/acme'],
          merged_body: 'Acme body, updated.',
          timeline_entry: '2026-06-27 — change.',
          confidence: 0.87,
        }),
    });
    const wrapped = withClassifierIO(engine, {
      hits: [fakeHit('clients/acme', 0.5, 'shared')],
      pages: { 'clients/acme': fakePage('clients/acme', 'Acme body.', 'shared') },
    });
    await landRecords(wrapped, 'default', granolaLike, [rec('cfg-upd-1', 'cap')], { consolidate: true });
    const [row] = await engine.executeRaw<{
      classification: string; status: string; status_reason: string;
      target_kind: string; target_path: string; base_compiled_hash: string; timeline_entry: string;
    }>(
      `SELECT classification, status, status_reason, target_kind, target_path, base_compiled_hash, timeline_entry
         FROM connector_candidates WHERE source_record_id = 'cfg-upd-1'`,
    );
    // 0.87 < configured 0.90 → held back, but the full UPDATE target survives for audit/recovery.
    expect(row.classification).toBe('UPDATE');
    expect(row.status).toBe('rejected');
    expect(row.status_reason).toBe('low_confidence');
    expect(row.target_kind).toBe('update_page');
    expect(row.target_path).toBe('clients/acme.md');
    expect(row.base_compiled_hash).not.toBeNull();
    expect(row.timeline_entry).toBe('2026-06-27 — change.');
    const pending = await listCandidates(engine, { status: 'pending' });
    expect(pending.rows.find((r) => r.source_record_id === 'cfg-upd-1')).toBeUndefined();
  });

  // ── U3: TTL stamped per disposition ───────────────────────────────────────
  test('U3: surfaced pending gets ~30d TTL; a held-back disposition gets ~7d TTL', async () => {
    await enableGranolaConsolidation();
    configureEmbedding();
    const DAY = 24 * 60 * 60 * 1000;

    // (a) a surfaced ADD (0.93 >= 0.70) → ~30 days.
    stubChatRouting({
      extract: () => JSON.stringify({ facts: ['a novel fact'], confidence: 0.9 }),
      classify: () => JSON.stringify({ classification: 'ADD', confidence: 0.93 }),
    });
    const wrapped = withClassifierIO(engine, { hits: [fakeHit('clients/acme', 0.5, 'shared')] });
    const before = Date.now();
    await landRecords(wrapped, 'default', granolaLike, [rec('ttl-surf', 'cap')], { consolidate: true });
    const after = Date.now();

    // (b) a held-back NOOP (empty facts) → ~7 days.
    stubChatRouting({ extract: () => JSON.stringify({ facts: [], confidence: 0.7 }) });
    await landRecords(engine, 'default', granolaLike, [rec('ttl-held', 'hi — thanks, talk soon')], { consolidate: true });

    const [surf] = await engine.executeRaw<{ expires_at: Date | string | null; status: string }>(
      `SELECT expires_at, status FROM connector_candidates WHERE source_record_id = 'ttl-surf'`,
    );
    const [held] = await engine.executeRaw<{ expires_at: Date | string | null; status: string }>(
      `SELECT expires_at, status FROM connector_candidates WHERE source_record_id = 'ttl-held'`,
    );
    expect(surf.status).toBe('pending');
    expect(held.status).toBe('rejected');
    expect(surf.expires_at).not.toBeNull();
    expect(held.expires_at).not.toBeNull();
    const surfMs = new Date(surf.expires_at as Date | string).getTime();
    const heldMs = new Date(held.expires_at as Date | string).getTime();
    // ~30 days out (generous window around the land time).
    expect(surfMs).toBeGreaterThan(before + 29 * DAY);
    expect(surfMs).toBeLessThan(after + 31 * DAY);
    // ~7 days out — distinctly shorter than the surfaced TTL.
    expect(heldMs).toBeGreaterThan(before + 6 * DAY);
    expect(heldMs).toBeLessThan(after + 8 * DAY);
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Multi-topic FAN-OUT (this plan): one capture → N targeted proposals.
  //   U2 — per-target keying (`<captureId>::<slug>`), distinct receiver branch
  //        names, per-verdict disposition + single-writer.
  //   U3 — re-poll idempotency: the prefix/`=` pre-check recognizes a fanned-out
  //        capture so a re-poll re-pays ZERO LLM calls.
  // ──────────────────────────────────────────────────────────────────────────
  describe('multi-topic fan-out — keying (U2) + re-poll idempotency (U3)', () => {
    /** Receiver branch name — a faithful replica of techtris-brain
     *  promote_candidate.py:branch_name (`promote/<provider>-<sha256("<sid>|<srid>")[:12]>`),
     *  used to assert that fan-out candidates land on DISTINCT branches (KTD4). */
    function receiverBranch(provider: string, sourceId: string, srid: string): string {
      const safe = provider.replace(/[^a-zA-Z0-9-]/g, '-');
      return `promote/${safe}-${compiledTruthHash(`${sourceId}|${srid}`).slice(0, 12)}`;
    }

    /** A classify handler emitting a 2-topic fan-out (UPDATE clients/acme + UPDATE integrations/olo). */
    const twoTopicFanout = (): string =>
      JSON.stringify([
        { classification: 'UPDATE', target: 'clients/acme', merged_body: 'Acme updated.', timeline_entry: '2026-06-27 — Acme.', confidence: 0.84 },
        { classification: 'UPDATE', target: 'integrations/olo', merged_body: 'Olo updated.', timeline_entry: '2026-06-27 — Olo.', confidence: 0.8 },
      ]);

    /** Classifier I/O exposing both topic pages as candidates. */
    const twoTopicIO = (): BrainEngine =>
      withClassifierIO(engine, {
        hits: [fakeHit('clients/acme', 0.55, 'shared'), fakeHit('integrations/olo', 0.5, 'shared')],
        pages: {
          'clients/acme': fakePage('clients/acme', 'Acme.', 'shared'),
          'integrations/olo': fakePage('integrations/olo', 'Olo.', 'shared'),
        },
      });

    test('U2: a 2-topic capture writes 2 candidate rows with distinct per-target source_record_id + 2 decision-log rows', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      stubChatRouting({
        extract: () => JSON.stringify({ facts: ['Acme signed', 'Olo webhook changed'], confidence: 0.8 }),
        classify: twoTopicFanout,
      });
      const res = await landRecords(twoTopicIO(), 'default', granolaLike, [rec('mt-1', 'Acme + Olo meeting')], { consolidate: true });
      expect(res.written).toBe(2); // fan-out → 2 rows from ONE capture
      const rows = await engine.executeRaw<{ source_record_id: string; classification: string; target_path: string }>(
        `SELECT source_record_id, classification, target_path FROM connector_candidates WHERE source_record_id LIKE 'mt-1::%' ORDER BY source_record_id`,
      );
      expect(rows.map((r) => r.source_record_id)).toEqual(['mt-1::clients/acme', 'mt-1::integrations/olo']);
      expect(rows.every((r) => r.classification === 'UPDATE')).toBe(true);
      expect(rows.map((r) => r.target_path).sort()).toEqual(['clients/acme.md', 'integrations/olo.md']);
      // NO bare-captureId row was written (the capture fanned out entirely).
      const [{ n: bare }] = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM connector_candidates WHERE source_record_id = 'mt-1'`,
      );
      expect(Number(bare)).toBe(0);
      // Two decision-log rows, one per target.
      const dl = await engine.executeRaw<{ source_record_id: string }>(
        `SELECT source_record_id FROM consolidation_decisions WHERE source_record_id LIKE 'mt-1::%' ORDER BY source_record_id`,
      );
      expect(dl.map((r) => r.source_record_id)).toEqual(['mt-1::clients/acme', 'mt-1::integrations/olo']);
    });

    test('U2: the two fan-out rows produce DISTINCT receiver branch names (the KTD2 collision guard)', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      stubChatRouting({
        extract: () => JSON.stringify({ facts: ['Acme', 'Olo'], confidence: 0.8 }),
        classify: twoTopicFanout,
      });
      await landRecords(twoTopicIO(), 'default', granolaLike, [rec('mt-br', 'cap')], { consolidate: true });
      const b1 = receiverBranch('granola', 'default', 'mt-br::clients/acme');
      const b2 = receiverBranch('granola', 'default', 'mt-br::integrations/olo');
      expect(b1).not.toBe(b2); // distinct branch ⇒ distinct PR ⇒ independent promotion
      expect(b1).toMatch(/^promote\/granola-[0-9a-f]{12}$/);
      expect(b2).toMatch(/^promote\/granola-[0-9a-f]{12}$/);
    });

    test('KTD2 guard: a captureId containing "::" degrades to raw passthrough — no fan-out keying, no false idempotency (review finding 1)', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      // classify WOULD fan out into 2 rows if the guard did not fire first.
      stubChatRouting({
        extract: () => JSON.stringify({ facts: ['x', 'y'], confidence: 0.8 }),
        classify: twoTopicFanout,
      });
      const res = await landRecords(twoTopicIO(), 'default', granolaLike, [rec('evil::id', 'cap')], { consolidate: true });
      // The `::`-in-captureId guard fires BEFORE extract/classify → a single raw
      // passthrough row, NOT a fan-out (which would collide the prefix idempotency).
      expect(res.written).toBe(1);
      const rows = await engine.executeRaw<{ source_record_id: string; classification: string | null }>(
        `SELECT source_record_id, classification FROM connector_candidates WHERE source_id='default' AND source_record_id LIKE 'evil%'`,
      );
      expect(rows.length).toBe(1); // not the 2 fan-out rows
      expect(rows[0].source_record_id).toBe('evil::id'); // landed verbatim under the bare id
      expect(rows[0].classification).toBeNull(); // raw passthrough — NOT consolidated
    });

    test('U2: a held-back (low-confidence) verdict lands rejected while its sibling lands pending (per-verdict disposition)', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      stubChatRouting({
        extract: () => JSON.stringify({ facts: ['a', 'b'], confidence: 0.8 }),
        classify: () =>
          JSON.stringify([
            { classification: 'UPDATE', target: 'clients/acme', merged_body: 'Acme updated.', timeline_entry: '2026-06-27 — Acme.', confidence: 0.9 },
            { classification: 'ADD', target: 'projects/new', confidence: 0.4 }, // < 0.70 surface floor → held back
          ]),
      });
      const wrapped = withClassifierIO(engine, {
        hits: [fakeHit('clients/acme', 0.5, 'shared')],
        pages: { 'clients/acme': fakePage('clients/acme', 'Acme.', 'shared') },
      });
      const res = await landRecords(wrapped, 'default', granolaLike, [rec('mt-hb', 'cap')], { consolidate: true });
      expect(res.written).toBe(2);
      const rows = await engine.executeRaw<{ classification: string; status: string; status_reason: string | null }>(
        `SELECT classification, status, status_reason FROM connector_candidates WHERE source_record_id LIKE 'mt-hb::%'`,
      );
      const upd = rows.find((r) => r.classification === 'UPDATE')!;
      const add = rows.find((r) => r.classification === 'ADD')!;
      expect(upd.status).toBe('pending'); // surfaced
      expect(add.status).toBe('rejected'); // held back
      expect(add.status_reason).toBe('low_confidence');
    });

    test('U2: a fan-out verdict whose target already has an in-flight update_page → that verdict NEEDS_REVIEW, the sibling proceeds', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      // Pre-seed a pending in-flight update_page on clients/acme.
      await toRow(engine, {
        source_id: 'default', source_record_id: 'prior-acme', provider: 'granola',
        classification: 'UPDATE', target_kind: 'update_page', target_path: 'clients/acme.md',
        proposed_markdown: 'prior', timeline_entry: 't', base_compiled_hash: 'x', status: 'pending',
      });
      stubChatRouting({
        extract: () => JSON.stringify({ facts: ['a', 'b'], confidence: 0.8 }),
        classify: twoTopicFanout, // touches clients/acme + integrations/olo
      });
      const res = await landRecords(twoTopicIO(), 'default', granolaLike, [rec('mt-sw', 'cap')], { consolidate: true });
      expect(res.written).toBe(2);
      const rows = await engine.executeRaw<{ source_record_id: string; classification: string; target_kind: string | null }>(
        `SELECT source_record_id, classification, target_kind FROM connector_candidates WHERE source_record_id LIKE 'mt-sw::%'`,
      );
      const acme = rows.find((r) => r.source_record_id === 'mt-sw::clients/acme')!;
      const olo = rows.find((r) => r.source_record_id === 'mt-sw::integrations/olo')!;
      expect(acme.classification).toBe('NEEDS_REVIEW'); // single-writer downgrade (acme already in flight)
      expect(acme.target_kind).toBeNull();
      expect(olo.classification).toBe('UPDATE'); // the sibling page is free → proceeds
      expect(olo.target_kind).toBe('update_page');
    });

    test('U3: re-polling an already-fanned-out capture lands 0 new rows AND pays 0 LLM calls', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      const { calls } = stubChatRouting({
        extract: () => JSON.stringify({ facts: ['Acme', 'Olo'], confidence: 0.8 }),
        classify: twoTopicFanout,
      });
      // First poll → fan-out lands 2 rows, pays LLM (extract + classify).
      const first = await landRecords(twoTopicIO(), 'default', granolaLike, [rec('mt-idem', 'cap')], { consolidate: true });
      expect(first.written).toBe(2);
      const callsAfterFirst = calls.length;
      expect(callsAfterFirst).toBeGreaterThan(0);
      // Re-poll the SAME capture → the `mt-idem::` prefix pre-check skips it.
      const second = await landRecords(twoTopicIO(), 'default', granolaLike, [rec('mt-idem', 'cap')], { consolidate: true });
      expect(second.written).toBe(0); // no new rows
      expect(calls.length).toBe(callsAfterFirst); // ZERO additional LLM calls (no re-pay)
      const [{ n }] = await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM connector_candidates WHERE source_record_id LIKE 'mt-idem::%'`,
      );
      expect(Number(n)).toBe(2); // count stable
    });

    test('U3: a single-verdict (bare-id) capture is ALSO recognized on re-poll (the `=` branch)', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      const io = (): BrainEngine => withClassifierIO(engine, { hits: [fakeHit('clients/acme', 0.5, 'shared')] });
      const { calls } = stubChatRouting({
        extract: () => JSON.stringify({ facts: ['one fact'], confidence: 0.8 }),
        classify: () => JSON.stringify([{ classification: 'ADD', target: 'projects/x', confidence: 0.9 }]),
      });
      const first = await landRecords(io(), 'default', granolaLike, [rec('sv-idem', 'cap')], { consolidate: true });
      expect(first.written).toBe(1); // single verdict → BARE captureId row
      const callsAfterFirst = calls.length;
      const second = await landRecords(io(), 'default', granolaLike, [rec('sv-idem', 'cap')], { consolidate: true });
      expect(second.written).toBe(0);
      expect(calls.length).toBe(callsAfterFirst); // no re-pay (the `= captureId` branch matched)
    });

    test('U3: a mixed batch — one already-consolidated capture + one new — pays the LLM only for the new one', async () => {
      await enableGranolaConsolidation();
      configureEmbedding();
      const { calls } = stubChatRouting({
        extract: () => JSON.stringify({ facts: ['Acme', 'Olo'], confidence: 0.8 }),
        classify: twoTopicFanout,
      });
      // Consolidate 'batch-done' first.
      await landRecords(twoTopicIO(), 'default', granolaLike, [rec('batch-done', 'cap')], { consolidate: true });
      const callsBefore = calls.length;
      // A re-poll batch: the done capture + a brand-new one.
      const res = await landRecords(twoTopicIO(), 'default', granolaLike, [rec('batch-done', 'cap'), rec('batch-new', 'cap2')], { consolidate: true });
      expect(res.written).toBe(2); // only batch-new's 2 fan-out rows
      expect(calls.length).toBe(callsBefore + 2); // ONLY the new capture paid (extract + classify)
      const [{ done }] = await engine.executeRaw<{ done: number }>(
        `SELECT count(*)::int AS done FROM connector_candidates WHERE source_record_id LIKE 'batch-done::%'`,
      );
      const [{ fresh }] = await engine.executeRaw<{ fresh: number }>(
        `SELECT count(*)::int AS fresh FROM connector_candidates WHERE source_record_id LIKE 'batch-new::%'`,
      );
      expect(Number(done)).toBe(2); // unchanged
      expect(Number(fresh)).toBe(2); // newly consolidated
    });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// captureConsolidated — the fan-out-aware idempotency pre-check (U3 / KTD3),
// tested directly: bare-id `=` match, `<captureId>::` prefix match, and LIKE
// metacharacter escaping (a captureId with '_' must match LITERALLY, not as a
// wildcard).
// ──────────────────────────────────────────────────────────────────────────────
describe('captureConsolidated — fan-out-aware idempotency pre-check (KTD3)', () => {
  test('matches the <captureId>:: prefix; LIKE metachars in the captureId are escaped', async () => {
    // A captureId containing a LIKE wildcard ('_') must be matched LITERALLY.
    await toRow(engine, { source_id: 'default', source_record_id: 'not_abc::clients/acme', provider: 'granola', proposed_markdown: 'x' });
    expect(await captureConsolidated(engine, 'default', 'not_abc', '1')).toBe(true);
    // A different id that would ONLY match if '_' were treated as a wildcard must NOT match.
    expect(await captureConsolidated(engine, 'default', 'notXabc', '1')).toBe(false);
    // A wholly unrelated capture → false.
    expect(await captureConsolidated(engine, 'default', 'other', '1')).toBe(false);
  });

  test('matches a bare-id (single-verdict) row via the `=` branch, version-scoped', async () => {
    await toRow(engine, { source_id: 'default', source_record_id: 'bare-1', provider: 'granola', proposed_markdown: 'x' });
    expect(await captureConsolidated(engine, 'default', 'bare-1', '1')).toBe(true);
    // A different version is a different idempotency tuple → not matched.
    expect(await captureConsolidated(engine, 'default', 'bare-1', '2')).toBe(false);
    // A different source → not matched (source-scoped).
    expect(await captureConsolidated(engine, 'other-src', 'bare-1', '1')).toBe(false);
  });
});
