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
  resolveInboxTarget,
  rejectCandidate,
  needsRationale,
  coerceCandidateRow,
  registerPromotionHook,
  NEEDS_RATIONALE_CONFIDENCE,
  type ConnectorCandidateRow,
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
