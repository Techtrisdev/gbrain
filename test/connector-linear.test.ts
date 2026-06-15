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
  // Contract (review finding 5): getValidAccessToken returns a BARE access token; the
  // connector prepends `Bearer ` itself. So the mock returns no scheme prefix.
  refreshCount += 1;
  issuedToken = `fresh-token-${refreshCount}`;
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

/** The receiver passes the resolved source to normalize(payload, source); Linear ignores
 *  it (ingests all issues). A minimal source satisfies the SaaSConnector signature. */
const SRC: ConnectorSource = { id: 'src-1', config: {} };

// ── Fake engine: captures connector_candidates INSERTs + sources config UPDATEs ──

/**
 * Fake engine. Captures connector_candidates INSERTs and maintains REAL per-source
 * config state so the watermark UPDATE can be modeled as the connector's surgical
 * `jsonb_set(config, '{connectors,linear,backfill_cursor}', …)` — letting a test mutate
 * a sibling config key mid-flight and assert it survives (review finding 2/7c).
 */
function makeFakeEngine(opts: { initialConfig?: Record<string, Record<string, unknown>> } = {}) {
  const inserts: { source_record_id: string; provider: unknown; proposed_markdown: string; redactions: unknown[]; status: unknown; confidence: unknown; allParams: unknown[] }[] = [];
  const watermarkUpdates: { watermark: string; id: string }[] = [];
  const seenKeys = new Set<string>();
  // source_id → parsed config object (server-side truth the jsonb_set mutates in place).
  const configState: Record<string, Record<string, unknown>> = { ...(opts.initialConfig ?? {}) };
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
      // Surgical watermark write: jsonb_set(config, '{connectors,linear,backfill_cursor}', …).
      if (/UPDATE sources\s+SET config = jsonb_set/.test(sql)) {
        const watermark = p[0] as string;
        const id = p[1] as string;
        watermarkUpdates.push({ watermark, id });
        // Model jsonb_set on the CURRENT server-side row (NOT a stale snapshot).
        const cfg = (configState[id] ??= {});
        const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
        const linear = (connectors.linear ??= {}) as Record<string, unknown>;
        linear.backfill_cursor = watermark;
        return [];
      }
      // toRow's fetch-on-conflict SELECT
      return [{ id: 0 }];
    },
  } as unknown as BrainEngine;
  return { engine, inserts, watermarkUpdates, configState };
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
    const records = linearConnector.normalize(statusChange, SRC);

    // Two records: the Issue candidate + the typed take (status went to completed).
    expect(records).toHaveLength(2);
    const result = await landRecords(engine, 'src-1', linearConnector, records);
    expect(result).toEqual({ written: 2, total: 2 });

    const primary = inserts.find((r) => r.source_record_id === 'issue-uuid-1')!;
    expect(primary).toBeDefined();
    expect(primary.provider).toBe('linear');
    expect(primary.confidence).toBe(0.9); // high confidence
    expect(primary.status).toBe('pending'); // toRow always inserts pending

    // The typed take: state.type 'completed' → 'decision'. The key carries updatedAt
    // (finding 3) so a re-completion lands a distinct take instead of colliding.
    const take = inserts.find((r) => r.source_record_id.includes(':take:'))!;
    expect(take).toBeDefined();
    expect(take.source_record_id).toBe('issue-uuid-1:take:decision:2026-06-14T12:00:00.000Z');
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
    const records = linearConnector.normalize(assigneeChange, SRC);
    const take = records.find((r) => r.sourceRecordId.includes(':take:'))!;
    expect(take.sourceRecordId).toBe('issue-uuid-2:take:commitment:2026-06-14T12:00:00.000Z');
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
    expect(linearConnector.normalize(titleEdit, SRC)).toHaveLength(1);
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

  // Finding 7b: table-tests for malformed/absent webhookTimestamp. Each is correctly
  // signed (HMAC passes) so the rejection is attributable to the timestamp gate alone.
  describe('webhookTimestamp gate — malformed/absent values reject', () => {
    function signedBodyWith(tsValue: unknown): Buffer {
      const obj: Record<string, unknown> = { ...statusChange };
      if (tsValue === '__omit__') delete obj.webhookTimestamp;
      else obj.webhookTimestamp = tsValue;
      return Buffer.from(JSON.stringify(obj), 'utf8');
    }
    const cases: { name: string; ts: unknown }[] = [
      { name: 'missing webhookTimestamp', ts: '__omit__' },
      { name: 'string webhookTimestamp', ts: '1700000000000' },
      { name: 'NaN webhookTimestamp', ts: Number.NaN },
      { name: 'null webhookTimestamp', ts: null },
      { name: 'far-future webhookTimestamp (outside window)', ts: Date.now() + 3_600_000 },
    ];
    for (const c of cases) {
      test(`${c.name} → reject`, () => {
        const body = signedBodyWith(c.ts);
        const headers = { 'linear-signature': sign(body) }; // valid HMAC; only ts is wrong
        expect(linearConnector.verifyWebhook(body, headers, WEBHOOK_SECRET)).toBe(false);
      });
    }
  });

  // Finding 7b: signature-shape edge cases. Linear sends a BARE hex digest (no prefix).
  test('non-hex signature → reject', () => {
    const body = webhookBody(statusChange);
    const headers = { 'linear-signature': 'zzzznothex' };
    expect(linearConnector.verifyWebhook(body, headers, WEBHOOK_SECRET)).toBe(false);
  });

  test('a sha256=-prefixed signature → reject (Linear sends NO prefix)', () => {
    const body = webhookBody(statusChange);
    const headers = { 'linear-signature': `sha256=${sign(body)}` };
    expect(linearConnector.verifyWebhook(body, headers, WEBHOOK_SECRET)).toBe(false);
  });
});

// ── 2. backfill cursor advances; resume yields no duplicates ─────────────────────

describe('Linear backfill (AC2: updatedAt cursor + watermark, resume-safe)', () => {
  test('pages through both fixtures, lands candidates, advances the watermark', async () => {
    const { engine, inserts, watermarkUpdates, configState } = makeFakeEngine();
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

    // Watermark advanced to the newest updatedAt (issue-102, 2026-06-14T09:00) via the
    // surgical jsonb_set path (a single watermark UPDATE, not a whole-config rewrite).
    expect(watermarkUpdates).toHaveLength(1);
    expect(watermarkUpdates[0].watermark).toBe('2026-06-14T09:00:00.000Z');
    expect((configState['src-1'].connectors as any).linear.backfill_cursor).toBe('2026-06-14T09:00:00.000Z');
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
    const records = linearConnector.normalize(statusChange, SRC);
    await landRecords(engine, 'src-1', linearConnector, records);
    const firstCount = inserts.length;
    // Land the identical records again — same (source, source_record_id, version) keys.
    const second = await landRecords(engine, 'src-1', linearConnector, records);
    expect(second.written).toBe(0); // ON CONFLICT DO NOTHING
    expect(inserts.length).toBe(firstCount); // no new rows captured
  });

  // Finding 7c: the surgical jsonb_set watermark write must NOT clobber a sibling
  // config key (e.g. a secret rotated concurrently between snapshot-read and write).
  test('watermark write preserves a sibling config key mutated mid-flight (no lost update)', async () => {
    // Server-side config carries a secret the connector NEVER read into its snapshot.
    const { engine, configState } = makeFakeEngine({
      initialConfig: {
        'src-1': { connectors: { linear: { enabled: true, account: 'org-acme-123', secret: 'ORIGINAL_SECRET' } } },
      },
    });
    const { calls } = stubGraphqlFetch([backfillPage1, backfillPage2]);

    // The connector's snapshot (passed to backfill) is STALE — it has no secret. A
    // whole-config UPDATE from this snapshot would erase the server-side secret.
    const staleSnapshot: ConnectorSource = {
      id: 'src-1',
      config: { connectors: { linear: { enabled: true, account: 'org-acme-123' } } },
    };

    await linearConnector.backfill!(engine, staleSnapshot);
    expect(calls.length).toBeGreaterThan(0);

    const linearCfg = (configState['src-1'].connectors as any).linear;
    // The watermark landed …
    expect(linearCfg.backfill_cursor).toBe('2026-06-14T09:00:00.000Z');
    // … AND the concurrently-present secret survived (surgical jsonb_set, not a clobber).
    expect(linearCfg.secret).toBe('ORIGINAL_SECRET');
  });

  // Finding 7d: a re-completion (completed → reopened → completed) must land a SECOND
  // distinct decision take, not collide on ON CONFLICT — the take key carries updatedAt.
  test('re-completion lands a second distinct decision take (different updatedAt → new key)', async () => {
    const { engine, inserts } = makeFakeEngine();
    const completionAt = (updatedAt: string) => ({
      action: 'update',
      type: 'Issue',
      organizationId: 'org-acme-123',
      updatedFrom: { stateId: 'state-in-progress' },
      data: {
        id: 'issue-recompletion',
        identifier: 'ENG-77',
        title: 'Flaky thing',
        url: 'https://linear.app/acme/issue/ENG-77',
        state: { name: 'Done', type: 'completed' },
        assignee: { name: 'Robin' },
        updatedAt,
      },
    });

    await landRecords(engine, 'src-1', linearConnector, linearConnector.normalize(completionAt('2026-06-14T10:00:00.000Z'), SRC));
    await landRecords(engine, 'src-1', linearConnector, linearConnector.normalize(completionAt('2026-06-15T10:00:00.000Z'), SRC));

    const takes = inserts.filter((r) => r.source_record_id.includes(':take:decision:'));
    expect(takes).toHaveLength(2);
    expect(takes[0].source_record_id).toBe('issue-recompletion:take:decision:2026-06-14T10:00:00.000Z');
    expect(takes[1].source_record_id).toBe('issue-recompletion:take:decision:2026-06-15T10:00:00.000Z');

    // Re-delivery of the SAME event still dedupes (deterministic key).
    const dup = await landRecords(engine, 'src-1', linearConnector, linearConnector.normalize(completionAt('2026-06-15T10:00:00.000Z'), SRC));
    expect(dup.written).toBe(0);
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
    // getValidAccessToken returns a BARE token; the connector prepends `Bearer ` (finding 5).
    // The GraphQL request carried the freshly-issued token under that scheme (not the expired one).
    expect(issuedToken).not.toContain('Bearer'); // mock returns bare
    expect(calls[0].auth).toBe(`Bearer ${issuedToken}`);
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
    const records = linearConnector.normalize(payload, SRC);
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
    const records = linearConnector.normalize(payload, SRC);
    await landRecords(engine, 'src-1', linearConnector, records);

    const candidate = inserts.find((r) => r.source_record_id === 'issue-secret-2')!;
    expect(candidate.proposed_markdown).not.toContain(SECRET_MARKER);
    expect(candidate.proposed_markdown).toContain('[REDACTED]');
    // A redaction-trail entry recorded the mask.
    expect(JSON.stringify(candidate.redactions)).toContain('summary');
  });

  // Finding 7a / 1: a Comment has NO title/name — only a free-form body. That body must
  // NEVER flow into the summary (strip() does not catch names/addresses/deal-terms). The
  // summary is a structural "Comment on <issueId>" label; no body text reaches the row.
  test('a Comment body does NOT appear in proposed_markdown (structural label only)', async () => {
    const { engine, inserts } = makeFakeEngine();
    const commentBody = `Off-the-record: pay Jane Smith $250k and close the Acme deal — ${SECRET_MARKER}`;
    const payload = {
      action: 'create',
      type: 'Comment',
      organizationId: 'org-acme-123',
      data: {
        id: 'comment-1',
        body: commentBody,
        issueId: 'issue-uuid-parent',
        url: 'https://linear.app/acme/issue/ENG-1#comment-1',
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    };
    const records = linearConnector.normalize(payload, SRC);
    await landRecords(engine, 'src-1', linearConnector, records);

    const candidate = inserts.find((r) => r.source_record_id === 'comment-1')!;
    expect(candidate).toBeDefined();
    // The summary is the structural label, not body-derived.
    expect(candidate.proposed_markdown).toBe('Comment on issue-uuid-parent');
    // No fragment of the body — secret OR the PII/deal-terms strip() can't catch — leaks.
    const blob = JSON.stringify(inserts);
    expect(blob).not.toContain(SECRET_MARKER);
    expect(blob).not.toContain('Jane Smith');
    expect(blob).not.toContain('250k');
    expect(blob).not.toContain('Acme deal');
  });

  // Finding 7e: pin label-array behavior. labelIds is NOT surfaced on the candidate
  // (metadata is intentionally not written — finding 6), so even a secret-shaped label
  // entry never reaches a row. This locks the behavior so a future metadata-surfacing
  // change can't silently reintroduce the unstripped-array hole.
  test('a secret inside a labels array never reaches the candidate (metadata not surfaced)', async () => {
    const { engine, inserts } = makeFakeEngine();
    const payload = {
      action: 'create',
      type: 'Issue',
      organizationId: 'org-acme-123',
      data: {
        id: 'issue-labelsecret',
        identifier: 'LAB-1',
        title: 'Labelled',
        url: 'https://linear.app/acme/issue/LAB-1',
        labelIds: [`label-${SECRET_MARKER}`, 'label-ok'],
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    };
    const records = linearConnector.normalize(payload, SRC);
    await landRecords(engine, 'src-1', linearConnector, records);
    expect(JSON.stringify(inserts)).not.toContain(SECRET_MARKER);
  });
});

// ── Finding 4: priority-take direction ────────────────────────────────────────────

describe('Linear classifyTake — priority direction (finding 4)', () => {
  function priorityChange(oldP: number, newP: number) {
    return {
      action: 'update',
      type: 'Issue',
      organizationId: 'org-acme-123',
      updatedFrom: { priority: oldP },
      data: {
        id: `issue-prio-${oldP}-${newP}`,
        identifier: 'PRIO-1',
        title: 'Repriced',
        priority: newP,
        updatedAt: '2026-06-14T12:00:00.000Z',
      },
    };
  }
  function takeTypeOf(payload: Record<string, unknown>): string {
    const take = linearConnector.normalize(payload, SRC).find((r) => r.sourceRecordId.includes(':take:'))!;
    return take.sourceRecordId.split(':take:')[1].split(':')[0];
  }

  test('a RAISE (urgent-er: 3 → 1) → action_item', () => {
    expect(takeTypeOf(priorityChange(3, 1))).toBe('action_item');
  });
  test('a raise from none (0 → 2) → action_item', () => {
    expect(takeTypeOf(priorityChange(0, 2))).toBe('action_item');
  });
  test('a LOWER (1 → 3) → open_question (the semantic opposite)', () => {
    expect(takeTypeOf(priorityChange(1, 3))).toBe('open_question');
  });
  test('a CLEAR (2 → 0 none) → open_question', () => {
    expect(takeTypeOf(priorityChange(2, 0))).toBe('open_question');
  });
});
