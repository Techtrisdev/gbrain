/**
 * connector-slack.test.ts — the Slack SaaSConnector (TECH-2039).
 *
 * Recorded-fixture tests covering AC5's required behaviors WITHOUT a live Slack API or
 * the TECH-2033 credentials module:
 *
 *   1. a message in a SELECTED public channel → a high-confidence summary candidate
 *      (NO raw body — the text never reaches the candidate verbatim).
 *   2. a DM event (channel_type `im`/`mpim`) → ignored (no candidate).
 *   3. a non-opt-in channel message → ignored (no candidate).
 *   4. verifyWebhook (the v0 signing scheme): valid → accept; bad signature → reject;
 *      stale/future/non-integer timestamp (the ±300s window) → reject; a missing `v0=`
 *      prefix → reject; a missing timestamp header → reject; a tampered body → reject.
 *   5. backfill: pages conversations.history per opt-in channel, advances the `ts`
 *      watermark, refreshes the token via custody (mocked), and masks a secret.
 *
 * The credentials module (./credentials.ts) is mocked here so backfill exercises the
 * refresh-then-succeed flow against fixtures. fetch is stubbed to serve the recorded
 * history pages — no network. Candidate writes go through a fake engine that captures
 * the toRow INSERT params (mirrors test/connector-linear.test.ts).
 */

import { describe, test, expect, mock, afterEach } from 'bun:test';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';

// ── Mock the TECH-2033 custody module BEFORE importing the connector ─────────────

let refreshCount = 0;
let issuedToken = 'expired-token';
const getValidAccessTokenMock = mock(async (_engine: BrainEngine, _sourceId: string, _provider: string) => {
  // Simulate custody refreshing an expired token: returns a BARE token (no scheme); the
  // connector prepends `Bearer ` itself.
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
const { slackConnector, fetchHistoryPage, readBackfillWatermark, readOptInChannels } = await import(
  '../src/core/connectors/slack.ts'
);
const { landRecords } = await import('../src/core/connectors/base.ts');

// ── Fixtures ─────────────────────────────────────────────────────────────────────

const FIX = join(import.meta.dir, 'fixtures', 'slack');
function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8')) as Record<string, unknown>;
}
const selectedChannelEvent = loadFixture('event-message-selected-channel.json');
const dmEvent = loadFixture('event-message-dm.json');
const historyPage1 = loadFixture('history-page1.json');
const historyPage2 = loadFixture('history-page2.json');

const SECRET_MARKER = 'AKIAIOSFODNN7EXAMPLE'; // AWS-key-shaped; strip() masks it
const OPENAI_SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345'; // in the backfill fixture
const SIGNING_SECRET = 'slack-signing-secret-abc';
const OPT_IN_CHANNELS = ['C_ENG_GENERAL'];

// ── Fake engine: captures connector_candidates INSERTs + sources config UPDATEs ──

function makeFakeEngine(opts: { initialConfig?: Record<string, Record<string, unknown>> } = {}) {
  const inserts: { source_record_id: string; provider: unknown; proposed_slug: unknown; proposed_markdown: string; confidence: unknown; redactions: unknown[]; status: unknown; allParams: unknown[] }[] = [];
  const watermarkUpdates: { watermark: string; id: string }[] = [];
  const seenKeys = new Set<string>();
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
        });
        return [{ id: inserts.length }];
      }
      // Surgical watermark write: jsonb_set(config, '{connectors,slack,backfill_cursor}', …).
      if (/UPDATE sources\s+SET config = jsonb_set/.test(sql)) {
        const watermark = p[0] as string;
        const id = p[1] as string;
        watermarkUpdates.push({ watermark, id });
        const cfg = (configState[id] ??= {});
        const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
        const slack = (connectors.slack ??= {}) as Record<string, unknown>;
        slack.backfill_cursor = watermark;
        return [];
      }
      // toRow's fetch-on-conflict SELECT
      return [{ id: 0 }];
    },
  } as unknown as BrainEngine;
  return { engine, inserts, watermarkUpdates, configState };
}

// ── Slack v0 signing helper ────────────────────────────────────────────────────

/** Build a correct `v0=` signature over `v0:{ts}:{rawBody}`. */
function slackSign(rawBody: Buffer, tsSeconds: number, secret = SIGNING_SECRET): string {
  const base = Buffer.concat([Buffer.from(`v0:${tsSeconds}:`, 'utf8'), rawBody]);
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Headers for a correctly-signed delivery at `tsSeconds`. */
function signedHeaders(rawBody: Buffer, tsSeconds: number, secret = SIGNING_SECRET): Record<string, string> {
  return {
    'x-slack-signature': slackSign(rawBody, tsSeconds, secret),
    'x-slack-request-timestamp': String(tsSeconds),
  };
}

// ── fetch stub for backfill (serves the recorded history pages) ──────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  refreshCount = 0;
});

function stubHistoryFetch(pages: unknown[]): { calls: { body: URLSearchParams; auth: string | undefined }[] } {
  const calls: { body: URLSearchParams; auth: string | undefined }[] = [];
  let i = 0;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = new URLSearchParams(bodyText);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ body, auth });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    return { ok: true, status: 200, json: async () => page, text: async () => '' } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

// ── 1. a message in a SELECTED public channel → a summary candidate ──────────────

describe('Slack webhook: selected-channel message → candidate', () => {
  test('emits a high-confidence pending summary candidate (NO raw body)', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = slackConnector.normalize(selectedChannelEvent, OPT_IN_CHANNELS);
    expect(records).toHaveLength(1);

    const result = await landRecords(engine, 'src-1', slackConnector, records);
    expect(result).toEqual({ written: 1, total: 1 });

    const candidate = inserts[0];
    expect(candidate.source_record_id).toBe('C_ENG_GENERAL:1700000000.000100');
    expect(candidate.provider).toBe('slack');
    expect(candidate.confidence).toBe(0.85);
    expect(candidate.status).toBe('pending');
    // Summary is a structural label — channel + author + ts — NOT body-derived.
    expect(candidate.proposed_markdown).toBe('Message in C_ENG_GENERAL by U_JORDAN @ 1700000000.000100');
    // The raw text (and the secret it carried) NEVER reaches the candidate verbatim.
    const blob = JSON.stringify(inserts);
    expect(blob).not.toContain('Decided to ship');
    expect(blob).not.toContain(SECRET_MARKER);
    // A redaction-trail entry recorded the dropped body.
    expect(JSON.stringify(candidate.redactions)).toContain('body');
  });

  test('accountFromPayload resolves the team_id', () => {
    expect(slackConnector.accountFromPayload(selectedChannelEvent)).toBe('T_ACME_123');
  });

  test('readOptInChannels reads sources.config.connectors.slack.channels[]', () => {
    const source: ConnectorSource = {
      id: 'src-1',
      config: { connectors: { slack: { enabled: true, account: 'T_ACME_123', channels: ['C_ENG_GENERAL', 'C_OPS'] } } },
    };
    expect(readOptInChannels(source)).toEqual(['C_ENG_GENERAL', 'C_OPS']);
  });
});

// ── 2. a DM event → ignored (no candidate) ───────────────────────────────────────

describe('Slack webhook: DM events are always ignored', () => {
  test('an im (DM) event yields NO candidate even if its channel were opted in', () => {
    // Pass the DM channel id as opted-in to prove the DM gate wins regardless.
    const records = slackConnector.normalize(dmEvent, ['D_PRIVATE_DM']);
    expect(records).toHaveLength(0);
  });

  test('an mpim (group DM) event yields NO candidate', () => {
    const mpim = {
      type: 'event_callback',
      team_id: 'T_ACME_123',
      event: { type: 'message', channel: 'G_GROUP_DM', channel_type: 'mpim', user: 'U_X', text: 'hi', ts: '1700000000.000999' },
    };
    expect(slackConnector.normalize(mpim, ['G_GROUP_DM'])).toHaveLength(0);
  });
});

// ── 3. a non-opt-in channel message → ignored ───────────────────────────────────

describe('Slack webhook: opt-in channel gating', () => {
  test('a message in a NON-opt-in channel yields no candidate', () => {
    expect(slackConnector.normalize(selectedChannelEvent, ['C_SOME_OTHER'])).toHaveLength(0);
  });

  test('no opt-in list provided → fail-closed (no candidate)', () => {
    expect(slackConnector.normalize(selectedChannelEvent)).toHaveLength(0);
  });

  test('a message subtype (edit/join/bot noise) is ignored even in an opt-in channel', () => {
    const edited = {
      type: 'event_callback',
      team_id: 'T_ACME_123',
      event: { type: 'message', subtype: 'message_changed', channel: 'C_ENG_GENERAL', channel_type: 'channel', user: 'U_JORDAN', text: 'edited', ts: '1700000000.000777' },
    };
    expect(slackConnector.normalize(edited, OPT_IN_CHANNELS)).toHaveLength(0);
  });

  test('a non-message event (e.g. reaction_added) is ignored', () => {
    const reaction = {
      type: 'event_callback',
      team_id: 'T_ACME_123',
      event: { type: 'reaction_added', channel: 'C_ENG_GENERAL', user: 'U_JORDAN', ts: '1700000000.000888' },
    };
    expect(slackConnector.normalize(reaction, OPT_IN_CHANNELS)).toHaveLength(0);
  });

  test('a url_verification envelope is ignored (not an event_callback)', () => {
    const challenge = { type: 'url_verification', challenge: 'abc', token: 'xyz' };
    expect(slackConnector.normalize(challenge, OPT_IN_CHANNELS)).toHaveLength(0);
  });
});

// ── 4. verifyWebhook (AC3: v0 signing-secret + 300s window, constant-time) ───────

describe('Slack verifyWebhook (AC3: v0 HMAC + 300s window)', () => {
  const body = Buffer.from(JSON.stringify(selectedChannelEvent), 'utf8');

  test('valid v0 signature + fresh timestamp → true', () => {
    const ts = nowSeconds();
    expect(slackConnector.verifyWebhook(body, signedHeaders(body, ts), SIGNING_SECRET)).toBe(true);
  });

  test('bad signature (wrong secret) → reject', () => {
    const ts = nowSeconds();
    const headers = signedHeaders(body, ts, 'wrong-secret');
    expect(slackConnector.verifyWebhook(body, headers, SIGNING_SECRET)).toBe(false);
  });

  test('tampered body → reject (HMAC over the verbatim body)', () => {
    const ts = nowSeconds();
    const headers = signedHeaders(body, ts);
    const tampered = Buffer.from(body);
    tampered[15] = tampered[15] ^ 0xff;
    expect(slackConnector.verifyWebhook(tampered, headers, SIGNING_SECRET)).toBe(false);
  });

  test('STALE timestamp (>300s old, replay) → reject', () => {
    const ts = nowSeconds() - 400; // 400s old, outside the 300s window
    // Signed correctly FOR that stale ts, so the rejection is the window's doing alone.
    expect(slackConnector.verifyWebhook(body, signedHeaders(body, ts), SIGNING_SECRET)).toBe(false);
  });

  test('FUTURE timestamp (>300s ahead) → reject', () => {
    const ts = nowSeconds() + 400;
    expect(slackConnector.verifyWebhook(body, signedHeaders(body, ts), SIGNING_SECRET)).toBe(false);
  });

  test('a timestamp at the edge of the window (300s old) → accept', () => {
    const ts = nowSeconds() - 300;
    expect(slackConnector.verifyWebhook(body, signedHeaders(body, ts), SIGNING_SECRET)).toBe(true);
  });

  test('missing v0= prefix (bare hex digest) → reject', () => {
    const ts = nowSeconds();
    const bareHex = createHmac('sha256', SIGNING_SECRET)
      .update(Buffer.concat([Buffer.from(`v0:${ts}:`, 'utf8'), body]))
      .digest('hex');
    const headers = { 'x-slack-signature': bareHex, 'x-slack-request-timestamp': String(ts) };
    expect(slackConnector.verifyWebhook(body, headers, SIGNING_SECRET)).toBe(false);
  });

  test('a future scheme version (v1=) → reject', () => {
    const ts = nowSeconds();
    const sig = slackSign(body, ts).replace('v0=', 'v1=');
    const headers = { 'x-slack-signature': sig, 'x-slack-request-timestamp': String(ts) };
    expect(slackConnector.verifyWebhook(body, headers, SIGNING_SECRET)).toBe(false);
  });

  test('missing signature header → reject', () => {
    const ts = nowSeconds();
    expect(slackConnector.verifyWebhook(body, { 'x-slack-request-timestamp': String(ts) }, SIGNING_SECRET)).toBe(false);
  });

  test('missing timestamp header → reject', () => {
    const ts = nowSeconds();
    expect(slackConnector.verifyWebhook(body, { 'x-slack-signature': slackSign(body, ts) }, SIGNING_SECRET)).toBe(false);
  });

  test('non-integer timestamp → reject', () => {
    const ts = nowSeconds();
    const headers = { 'x-slack-signature': slackSign(body, ts), 'x-slack-request-timestamp': 'not-a-number' };
    expect(slackConnector.verifyWebhook(body, headers, SIGNING_SECRET)).toBe(false);
  });
});

// ── 5. backfill (AC2: conversations.history cursor + watermark, resume-safe) ──────

describe('Slack backfill (AC2: conversations.history cursor + ts watermark)', () => {
  function sourceWithChannels(extra: Record<string, unknown> = {}): ConnectorSource {
    return {
      id: 'src-1',
      config: { connectors: { slack: { enabled: true, account: 'T_ACME_123', channels: OPT_IN_CHANNELS, ...extra } } },
    };
  }

  test('pages through both fixtures, lands candidates, advances the ts watermark', async () => {
    const { engine, inserts, watermarkUpdates, configState } = makeFakeEngine();
    const { calls } = stubHistoryFetch([historyPage1, historyPage2]);

    const landed = await slackConnector.backfill!(engine, sourceWithChannels());

    // page1 has 2 plain messages; page2 has 1 plain + 1 channel_join subtype (skipped) → 3.
    expect(landed).toBe(3);
    expect(inserts.some((r) => r.source_record_id === 'C_ENG_GENERAL:1700000100.000100')).toBe(true);
    expect(inserts.some((r) => r.source_record_id === 'C_ENG_GENERAL:1700000400.000100')).toBe(true);
    // The channel_join subtype was skipped (no candidate for its ts).
    expect(inserts.some((r) => r.source_record_id === 'C_ENG_GENERAL:1700000300.000100')).toBe(false);

    // Two fetch calls (page1 has_more=true → page2 has_more=false → stop).
    expect(calls).toHaveLength(2);
    expect(calls[0].body.get('channel')).toBe('C_ENG_GENERAL');
    expect(calls[0].body.get('cursor')).toBeNull(); // first page: no cursor
    expect(calls[1].body.get('cursor')).toBe('cursor-page-1'); // second page uses page1's next_cursor

    // Watermark advanced to the newest message ts (1700000400.000100) via jsonb_set.
    expect(watermarkUpdates).toHaveLength(1);
    expect(watermarkUpdates[0].watermark).toBe('1700000400.000100');
    expect((configState['src-1'].connectors as any).slack.backfill_cursor).toBe('1700000400.000100');
  });

  test('resume from the advanced watermark passes it as `oldest` and yields no duplicates', async () => {
    const source = sourceWithChannels({ backfill_cursor: '1700000400.000100' });
    expect(readBackfillWatermark(source)).toBe('1700000400.000100');

    const emptyPage = { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' } };
    const { engine, inserts } = makeFakeEngine();
    const { calls } = stubHistoryFetch([emptyPage]);

    const landed = await slackConnector.backfill!(engine, source);
    expect(landed).toBe(0);
    expect(inserts).toHaveLength(0);
    // The watermark was passed as `oldest` with inclusive=false → only strictly-newer msgs.
    expect(calls[0].body.get('oldest')).toBe('1700000400.000100');
    expect(calls[0].body.get('inclusive')).toBe('false');
  });

  test('backfill calls getValidAccessToken (custody refresh) and uses the fresh BARE token', async () => {
    const { engine } = makeFakeEngine();
    const { calls } = stubHistoryFetch([historyPage1, historyPage2]);

    await slackConnector.backfill!(engine, sourceWithChannels());

    expect(getValidAccessTokenMock).toHaveBeenCalled();
    expect(refreshCount).toBeGreaterThanOrEqual(1);
    // getValidAccessToken returns a BARE token; the connector prepends `Bearer `.
    expect(issuedToken).not.toContain('Bearer');
    expect(calls[0].auth).toBe(`Bearer ${issuedToken}`);
    expect(calls[0].auth).toContain('fresh-token');
  });

  test('a re-fetch of the SAME messages is a no-op (ON CONFLICT) — duplicate-delivery safe', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = slackConnector.normalize(selectedChannelEvent, OPT_IN_CHANNELS);
    await landRecords(engine, 'src-1', slackConnector, records);
    const firstCount = inserts.length;
    const second = await landRecords(engine, 'src-1', slackConnector, records);
    expect(second.written).toBe(0); // ON CONFLICT DO NOTHING
    expect(inserts.length).toBe(firstCount);
  });

  test('a secret in a backfilled message body never reaches a candidate verbatim', async () => {
    const { engine, inserts } = makeFakeEngine();
    const { } = stubHistoryFetch([historyPage1, historyPage2]);
    await slackConnector.backfill!(engine, sourceWithChannels());
    const blob = JSON.stringify(inserts);
    // The body (text) is dropped by minimize — neither the OpenAI-shaped secret nor the
    // surrounding prose appears on any candidate.
    expect(blob).not.toContain(OPENAI_SECRET);
    expect(blob).not.toContain('Second backfilled message');
  });
});
