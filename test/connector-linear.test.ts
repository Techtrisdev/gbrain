/**
 * connector-linear.test.ts — the Linear SaaSConnector (TECH-2035).
 *
 * Recorded-fixture tests covering AC5's five required behaviors, plus the OAuth
 * refresh path, WITHOUT a live Linear API or the TECH-2033 credentials module:
 *
 *   1. status-change webhook → high-confidence pending candidate (+ a typed take).
 *   2. backfill cursor advances; a resumed run yields no duplicates.
 *   3. bad signature → reject (verifyWebhook false).
 *   4. expired token → refresh → succeed (custody module mocked).
 *   5. a secret in a description is masked (never reaches the candidate verbatim).
 *
 * The credentials module (./credentials.ts) is a TECH-2035 type-only stub on this
 * branch; getValidAccessToken is mocked here so the connector's backfill exercises the
 * refresh-then-succeed flow against fixtures. fetch is stubbed to serve the recorded
 * GraphQL pages — no network. Candidate writes go through a fake engine that captures
 * the toRow INSERT params (mirrors test/connector-base.test.ts).
 */

import { describe, test, expect, mock, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';

// ── Mock the TECH-2033 custody module BEFORE importing the connector ─────────────
// The connector imports getValidAccessToken/registerOAuthProvider at module load.
// We record refresh behavior so AC4 (expired → refresh → succeed) is observable.

let refreshCount = 0;
let issuedToken = 'expired-token';
const getValidAccessTokenMock = mock(async (_engine: BrainEngine, _sourceId: string, _provider: string) => {
  // Simulate custody refreshing an expired token: first call rotates, then returns fresh.
  refreshCount += 1;
  issuedToken = `Bearer fresh-token-${refreshCount}`;
  return issuedToken;
});

mock.module('../src/core/connectors/credentials.ts', () => ({
  getValidAccessToken: getValidAccessTokenMock,
  storeToken: mock(async () => {}),
  registerOAuthProvider: mock(() => {}),
}));

// Import AFTER the mock is registered so the connector binds the mocked symbols.
const { linearConnector, fetchIssuesPage, readBackfillWatermark } = await import(
  '../src/core/connectors/linear.ts'
);
const { landRecords } = await import('../src/core/connectors/base.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const FIX = join(import.meta.dir, 'fixtures', 'linear');
function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}
const statusChange = loadFixture('webhook-status-change.json') as Record<string, unknown>;
const backfillPage1 = loadFixture('graphql-backfill-page1.json');
const backfillPage2 = loadFixture('graphql-backfill-page2.json');

const SECRET_MARKER = 'AKIAIOSFODNN7EXAMPLE'; // AWS-key-shaped; strip() masks it
const WEBHOOK_SECRET = 'linear-webhook-signing-secret';

// ── Fake engine: captures connector_candidates INSERTs + sources config UPDATEs ──

function makeFakeEngine() {
  const inserts: { source_record_id: string; provider: unknown; proposed_markdown: string; redactions: unknown[]; status: unknown; confidence: unknown; allParams: unknown[] }[] = [];
  const configUpdates: { config: string; id: string }[] = [];
  const seenKeys = new Set<string>();
  const engine = {
    kind: 'pglite',
    executeRaw: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (/INSERT INTO connector_candidates/.test(sql)) {
        const key = `${p[0]}|${p[1]}|${p[2]}`; // (source_id, source_record_id, version)
        if (seenKeys.has(key)) return []; // ON CONFLICT DO NOTHING → no row
        seenKeys.add(key);
        inserts.push({
          source_record_id: p[1] as string,
          provider: p[4],
          proposed_slug: p[5],
          proposed_markdown: p[6] as string,
          confidence: p[7],
          redactions: p[8] as unknown[],
          status: p[12],
          allParams: p,
        } as any);
        return [{ id: inserts.length }];
      }
      if (/UPDATE sources SET config/.test(sql)) {
        configUpdates.push({ config: p[0] as string, id: p[1] as string });
        return [];
      }
      // toRow's fetch-on-conflict SELECT
      return [{ id: 0 }];
    },
  } as unknown as BrainEngine;
  return { engine, inserts, configUpdates };
}

// ── Signing helper ───────────────────────────────────────────────────────────────

function sign(body: Buffer, secret = WEBHOOK_SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Build a raw webhook body with webhookTimestamp set relative to now. */
function webhookBody(payload: Record<string, unknown>, tsOffsetMs = 0): Buffer {
  return Buffer.from(JSON.stringify({ ...payload, webhookTimestamp: Date.now() + tsOffsetMs }), 'utf8');
}

// ── fetch stub for backfill (serves the two recorded GraphQL pages) ──────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  refreshCount = 0;
});

function stubGraphqlFetch(pages: unknown[]): { calls: { variables: any; auth: string | undefined }[] } {
  const calls: { variables: any; auth: string | undefined }[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const parsed = bodyText ? JSON.parse(bodyText) : {};
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ variables: parsed.variables, auth });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => page, text: async () => '' } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

// ── 1. status-change webhook → high-confidence pending candidate (+ typed take) ──

describe('Linear webhook: status change → candidate(s)', () => {
  test('emits a high-confidence pending primary candidate AND a typed take', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = linearConnector.normalize(statusChange);

    // Two records: the Issue candidate + the typed take (status went to completed).
    expect(records).toHaveLength(2);
    const result = await landRecords(engine, 'src-1', linearConnector, records);
    expect(result).toEqual({ written: 2, total: 2 });

    const primary = inserts.find((r) => r.source_record_id === 'issue-uuid-1')!;
    expect(primary).toBeDefined();
    expect(primary.provider).toBe('linear');
    expect(primary.confidence).toBe(0.9); // high confidence
    expect(primary.status).toBe('pending'); // toRow always inserts pending

    // The typed take: state.type 'completed' → 'decision'.
    const take = inserts.find((r) => r.source_record_id.includes(':take:'))!;
    expect(take).toBeDefined();
    expect(take.source_record_id).toBe('issue-uuid-1:take:decision');
    expect(take.proposed_markdown).toContain('[decision]');
    expect(take.confidence).toBe(0.85);
  });

  test('accountFromPayload resolves the organizationId', () => {
    expect(linearConnector.accountFromPayload(statusChange)).toBe('org-acme-123');
  });

  test('a commitment take names the owner', () => {
    const assigneeChange = {
      action: 'update',
      type: 'Issue',
      organizationId: 'org-acme-123',
      updatedFrom: { assigneeId: null },
      data: {
        id: 'issue-uuid-2',
        identifier: 'ENG-7',
        title: 'Owned now',
        url: 'https://linear.app/acme/issue/ENG-7',
        state: { name: 'In Progress', type: 'started' },
        assignee: { name: 'Dana', displayName: 'Dana K.' },
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    };
    const records = linearConnector.normalize(assigneeChange);
    const take = records.find((r) => r.sourceRecordId.includes(':take:'))!;
    expect(take.sourceRecordId).toBe('issue-uuid-2:take:commitment');
    expect(take.item.summary).toContain('Dana');
  });

  test('a non-material update emits ONLY the primary candidate (no take)', () => {
    const titleEdit = {
      action: 'update',
      type: 'Issue',
      organizationId: 'org-acme-123',
      updatedFrom: { title: 'old title' }, // not a material field
      data: { id: 'issue-uuid-3', identifier: 'ENG-9', title: 'new title', updatedAt: '2026-06-14T12:00:00.000Z' },
    };
    expect(linearConnector.normalize(titleEdit)).toHaveLength(1);
  });
});

// ── 3. bad signature → reject ─────────────────────────────────────────────────────

describe('Linear verifyWebhook (AC3: HMAC + 60s window, constant-time)', () => {
  test('valid signature + fresh timestamp → true', () => {
    const body = webhookBody(statusChange);
    const headers = { 'linear-signature': sign(body) };
    expect(linearConnector.verifyWebhook(body, headers, WEBHOOK_SECRET)).toBe(true);
  });

  test('bad signature → reject', () => {
    const body = webhookBody(statusChange);
    const headers = { 'linear-signature': sign(body, 'wrong-secret') };
    expect(linearConnector.verifyWebhook(body, headers, WEBHOOK_SECRET)).toBe(false);
  });

  test('tampered body → reject', () => {
    const body = webhookBody(statusChange);
    const headers = { 'linear-signature': sign(body) };
    const tampered = Buffer.from(body);
    tampered[10] = tampered[10] ^ 0xff;
    expect(linearConnector.verifyWebhook(tampered, headers, WEBHOOK_SECRET)).toBe(false);
  });

  test('valid signature but STALE timestamp (replay) → reject', () => {
    const body = webhookBody(statusChange, -120_000); // 2 minutes old, outside the 60s window
    const headers = { 'linear-signature': sign(body) };
    expect(linearConnector.verifyWebhook(body, headers, WEBHOOK_SECRET)).toBe(false);
  });

  test('missing signature header → reject', () => {
    const body = webhookBody(statusChange);
    expect(linearConnector.verifyWebhook(body, {}, WEBHOOK_SECRET)).toBe(false);
  });
});

// ── 2. backfill cursor advances; resume yields no duplicates ─────────────────────

describe('Linear backfill (AC2: updatedAt cursor + watermark, resume-safe)', () => {
  test('pages through both fixtures, lands candidates, advances the watermark', async () => {
    const { engine, inserts, configUpdates } = makeFakeEngine();
    const { calls } = stubGraphqlFetch([backfillPage1, backfillPage2]);
    const source: ConnectorSource = { id: 'src-1', config: { connectors: { linear: { enabled: true, account: 'org-acme-123' } } } };

    const landed = await linearConnector.backfill!(engine, source);

    // 3 issues across 2 pages → at least 3 primary candidates landed.
    expect(landed).toBeGreaterThanOrEqual(3);
    expect(inserts.some((r) => r.source_record_id === 'issue-uuid-100')).toBe(true);
    expect(inserts.some((r) => r.source_record_id === 'issue-uuid-102')).toBe(true);

    // Two fetch calls (page1 hasNextPage=true → page2 hasNextPage=false → stop).
    expect(calls).toHaveLength(2);
    // First call has no `after` cursor; second call uses page1's endCursor.
    expect(calls[0].variables.after).toBeNull();
    expect(calls[1].variables.after).toBe('cursor-page-1');

    // Watermark advanced to the newest updatedAt (issue-102, 2026-06-14T09:00).
    expect(configUpdates).toHaveLength(1);
    const written = JSON.parse(configUpdates[0].config);
    expect(written.connectors.linear.backfill_cursor).toBe('2026-06-14T09:00:00.000Z');
  });

  test('resume from the advanced watermark filters by updatedAt:{gt} and yields no duplicates', async () => {
    // Source now carries the watermark from the prior run.
    const source: ConnectorSource = {
      id: 'src-1',
      config: { connectors: { linear: { enabled: true, account: 'org-acme-123', backfill_cursor: '2026-06-14T09:00:00.000Z' } } },
    };
    expect(readBackfillWatermark(source)).toBe('2026-06-14T09:00:00.000Z');

    // The resumed run filters server-side: an empty page (nothing newer) → no writes.
    const emptyPage = { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    const { engine, inserts } = makeFakeEngine();
    const { calls } = stubGraphqlFetch([emptyPage]);

    const landed = await linearConnector.backfill!(engine, source);
    expect(landed).toBe(0);
    expect(inserts).toHaveLength(0);
    // The watermark was passed as the updatedAt:{gt} filter.
    expect(calls[0].variables.filter).toEqual({ updatedAt: { gt: '2026-06-14T09:00:00.000Z' } });
  });

  test('a re-fetch of the SAME records is a no-op (ON CONFLICT) — duplicate-delivery safe', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = linearConnector.normalize(statusChange);
    await landRecords(engine, 'src-1', linearConnector, records);
    const firstCount = inserts.length;
    // Land the identical records again — same (source, source_record_id, version) keys.
    const second = await landRecords(engine, 'src-1', linearConnector, records);
    expect(second.written).toBe(0); // ON CONFLICT DO NOTHING
    expect(inserts.length).toBe(firstCount); // no new rows captured
  });
});

// ── 4. expired token → refresh → succeed ──────────────────────────────────────────

describe('Linear backfill OAuth (AC2: expired token → refresh → succeed)', () => {
  test('backfill calls getValidAccessToken (custody refresh) and uses the fresh token', async () => {
    const { engine } = makeFakeEngine();
    const { calls } = stubGraphqlFetch([backfillPage1, backfillPage2]);
    const source: ConnectorSource = { id: 'src-1', config: { connectors: { linear: { enabled: true, account: 'org-acme-123' } } } };

    await linearConnector.backfill!(engine, source);

    // Custody was consulted (it refreshed the expired token internally).
    expect(getValidAccessTokenMock).toHaveBeenCalled();
    expect(refreshCount).toBeGreaterThanOrEqual(1);
    // The GraphQL request carried the freshly-issued bearer token (not the expired one).
    expect(calls[0].auth).toBe(issuedToken);
    expect(calls[0].auth).toContain('fresh-token');
  });
});

// ── 5. a secret in a description is masked ────────────────────────────────────────

describe('Linear redaction (AC5: secret in a description is masked)', () => {
  test('a secret in the description is dropped (body) and never reaches the candidate verbatim', async () => {
    const { engine, inserts } = makeFakeEngine();
    const payload = {
      action: 'create',
      type: 'Issue',
      organizationId: 'org-acme-123',
      data: {
        id: 'issue-secret-1',
        identifier: 'SEC-1',
        title: 'Rotate creds',
        description: `the leaked key is ${SECRET_MARKER} please rotate`,
        url: 'https://linear.app/acme/issue/SEC-1',
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    };
    const records = linearConnector.normalize(payload);
    await landRecords(engine, 'src-1', linearConnector, records);

    const blob = JSON.stringify(inserts);
    // The description body is dropped by minimize; the secret never appears verbatim.
    expect(blob).not.toContain(SECRET_MARKER);
  });

  test('a secret that lands in a KEPT field (title→summary) is masked to [REDACTED]', async () => {
    const { engine, inserts } = makeFakeEngine();
    const payload = {
      action: 'create',
      type: 'Issue',
      organizationId: 'org-acme-123',
      data: {
        id: 'issue-secret-2',
        identifier: 'SEC-2',
        title: `urgent ${SECRET_MARKER} fix`, // flows into the kept summary
        url: 'https://linear.app/acme/issue/SEC-2',
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    };
    const records = linearConnector.normalize(payload);
    await landRecords(engine, 'src-1', linearConnector, records);

    const candidate = inserts.find((r) => r.source_record_id === 'issue-secret-2')!;
    expect(candidate.proposed_markdown).not.toContain(SECRET_MARKER);
    expect(candidate.proposed_markdown).toContain('[REDACTED]');
    // A redaction-trail entry recorded the mask.
    expect(JSON.stringify(candidate.redactions)).toContain('summary');
  });
});
