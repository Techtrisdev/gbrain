/**
 * connector-calendar.test.ts — the Google Calendar SaaSConnector (TECH-2040).
 *
 * Mocks the Google Calendar API (fetch stub) and the TECH-2033 custody module so the
 * connector exercises normalize / incremental sync / OAuth WITHOUT a live API. Covers
 * the four ticket ACs:
 *
 *   AC3/AC4 — an event → a METADATA-ONLY candidate (no description / notes reach a row).
 *   AC2     — a 410 Gone on incremental sync → drops the syncToken + FULL resync.
 *   AC2     — a channel-token MISMATCH → verifyWebhook rejects (push auth is the token,
 *             not HMAC).
 *   AC2     — backfill lists events, lands candidates, persists the nextSyncToken.
 *
 * Candidate writes go through a fake engine that captures the toRow INSERT params and
 * models the surgical jsonb_set syncToken write (mirrors connector-linear.test.ts).
 */

import { describe, test, expect, mock, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';

// ── Mock the TECH-2033 custody module BEFORE importing the connector ─────────────

let issuedToken = 'fresh-token';
const getValidAccessTokenMock = mock(async (_e: BrainEngine, _s: string, _p: string) => {
  // Returns a BARE access token; the connector prepends `Bearer ` itself.
  return issuedToken;
});

mock.module('../src/core/connectors/credentials.ts', () => ({
  getValidAccessToken: getValidAccessTokenMock,
  storeToken: mock(async () => {}),
  registerOAuthProvider: mock(() => {}),
  // The connector reuses safeStateEqual for the constant-time channel-token compare;
  // use the REAL implementation so the mismatch test is meaningful.
  safeStateEqual: (a: string, b: string) => {
    if (a.length !== b.length || a.length === 0) return false;
    return a === b;
  },
}));

const { calendarConnector, incrementalSync, readSyncToken, CHANNEL_TOKEN_HEADER, CalendarGoneError } =
  await import('../src/core/connectors/calendar.ts');
const { landRecords } = await import('../src/core/connectors/base.ts');

// re-export the lowercase header literal used in tests (it is a module const)
const TOKEN_HEADER = calendarConnector.signatureHeader; // 'x-goog-channel-token'

const SECRET_MARKER = 'AKIAIOSFODNN7EXAMPLE'; // AWS-key-shaped; strip() masks it
const CHANNEL_SECRET = 'high-entropy-channel-token-abc123';

// ── Fake engine: captures connector_candidates INSERTs + sources config UPDATEs ──

function makeFakeEngine(opts: { initialConfig?: Record<string, Record<string, unknown>> } = {}) {
  const inserts: {
    source_record_id: string;
    provider: unknown;
    proposed_slug: unknown;
    proposed_markdown: string;
    confidence: unknown;
    redactions: unknown[];
    status: unknown;
    allParams: unknown[];
  }[] = [];
  const syncTokenWrites: { token: string | null; id: string }[] = [];
  const seenKeys = new Set<string>();
  const configState: Record<string, Record<string, unknown>> = { ...(opts.initialConfig ?? {}) };
  const engine = {
    kind: 'pglite',
    executeRaw: async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      if (/INSERT INTO connector_candidates/.test(sql)) {
        const key = `${p[0]}|${p[1]}|${p[2]}`;
        if (seenKeys.has(key)) return [];
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
      // Surgical syncToken write: jsonb_set(config, '{connectors,calendar,sync_token}', …).
      if (/UPDATE sources\s+SET config = jsonb_set/.test(sql)) {
        const tok = p[0] as string;
        const id = p[1] as string;
        syncTokenWrites.push({ token: tok, id });
        const cfg = (configState[id] ??= {});
        const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
        const cal = (connectors.calendar ??= {}) as Record<string, unknown>;
        cal.sync_token = tok;
        return [];
      }
      // syncToken clear: config #- '{connectors,calendar,sync_token}'.
      if (/SET config = config #- /.test(sql)) {
        const id = p[0] as string;
        syncTokenWrites.push({ token: null, id });
        const cal = ((configState[id]?.connectors as any)?.calendar) as Record<string, unknown> | undefined;
        if (cal) delete cal.sync_token;
        return [];
      }
      return [{ id: 0 }];
    },
  } as unknown as BrainEngine;
  return { engine, inserts, syncTokenWrites, configState };
}

// ── fetch stub for the Google Calendar events.list API ───────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  issuedToken = 'fresh-token';
});

/** Serve a queue of responses. Each entry is either a JSON page (status 200) or a
 *  `{ status }` marker (e.g. 410) so the test can drive the Gone path. */
function stubCalendarFetch(
  responses: ({ status: 200; body: unknown } | { status: number })[],
): { calls: { url: string; auth: string | undefined }[] } {
  const calls: { url: string; auth: string | undefined }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    calls.push({ url: String(url), auth });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if ('body' in r) {
      return { ok: true, status: 200, json: async () => r.body, text: async () => '' } as unknown as Response;
    }
    return { ok: r.status < 400, status: r.status, json: async () => ({}), text: async () => 'gone' } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

// ── A representative event (carrying a description with a secret) ──────────────────

const eventWithSecret = {
  id: 'event-abc',
  status: 'confirmed',
  htmlLink: 'https://calendar.google.com/event?eid=abc',
  summary: 'Quarterly board sync',
  description: `Discuss the Acme acquisition; wire details + ${SECRET_MARKER}; pay Jane Smith $250k`,
  organizer: { email: 'chair@example.com', displayName: 'Board Chair' },
  start: { dateTime: '2026-06-20T15:00:00Z' },
  end: { dateTime: '2026-06-20T16:00:00Z' },
  attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }, { email: 'c@x.com' }],
  updated: '2026-06-15T10:00:00.000Z',
};

// ── AC3/AC4: an event → a metadata-only candidate (no description / notes) ─────────

describe('Calendar normalize (AC3/AC4: metadata-only candidate)', () => {
  test('an event lands a high-confidence candidate; description/notes never reach a row', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = calendarConnector.normalize(eventWithSecret);
    expect(records).toHaveLength(1);

    const result = await landRecords(engine, 'src-cal', calendarConnector, records);
    expect(result).toEqual({ written: 1, total: 1 });

    const cand = inserts.find((r) => r.source_record_id === 'event-abc')!;
    expect(cand).toBeDefined();
    expect(cand.provider).toBe('calendar');
    expect(cand.confidence).toBe(0.9);
    expect(cand.status).toBe('pending');
    expect(cand.proposed_slug).toBe('calendar-event-event-abc');

    // The structural summary is title + start time — NOT the description.
    expect(cand.proposed_markdown).toBe('Quarterly board sync @ 2026-06-20T15:00:00Z');

    // The description (body) is dropped by minimize; NONE of its contents — secret,
    // PII, or deal terms strip() can't even catch — appear anywhere in the row.
    const blob = JSON.stringify(inserts);
    expect(blob).not.toContain(SECRET_MARKER);
    expect(blob).not.toContain('Jane Smith');
    expect(blob).not.toContain('250k');
    expect(blob).not.toContain('Acme acquisition');
    // A redaction-trail entry recorded the body drop.
    expect(JSON.stringify(cand.redactions)).toContain('body');
  });

  test('a secret in the event TITLE (kept→summary) is masked to [REDACTED]', async () => {
    const { engine, inserts } = makeFakeEngine();
    const ev = { id: 'event-titlesecret', summary: `urgent ${SECRET_MARKER} review`, start: { dateTime: '2026-06-20T15:00:00Z' } };
    await landRecords(engine, 'src-cal', calendarConnector, calendarConnector.normalize(ev));
    const cand = inserts.find((r) => r.source_record_id === 'event-titlesecret')!;
    expect(cand.proposed_markdown).not.toContain(SECRET_MARKER);
    expect(cand.proposed_markdown).toContain('[REDACTED]');
  });

  test('an events.list page normalizes every item', () => {
    const page = { items: [{ id: 'e1', summary: 'A' }, { id: 'e2', summary: 'B' }, { /* no id */ summary: 'skip' }] };
    const records = calendarConnector.normalize(page);
    expect(records.map((r) => r.sourceRecordId)).toEqual(['e1', 'e2']);
  });

  test('accountFromPayload returns null (push body is empty / header-authenticated)', () => {
    expect(calendarConnector.accountFromPayload({})).toBeNull();
  });
});

// ── AC2: a channel-token mismatch → verifyWebhook rejects ─────────────────────────

describe('Calendar verifyWebhook (AC2: channel-token compare, NOT HMAC)', () => {
  test('matching channel token → true', () => {
    const headers = { [TOKEN_HEADER]: CHANNEL_SECRET };
    expect(calendarConnector.verifyWebhook(Buffer.alloc(0), headers, CHANNEL_SECRET)).toBe(true);
  });

  test('channel-token mismatch → reject', () => {
    const headers = { [TOKEN_HEADER]: 'wrong-token' };
    expect(calendarConnector.verifyWebhook(Buffer.alloc(0), headers, CHANNEL_SECRET)).toBe(false);
  });

  test('missing channel-token header → reject', () => {
    expect(calendarConnector.verifyWebhook(Buffer.alloc(0), {}, CHANNEL_SECRET)).toBe(false);
  });

  test('empty secret → reject (fail closed)', () => {
    const headers = { [TOKEN_HEADER]: CHANNEL_SECRET };
    expect(calendarConnector.verifyWebhook(Buffer.alloc(0), headers, '')).toBe(false);
  });

  test('the signature header name is the Google channel-token header (lowercase)', () => {
    expect(CHANNEL_TOKEN_HEADER).toBe('x-goog-channel-token');
  });
});

// ── AC2: backfill lists events, lands candidates, persists the nextSyncToken ──────

describe('Calendar backfill (AC2: full list + syncToken persisted)', () => {
  test('pages through events, lands candidates, writes the terminal nextSyncToken', async () => {
    const { engine, inserts, syncTokenWrites, configState } = makeFakeEngine();
    const { calls } = stubCalendarFetch([
      { status: 200, body: { items: [{ id: 'e1', summary: 'A', start: { dateTime: '2026-06-20T15:00:00Z' } }], nextPageToken: 'pg2' } },
      { status: 200, body: { items: [{ id: 'e2', summary: 'B', start: { dateTime: '2026-06-21T15:00:00Z' } }], nextSyncToken: 'SYNC-TOKEN-1' } },
    ]);
    const source: ConnectorSource = { id: 'src-cal', config: { connectors: { calendar: { enabled: true, account: 'primary' } } } };

    const landed = await calendarConnector.backfill!(engine, source);
    expect(landed).toBe(2);
    expect(inserts.map((r) => r.source_record_id).sort()).toEqual(['e1', 'e2']);

    // Two list calls (page1 nextPageToken → page2). Both carry the BARE token under Bearer.
    expect(calls).toHaveLength(2);
    expect(calls[0].auth).toBe('Bearer fresh-token');
    // Full list (no syncToken) → singleEvents=true present.
    expect(calls[0].url).toContain('singleEvents=true');
    expect(calls[1].url).toContain('pageToken=pg2');

    // The terminal nextSyncToken persisted via the surgical jsonb_set path.
    expect(syncTokenWrites).toEqual([{ token: 'SYNC-TOKEN-1', id: 'src-cal' }]);
    expect((configState['src-cal'].connectors as any).calendar.sync_token).toBe('SYNC-TOKEN-1');
  });
});

// ── AC2: incremental sync + a 410 Gone → drop syncToken + full resync ─────────────

describe('Calendar incrementalSync (AC2: 410 Gone → full resync)', () => {
  test('with a stored syncToken, does an incremental list and advances the token', async () => {
    const { engine, inserts, syncTokenWrites } = makeFakeEngine();
    const { calls } = stubCalendarFetch([
      { status: 200, body: { items: [{ id: 'e-changed', summary: 'Moved', start: { dateTime: '2026-06-22T15:00:00Z' } }], nextSyncToken: 'SYNC-TOKEN-2' } },
    ]);
    const source: ConnectorSource = {
      id: 'src-cal',
      config: { connectors: { calendar: { enabled: true, account: 'primary', sync_token: 'SYNC-TOKEN-1' } } },
    };

    const landed = await incrementalSync(engine, source);
    expect(landed).toBe(1);
    expect(inserts.some((r) => r.source_record_id === 'e-changed')).toBe(true);
    // The incremental list carried the stored syncToken (and NO singleEvents — Google
    // rejects it alongside syncToken).
    expect(calls[0].url).toContain('syncToken=SYNC-TOKEN-1');
    expect(calls[0].url).not.toContain('singleEvents');
    expect(syncTokenWrites).toEqual([{ token: 'SYNC-TOKEN-2', id: 'src-cal' }]);
  });

  test('a 410 Gone drops the stored syncToken and FULL-resyncs', async () => {
    const { engine, inserts, syncTokenWrites } = makeFakeEngine({
      initialConfig: { 'src-cal': { connectors: { calendar: { enabled: true, account: 'primary', sync_token: 'STALE-TOKEN' } } } },
    });
    // First call (incremental, with the stale token) → 410 Gone.
    // Then the full-resync list returns a page with a fresh syncToken.
    const { calls } = stubCalendarFetch([
      { status: 410 },
      { status: 200, body: { items: [{ id: 'e-full', summary: 'Full resync event', start: { dateTime: '2026-06-23T15:00:00Z' } }], nextSyncToken: 'FRESH-TOKEN' } },
    ]);
    const source: ConnectorSource = {
      id: 'src-cal',
      config: { connectors: { calendar: { enabled: true, account: 'primary', sync_token: 'STALE-TOKEN' } } },
    };

    const landed = await incrementalSync(engine, source);
    // The full resync landed its event.
    expect(landed).toBe(1);
    expect(inserts.some((r) => r.source_record_id === 'e-full')).toBe(true);

    // First call was the incremental (stale token) that 410'd; the second was a FULL
    // list (no syncToken → singleEvents=true).
    expect(calls[0].url).toContain('syncToken=STALE-TOKEN');
    expect(calls[1].url).toContain('singleEvents=true');
    expect(calls[1].url).not.toContain('syncToken=');

    // The stale token was CLEARED (null write) and then the fresh token persisted.
    const clears = syncTokenWrites.filter((w) => w.token === null);
    const writes = syncTokenWrites.filter((w) => w.token === 'FRESH-TOKEN');
    expect(clears.length).toBeGreaterThanOrEqual(1);
    expect(writes.length).toBe(1);
  });

  test('listEvents throws CalendarGoneError on a raw 410 (the resync trigger)', async () => {
    stubCalendarFetch([{ status: 410 }]);
    const { listEvents } = await import('../src/core/connectors/calendar.ts');
    await expect(listEvents('fresh-token', 'primary', { syncToken: 'X' })).rejects.toBeInstanceOf(CalendarGoneError);
  });

  test('no stored syncToken (first push) → full resync via backfill', async () => {
    const { engine, inserts } = makeFakeEngine();
    stubCalendarFetch([
      { status: 200, body: { items: [{ id: 'e-first', summary: 'First', start: { dateTime: '2026-06-24T15:00:00Z' } }], nextSyncToken: 'SYNC-FIRST' } },
    ]);
    const source: ConnectorSource = { id: 'src-cal', config: { connectors: { calendar: { enabled: true, account: 'primary' } } } };
    expect(readSyncToken(source)).toBeNull();

    const landed = await incrementalSync(engine, source);
    expect(landed).toBe(1);
    expect(inserts.some((r) => r.source_record_id === 'e-first')).toBe(true);
  });
});
