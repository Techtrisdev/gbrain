/**
 * Tests for src/core/connectors/base.ts (TECH-2034 — the SaaSConnector framework).
 *
 * Pins the load-bearing primitives the /webhooks/:provider receiver depends on,
 * without bringing up Express or a DB (the full HTTP path is a DATABASE_URL-gated
 * E2E follow-up, mirroring the /webhooks/github precedent in sources-webhook.test.ts):
 *
 *   1. hmacSha256Verify — constant-time, prefix-stripped, length/format safe.
 *   2. the connector registry — register / get / unknown.
 *   3. readConnectorConfig — object + JSON-string config, fail-soft to null.
 *   4. landRecords — THE redaction choke point: body dropped, secrets masked,
 *      proposed_markdown re-stripped (the redact.ts wiring contract), idempotency
 *      count surfaced. Uses a fake engine that captures the toRow INSERT params.
 */

import { describe, test, expect } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  hmacSha256Verify,
  registerConnector,
  getConnector,
  readConnectorConfig,
  landRecords,
  type SaaSConnector,
  type ConnectorSource,
} from '../src/core/connectors/base.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const SECRET_MARKER = 'AKIAIOSFODNN7EXAMPLE'; // a real AWS-key-shaped secret strip() masks

// ── 1. hmacSha256Verify ─────────────────────────────────────────────────────────

describe('hmacSha256Verify — constant-time HMAC', () => {
  const secret = 'super-secret-webhook-key';
  const body = Buffer.from(JSON.stringify({ account: 'T123', event: 'message' }), 'utf8');
  const goodHex = createHmac('sha256', secret).update(body).digest('hex');

  test('valid signature on untampered body → true', () => {
    expect(hmacSha256Verify(body, secret, goodHex)).toBe(true);
  });

  test('wrong secret → false', () => {
    expect(hmacSha256Verify(body, 'not-the-secret', goodHex)).toBe(false);
  });

  test('single-byte body tamper → false', () => {
    const tampered = Buffer.from(body);
    tampered[5] = tampered[5] ^ 0xff;
    expect(hmacSha256Verify(tampered, secret, goodHex)).toBe(false);
  });

  test('empty secret or empty signature → false', () => {
    expect(hmacSha256Verify(body, '', goodHex)).toBe(false);
    expect(hmacSha256Verify(body, secret, '')).toBe(false);
  });

  test('non-hex signature → false (no false-match on 0-byte decode)', () => {
    // Buffer.from('zz...', 'hex') truncates to empty; the length===0 guard rejects it.
    expect(hmacSha256Verify(body, secret, 'zzzzzzzz')).toBe(false);
  });

  test('length-mismatched signature → false', () => {
    expect(hmacSha256Verify(body, secret, goodHex.slice(0, 10))).toBe(false);
  });
});

// ── 2. registry ─────────────────────────────────────────────────────────────────

describe('connector registry', () => {
  test('register then resolve by provider; unknown → undefined', () => {
    const stub: SaaSConnector = {
      provider: 'registry-probe',
      signatureHeader: 'x-probe-signature',
      verifyWebhook: () => true,
      accountFromPayload: () => 'acct',
      normalize: () => [],
      toCandidate: (r, sourceId) => ({ source_id: sourceId, source_record_id: r.sourceRecordId }),
    };
    registerConnector(stub);
    expect(getConnector('registry-probe')).toBe(stub);
    expect(getConnector('no-such-provider')).toBeUndefined();
  });
});

// ── 3. readConnectorConfig ───────────────────────────────────────────────────────

describe('readConnectorConfig', () => {
  test('object config → reads the provider entry', () => {
    const src: ConnectorSource = {
      id: 's1',
      config: { connectors: { slack: { enabled: true, secret: 'x', account: 'T1' } } },
    };
    expect(readConnectorConfig(src, 'slack')).toEqual({ enabled: true, secret: 'x', account: 'T1' });
  });

  test('JSON-string config is parsed', () => {
    const src: ConnectorSource = {
      id: 's1',
      config: JSON.stringify({ connectors: { slack: { enabled: false, secret: 'y', account: 'T2' } } }),
    };
    expect(readConnectorConfig(src, 'slack')?.enabled).toBe(false);
  });

  test('missing connectors map → null', () => {
    expect(readConnectorConfig({ id: 's1', config: {} }, 'slack')).toBeNull();
  });

  test('provider absent from connectors map → null', () => {
    const src: ConnectorSource = { id: 's1', config: { connectors: { linear: { enabled: true } } } };
    expect(readConnectorConfig(src, 'slack')).toBeNull();
  });

  test('unparseable string config → null (fail-soft)', () => {
    expect(readConnectorConfig({ id: 's1', config: '{not json' }, 'slack')).toBeNull();
  });
});

// ── 4. landRecords — the redaction choke point ───────────────────────────────────

/** A connector whose record carries a body + secrets in every field, and whose
 *  toCandidate re-injects a raw secret into proposed_markdown — so the test can
 *  prove landRecords drops the body and re-strips proposed_markdown itself. */
const leakyConnector: SaaSConnector = {
  provider: 'leaky',
  signatureHeader: 'x-leaky-signature',
  verifyWebhook: (raw, headers, secret) => hmacSha256Verify(raw, secret, headers['x-leaky-signature'] ?? ''),
  accountFromPayload: (p) =>
    p && typeof p === 'object' && 'account' in p ? String((p as Record<string, unknown>).account) : null,
  normalize: () => [
    {
      sourceRecordId: 'rec-1',
      profile: 'comms',
      item: {
        sourceRecordId: 'rec-1',
        metadata: { channel: 'general', secret_token: SECRET_MARKER },
        summary: `shipped the fix; embedded ${SECRET_MARKER}`,
        body: `FULL_SECRET_BODY ${SECRET_MARKER} and lots more verbatim content`,
      },
      proposedSlug: 'rec-1',
    },
  ],
  toCandidate: (record, sourceId) => ({
    source_id: sourceId,
    source_record_id: record.sourceRecordId,
    provider: 'leaky',
    proposed_slug: record.proposedSlug,
    // Built from the already-redacted summary, PLUS a re-injected raw secret to
    // prove the framework strips proposed_markdown regardless of the connector.
    proposed_markdown: `# ${record.proposedSlug}\n\n${record.item.summary ?? ''}\n\ntrailing ${SECRET_MARKER}`,
  }),
};

/** A minimal resolved source for the receiver-shape `normalize(payload, source)` call.
 *  These inline connectors ignore `source`; it satisfies the SaaSConnector signature. */
const SRC: ConnectorSource = { id: 'src-1', config: {} };

/** Fake engine that records executeRaw calls and simulates toRow's INSERT…RETURNING. */
function makeFakeEngine(opts: { conflict?: boolean } = {}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const engine = {
    executeRaw: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (/INSERT INTO connector_candidates/.test(sql)) {
        return opts.conflict ? [] : [{ id: 1 }];
      }
      // toRow's fetch-on-conflict SELECT.
      return [{ id: 1 }];
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

describe('landRecords — redaction choke point', () => {
  test('drops the body, masks secrets, and re-strips proposed_markdown', async () => {
    const { engine, calls } = makeFakeEngine();
    const records = leakyConnector.normalize(null, SRC);
    const result = await landRecords(engine, 'src-1', leakyConnector, records);

    expect(result).toEqual({ written: 1, total: 1 });

    const insert = calls.find((c) => /INSERT INTO connector_candidates/.test(c.sql));
    expect(insert).toBeDefined();
    const params = insert!.params;
    const proposedMarkdown = params[6] as string; // $7 proposed_markdown
    const redactions = params[8] as unknown[]; // $9 redactions

    // Wiring contract: proposed_markdown carries no raw secret, even though the
    // connector injected one — landRecords stripped it.
    expect(proposedMarkdown).not.toContain(SECRET_MARKER);
    expect(proposedMarkdown).toContain('[REDACTED]');

    // The body never reaches the candidate at all (minimize drops it), and NO
    // field anywhere in the INSERT carries the secret or the body verbatim.
    const blob = JSON.stringify(params);
    expect(blob).not.toContain(SECRET_MARKER);
    expect(blob).not.toContain('FULL_SECRET_BODY');

    // A redaction trail was recorded (body dropped + metadata dropped + summary masked).
    expect(redactions.length).toBeGreaterThan(0);
  });

  test('idempotent conflict surfaces written=0 but total=1', async () => {
    const { engine } = makeFakeEngine({ conflict: true });
    const result = await landRecords(engine, 'src-1', leakyConnector, leakyConnector.normalize(null, SRC));
    expect(result).toEqual({ written: 0, total: 1 });
  });

  test('empty record set is a no-op', async () => {
    const { engine, calls } = makeFakeEngine();
    const result = await landRecords(engine, 'src-1', leakyConnector, []);
    expect(result).toEqual({ written: 0, total: 0 });
    expect(calls).toHaveLength(0);
  });
});

/** A connector that injects RAW secrets into proposed_slug + rationale_ref and
 *  returns NO proposed_markdown — exercising the write-boundary strip and the
 *  renderCandidateMarkdown stub path (the two redaction gaps the adversarial
 *  review found: ...raw spread + stub regeneration after the strip). */
const slugLeakConnector: SaaSConnector = {
  provider: 'slug-leak',
  signatureHeader: 'x-sig',
  verifyWebhook: () => true,
  accountFromPayload: () => 'acct',
  normalize: () => [
    {
      sourceRecordId: 'rec-9',
      profile: 'comms',
      item: { sourceRecordId: 'rec-9', metadata: {}, summary: 'clean summary' },
      proposedSlug: 'rec-9',
    },
  ],
  toCandidate: (record, sourceId) => ({
    source_id: sourceId,
    source_record_id: record.sourceRecordId,
    // Raw secrets in EVERY connector-controlled output field, and NO proposed_markdown
    // (forcing toRow's stub generator, which embeds proposed_slug/provider/version into
    // the body) — exercising both the page-body path and the standalone columns.
    provider: `slug-leak-${SECRET_MARKER}`,
    version: `v-${SECRET_MARKER}`,
    proposed_slug: `leak-${SECRET_MARKER}`,
    rationale_ref: `https://x.test/?token=${SECRET_MARKER}`,
  }),
};

describe('toRow write boundary — every output field is redacted, incl. the generated stub', () => {
  test('strips proposed_slug, rationale_ref, provider, version, and the stub-generated proposed_markdown', async () => {
    const { engine, calls } = makeFakeEngine();
    await landRecords(engine, 'src-1', slugLeakConnector, slugLeakConnector.normalize(null, SRC));

    const insert = calls.find((c) => /INSERT INTO connector_candidates/.test(c.sql));
    expect(insert).toBeDefined();
    const p = insert!.params;
    const version = p[2] as string; // $3
    const provider = p[4] as string; // $5
    const proposedSlug = p[5] as string; // $6
    const proposedMarkdown = p[6] as string; // $7 — stub-generated (connector gave none), then stripped
    const rationaleRef = p[11] as string; // $12

    expect(proposedSlug).not.toContain(SECRET_MARKER);
    expect(rationaleRef).not.toContain(SECRET_MARKER);
    expect(provider).not.toContain(SECRET_MARKER);
    expect(version).not.toContain(SECRET_MARKER);
    // The stub embeds proposed_slug/provider/version into the body — must be stripped.
    expect(proposedMarkdown).not.toContain(SECRET_MARKER);
    // Nothing anywhere in the INSERT carries the raw secret.
    expect(JSON.stringify(p)).not.toContain(SECRET_MARKER);
  });
});
