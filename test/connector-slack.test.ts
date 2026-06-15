/**
 * connector-slack.test.ts — the Slack SaaSConnector (TECH-2039).
 *
 * Recorded-fixture tests covering AC5's required behaviors WITHOUT a live Slack API or
 * the TECH-2033 credentials module:
 *
 *   1. a message in a SELECTED public channel → a high-confidence summary candidate
 *      (NO raw body — the text never reaches the candidate verbatim). Exercised through
 *      the REAL receiver-shape call `normalize(parsed, source)`.
 *   2. a DM event (channel_type `im`/`mpim`) → ignored (no candidate); a non-opt-in
 *      channel → ignored.
 *   3. the v0 signing scheme: valid → accept; bad/stale/future/non-integer/edge timestamp
 *      and missing `v0=` prefix / missing header / tampered body → reject.
 *   4. the UNSIGNED url_verification handshake → echoes the challenge (no record).
 *   5. backfill: per-channel cursor (no cross-channel skip), monotonic watermark (never
 *      regresses under a replayed run), public-channel-class guard, token refresh, redaction.
 *
 * The credentials module (./credentials.ts) is mocked here so backfill exercises the
 * refresh-then-succeed flow against fixtures. fetch is stubbed to serve the recorded
 * history pages — no network. Candidate writes + the per-channel monotonic jsonb_set
 * watermark UPDATE go through a fake engine that captures params + models the SQL.
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
const { slackConnector, fetchHistoryPage, readChannelWatermark, readBackfillCursors, readOptInChannels } = await import(
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
const historyQuietChannel = loadFixture('history-quiet-channel.json');

const SECRET_MARKER = 'AKIAIOSFODNN7EXAMPLE'; // AWS-key-shaped; strip() masks it
const OPENAI_SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345'; // in the backfill fixture
const SIGNING_SECRET = 'slack-signing-secret-abc';
const BUSY_CHANNEL = 'C_ENG_GENERAL';
const QUIET_CHANNEL = 'C_OPS_QUIET';
const OPT_IN_CHANNELS = [BUSY_CHANNEL];

/** Build the resolved-source shape the receiver passes to normalize/backfill. */
function makeSource(opts: { channels?: string[]; backfill_cursor?: Record<string, string>; extra?: Record<string, unknown> } = {}): ConnectorSource {
  const slack: Record<string, unknown> = {
    enabled: true,
    account: 'T_ACME_123',
    channels: opts.channels ?? OPT_IN_CHANNELS,
    ...(opts.backfill_cursor ? { backfill_cursor: opts.backfill_cursor } : {}),
    ...(opts.extra ?? {}),
  };
  return { id: 'src-1', config: { connectors: { slack } } };
}

// ── Fake engine: captures candidate INSERTs + models the per-channel monotonic write ──

function makeFakeEngine(opts: { initialConfig?: Record<string, Record<string, unknown>> } = {}) {
  const inserts: { source_record_id: string; provider: unknown; proposed_slug: unknown; proposed_markdown: string; confidence: unknown; redactions: unknown[]; status: unknown; allParams: unknown[] }[] = [];
  const watermarkUpdates: { channel: string; watermark: string; id: string }[] = [];
  const seenKeys = new Set<string>();
  const configState: Record<string, Record<string, unknown>> = structuredClone(opts.initialConfig ?? {});
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
      // Per-channel MONOTONIC watermark write. The connector SQL is:
      //   UPDATE sources SET config = jsonb_set(jsonb_set(...backfill_cursor...), [...,$2], GREATEST(...,$3))
      // params: [$1=source.id, $2=channel, $3=watermark]
      if (/jsonb_set/.test(sql) && /backfill_cursor/.test(sql)) {
        const id = p[0] as string;
        const channel = p[1] as string;
        const watermark = p[2] as string;
        watermarkUpdates.push({ channel, watermark, id });
        const cfg = (configState[id] ??= {});
        const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
        const slack = (connectors.slack ??= {}) as Record<string, unknown>;
        const cursor = (slack.backfill_cursor ??= {}) as Record<string, string>;
        // Model GREATEST(existing, candidate) numerically — the write only advances.
        const existing = cursor[channel];
        if (existing === undefined || Number(watermark) > Number(existing)) {
          cursor[channel] = watermark;
        }
        return [];
      }
      // toRow's fetch-on-conflict SELECT
      return [{ id: 0 }];
    },
  } as unknown as BrainEngine;
  return { engine, inserts, watermarkUpdates, configState };
}

// ── Slack v0 signing helpers ──────────────────────────────────────────────────────

function slackSign(rawBody: Buffer, tsSeconds: number, secret = SIGNING_SECRET): string {
  const base = Buffer.concat([Buffer.from(`v0:${tsSeconds}:`, 'utf8'), rawBody]);
  return `v0=${createHmac('sha256', secret).update(base).digest('hex')}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function signedHeaders(rawBody: Buffer, tsSeconds: number, secret = SIGNING_SECRET): Record<string, string> {
  return {
    'x-slack-signature': slackSign(rawBody, tsSeconds, secret),
    'x-slack-request-timestamp': String(tsSeconds),
  };
}

// ── fetch stub for backfill (serves recorded history pages, per-channel routing) ──

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  refreshCount = 0;
});

/** Sequential page stub (one channel): serves `pages` in order. */
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

/** Per-channel page stub: routes each call to the right channel's page queue by `channel`. */
function stubHistoryByChannel(byChannel: Record<string, unknown[]>): { calls: { channel: string; body: URLSearchParams }[] } {
  const calls: { channel: string; body: URLSearchParams }[] = [];
  const idx: Record<string, number> = {};
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = new URLSearchParams(bodyText);
    const channel = body.get('channel') ?? '';
    calls.push({ channel, body });
    const queue = byChannel[channel] ?? [{ ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' } }];
    const i = idx[channel] ?? 0;
    idx[channel] = i + 1;
    const page = queue[Math.min(i, queue.length - 1)];
    return { ok: true, status: 200, json: async () => page, text: async () => '' } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

// ── 1. a SELECTED public-channel message → a candidate (RECEIVER-SHAPE call) ─────

describe('Slack webhook: selected-channel message → candidate', () => {
  test('THE KEYSTONE: normalize(parsed, source) for an enabled+opted-in source PRODUCES a candidate', async () => {
    const { engine, inserts } = makeFakeEngine();
    // Exactly the receiver's single call site: normalize(parsed, resolvedSource).
    const source = makeSource({ channels: [BUSY_CHANNEL] });
    const records = slackConnector.normalize(selectedChannelEvent, source);
    expect(records).toHaveLength(1);

    const result = await landRecords(engine, source.id, slackConnector, records);
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
    expect(JSON.stringify(candidate.redactions)).toContain('body');
  });

  test('the summary label is capped at 200 chars', () => {
    const longChannel = 'C_' + 'X'.repeat(400);
    const event = {
      type: 'event_callback',
      team_id: 'T_ACME_123',
      event: { type: 'message', channel: longChannel, channel_type: 'channel', user: 'U_J', text: 'hi', ts: '1700000000.000001' },
    };
    const source = makeSource({ channels: [longChannel] });
    const records = slackConnector.normalize(event, source);
    expect(records).toHaveLength(1);
    expect(records[0].item.summary!.length).toBeLessThanOrEqual(200);
  });

  test('accountFromPayload resolves the team_id', () => {
    expect(slackConnector.accountFromPayload(selectedChannelEvent)).toBe('T_ACME_123');
  });

  test('readOptInChannels reads sources.config.connectors.slack.channels[]', () => {
    const source = makeSource({ channels: [BUSY_CHANNEL, QUIET_CHANNEL] });
    expect(readOptInChannels(source)).toEqual([BUSY_CHANNEL, QUIET_CHANNEL]);
  });
});

// ── 2. DM / non-opt-in exclusion (with the source passed) ────────────────────────

describe('Slack webhook: DM and opt-in gating (source passed)', () => {
  test('an im (DM) event yields NO candidate even if its channel id were opted in', () => {
    // Opt the DM id in to prove the DM-class gate wins regardless.
    const source = makeSource({ channels: ['D_PRIVATE_DM'] });
    expect(slackConnector.normalize(dmEvent, source)).toHaveLength(0);
  });

  test('an mpim (group DM) event yields NO candidate', () => {
    const mpim = {
      type: 'event_callback',
      team_id: 'T_ACME_123',
      event: { type: 'message', channel: 'G_GROUP_DM', channel_type: 'mpim', user: 'U_X', text: 'hi', ts: '1700000000.000999' },
    };
    expect(slackConnector.normalize(mpim, makeSource({ channels: ['G_GROUP_DM'] }))).toHaveLength(0);
  });

  test('a message in a NON-opt-in channel yields no candidate (source passed)', () => {
    const source = makeSource({ channels: ['C_SOME_OTHER'] });
    expect(slackConnector.normalize(selectedChannelEvent, source)).toHaveLength(0);
  });

  test('an empty opt-in list ingests nothing (fail-closed)', () => {
    const source = makeSource({ channels: [] });
    expect(slackConnector.normalize(selectedChannelEvent, source)).toHaveLength(0);
  });

  test('a message subtype (edit/join/bot noise) is ignored even in an opt-in channel', () => {
    const edited = {
      type: 'event_callback',
      team_id: 'T_ACME_123',
      event: { type: 'message', subtype: 'message_changed', channel: BUSY_CHANNEL, channel_type: 'channel', user: 'U_JORDAN', text: 'edited', ts: '1700000000.000777' },
    };
    expect(slackConnector.normalize(edited, makeSource())).toHaveLength(0);
  });

  test('a non-message event (e.g. reaction_added) is ignored', () => {
    const reaction = {
      type: 'event_callback',
      team_id: 'T_ACME_123',
      event: { type: 'reaction_added', channel: BUSY_CHANNEL, user: 'U_JORDAN', ts: '1700000000.000888' },
    };
    expect(slackConnector.normalize(reaction, makeSource())).toHaveLength(0);
  });

  test('a url_verification envelope is NOT a normalize target (handled by handshake instead)', () => {
    const challenge = { type: 'url_verification', challenge: 'abc', token: 'xyz' };
    expect(slackConnector.normalize(challenge, makeSource())).toHaveLength(0);
  });
});

// ── 3. verifyWebhook (AC3: v0 signing-secret + 300s window, constant-time) ───────

describe('Slack verifyWebhook (AC3: v0 HMAC + 300s window)', () => {
  const body = Buffer.from(JSON.stringify(selectedChannelEvent), 'utf8');

  test('valid v0 signature + fresh timestamp → true', () => {
    const ts = nowSeconds();
    expect(slackConnector.verifyWebhook(body, signedHeaders(body, ts), SIGNING_SECRET)).toBe(true);
  });

  test('bad signature (wrong secret) → reject', () => {
    const ts = nowSeconds();
    expect(slackConnector.verifyWebhook(body, signedHeaders(body, ts, 'wrong-secret'), SIGNING_SECRET)).toBe(false);
  });

  test('tampered body → reject (HMAC over the verbatim body)', () => {
    const ts = nowSeconds();
    const headers = signedHeaders(body, ts);
    const tampered = Buffer.from(body);
    tampered[15] = tampered[15] ^ 0xff;
    expect(slackConnector.verifyWebhook(tampered, headers, SIGNING_SECRET)).toBe(false);
  });

  test('STALE timestamp (>300s old, replay) → reject', () => {
    const ts = nowSeconds() - 400;
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

// ── 4. url_verification handshake (AC1) ──────────────────────────────────────────

describe('Slack handshake (AC1: unsigned url_verification challenge)', () => {
  test('a url_verification envelope returns the challenge to echo', () => {
    const result = slackConnector.handshake!({ type: 'url_verification', challenge: 'nonce-xyz', token: 't' });
    expect(result).toEqual({ challenge: 'nonce-xyz' });
  });

  test('a normal event_callback is NOT a handshake (returns null → signed path proceeds)', () => {
    expect(slackConnector.handshake!(selectedChannelEvent)).toBeNull();
  });

  test('a url_verification with no challenge string returns null (nothing to echo)', () => {
    expect(slackConnector.handshake!({ type: 'url_verification' })).toBeNull();
  });
});

// ── 5. backfill (AC2: per-channel cursor + monotonic watermark, resume-safe) ──────

describe('Slack backfill (AC2: per-channel conversations.history cursor + ts watermark)', () => {
  test('pages a busy channel through both fixtures, lands candidates, advances its watermark', async () => {
    const { engine, inserts, watermarkUpdates, configState } = makeFakeEngine();
    const { calls } = stubHistoryFetch([historyPage1, historyPage2]);

    const landed = await slackConnector.backfill!(engine, makeSource({ channels: [BUSY_CHANNEL] }));

    // page1: 2 plain; page2: 1 plain + 1 channel_join subtype (skipped) → 3.
    expect(landed).toBe(3);
    expect(inserts.some((r) => r.source_record_id === 'C_ENG_GENERAL:1700000100.000100')).toBe(true);
    expect(inserts.some((r) => r.source_record_id === 'C_ENG_GENERAL:1700000400.000100')).toBe(true);
    expect(inserts.some((r) => r.source_record_id === 'C_ENG_GENERAL:1700000300.000100')).toBe(false);

    expect(calls).toHaveLength(2);
    expect(calls[0].body.get('channel')).toBe(BUSY_CHANNEL);
    expect(calls[0].body.get('cursor')).toBeNull();
    expect(calls[1].body.get('cursor')).toBe('cursor-page-1');

    // Watermark advanced PER-CHANNEL to the newest ts.
    expect(watermarkUpdates).toEqual([{ channel: BUSY_CHANNEL, watermark: '1700000400.000100', id: 'src-1' }]);
    expect((configState['src-1'].connectors as any).slack.backfill_cursor).toEqual({ [BUSY_CHANNEL]: '1700000400.000100' });
  });

  test('TWO channels with uneven activity: BOTH fully paged, the quiet channel is NOT skipped', async () => {
    const { engine, inserts, configState } = makeFakeEngine();
    const { calls } = stubHistoryByChannel({
      [BUSY_CHANNEL]: [historyPage1, historyPage2],
      [QUIET_CHANNEL]: [historyQuietChannel],
    });

    const landed = await slackConnector.backfill!(engine, makeSource({ channels: [BUSY_CHANNEL, QUIET_CHANNEL] }));

    // busy: 3 plain; quiet: 1 plain → 4.
    expect(landed).toBe(4);
    // The quiet channel's single (older-than-busy's-newest) message landed — NOT skipped by
    // the busy channel's higher watermark, because each channel has its own cursor.
    expect(inserts.some((r) => r.source_record_id === 'C_OPS_QUIET:1700000150.000100')).toBe(true);

    // Each channel paged from its OWN (initially empty) cursor — neither started at the
    // other's watermark. The first call per channel has no `oldest`.
    const busyFirst = calls.find((c) => c.channel === BUSY_CHANNEL)!;
    const quietFirst = calls.find((c) => c.channel === QUIET_CHANNEL)!;
    expect(busyFirst.body.get('oldest')).toBeNull();
    expect(quietFirst.body.get('oldest')).toBeNull();

    // Per-channel watermarks recorded independently.
    const cursor = (configState['src-1'].connectors as any).slack.backfill_cursor;
    expect(cursor[BUSY_CHANNEL]).toBe('1700000400.000100');
    expect(cursor[QUIET_CHANNEL]).toBe('1700000150.000100');
  });

  test('resume passes the channel watermark as `oldest` (inclusive=false) and yields no duplicates', async () => {
    const source = makeSource({ channels: [BUSY_CHANNEL], backfill_cursor: { [BUSY_CHANNEL]: '1700000400.000100' } });
    expect(readChannelWatermark(source, BUSY_CHANNEL)).toBe('1700000400.000100');

    const emptyPage = { ok: true, messages: [], has_more: false, response_metadata: { next_cursor: '' } };
    const { engine, inserts } = makeFakeEngine();
    const { calls } = stubHistoryFetch([emptyPage]);

    const landed = await slackConnector.backfill!(engine, source);
    expect(landed).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(calls[0].body.get('oldest')).toBe('1700000400.000100');
    expect(calls[0].body.get('inclusive')).toBe('false');
  });

  test('MONOTONIC: a replayed run observing an OLDER newestTs never regresses the stored cursor', async () => {
    // Source already carries a NEWER watermark than the page this run will observe.
    const { engine, configState } = makeFakeEngine({
      initialConfig: {
        'src-1': { connectors: { slack: { enabled: true, account: 'T_ACME_123', channels: [BUSY_CHANNEL], backfill_cursor: { [BUSY_CHANNEL]: '1700000400.000100' } } } },
      },
    });
    // A stale/retried run re-fetches an OLDER page (its `oldest` filter is bypassed by the
    // stub, simulating a races/replay where it sees an older message than the stored cursor).
    const olderPage = {
      ok: true,
      messages: [{ type: 'message', user: 'U_OLD', text: 'older', ts: '1700000100.000100' }],
      has_more: false,
      response_metadata: { next_cursor: '' },
    };
    stubHistoryFetch([olderPage]);

    // Feed the connector a STALE snapshot with no cursor, so its in-memory newestTs would be
    // the older ts — the SERVER-SIDE GREATEST must still refuse to move the cursor back.
    const staleSnapshot = makeSource({ channels: [BUSY_CHANNEL] });
    await slackConnector.backfill!(engine, staleSnapshot);

    const cursor = (configState['src-1'].connectors as any).slack.backfill_cursor;
    // The stored cursor stayed at the NEWER value — never regressed to 1700000100.
    expect(cursor[BUSY_CHANNEL]).toBe('1700000400.000100');
  });

  test('a DM/private channel id mis-curated into the opt-in list is REJECTED on backfill', async () => {
    const { engine, inserts } = makeFakeEngine();
    const { calls } = stubHistoryByChannel({});
    // A private (G) and DM (D) id sneaked into the opt-in list alongside a real public one.
    await slackConnector.backfill!(engine, makeSource({ channels: ['G_PRIVATE', 'D_DM', BUSY_CHANNEL] }));
    // Only the public channel was ever fetched; the G/D ids were skipped pre-fetch.
    const fetched = new Set(calls.map((c) => c.channel));
    expect(fetched.has('G_PRIVATE')).toBe(false);
    expect(fetched.has('D_DM')).toBe(false);
    expect(fetched.has(BUSY_CHANNEL)).toBe(true);
    expect(inserts.every((r) => r.source_record_id.startsWith('C'))).toBe(true);
  });

  test('backfill calls getValidAccessToken (custody refresh) and uses the fresh BARE token', async () => {
    const { engine } = makeFakeEngine();
    const { calls } = stubHistoryFetch([historyPage1, historyPage2]);

    await slackConnector.backfill!(engine, makeSource({ channels: [BUSY_CHANNEL] }));

    expect(getValidAccessTokenMock).toHaveBeenCalled();
    expect(refreshCount).toBeGreaterThanOrEqual(1);
    expect(issuedToken).not.toContain('Bearer');
    expect(calls[0].auth).toBe(`Bearer ${issuedToken}`);
    expect(calls[0].auth).toContain('fresh-token');
  });

  test('a re-fetch of the SAME messages is a no-op (ON CONFLICT) — duplicate-delivery safe', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = slackConnector.normalize(selectedChannelEvent, makeSource({ channels: [BUSY_CHANNEL] }));
    await landRecords(engine, 'src-1', slackConnector, records);
    const firstCount = inserts.length;
    const second = await landRecords(engine, 'src-1', slackConnector, records);
    expect(second.written).toBe(0);
    expect(inserts.length).toBe(firstCount);
  });

  test('a secret in a backfilled message body never reaches a candidate verbatim', async () => {
    const { engine, inserts } = makeFakeEngine();
    stubHistoryFetch([historyPage1, historyPage2]);
    await slackConnector.backfill!(engine, makeSource({ channels: [BUSY_CHANNEL] }));
    const blob = JSON.stringify(inserts);
    expect(blob).not.toContain(OPENAI_SECRET);
    expect(blob).not.toContain('Second backfilled message');
  });

  test('readBackfillCursors returns {} on a never-backfilled source', () => {
    expect(readBackfillCursors(makeSource())).toEqual({});
  });
});
