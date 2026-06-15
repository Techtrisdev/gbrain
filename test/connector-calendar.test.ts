/**
 * connector-calendar.test.ts — the Google Calendar SaaSConnector (TECH-2040).
 *
 * Mocks the Google Calendar API (fetch stub) so the connector exercises normalize /
 * incremental sync / OAuth WITHOUT a live API. Covers the four ticket ACs:
 *
 *   AC3/AC4 — an event → a METADATA-ONLY candidate (no description / notes reach a row).
 *   AC2     — a 410 Gone on incremental sync → drops the syncToken + FULL resync.
 *   AC2     — a channel-token MISMATCH → verifyWebhook rejects (push auth is the token,
 *             not HMAC).
 *   AC2     — backfill lists events, lands candidates, persists the nextSyncToken.
 *
 * NO mock.module: this file uses the REAL TECH-2033 custody module end-to-end. The
 * connector's getValidAccessToken call runs against the REAL credentials code path,
 * reading a REAL AES-256-GCM-sealed connector_tokens row that the fake engine returns
 * (sealed here with the real sealToken under a test GBRAIN_CONNECTOR_MASTER_KEY). This is
 * a deliberate improvement over connector-linear.test.ts's mock.module footprint: bun's
 * mock.module is PROCESS-GLOBAL, so stubbing getValidAccessToken/storeToken there shadows
 * the real custody module for connector-credentials.test.ts whenever the two files share
 * one bun shard process (the FNV-1a sharder in scripts/test-shard.sh does not guarantee
 * separation). Driving the real custody code avoids that cross-file hazard entirely AND
 * exercises the real safeStateEqual (finding 5) + withInProcessLock (finding 2).
 *
 * Candidate writes go through a fake engine that captures the toRow INSERT params and
 * models the surgical jsonb_set syncToken write (mirrors connector-linear.test.ts).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';
import { sealToken, type StoredToken } from '../src/core/connectors/credentials.ts';

// A 32-byte hex master key so the REAL sealToken/openToken AES-256-GCM path works. Set
// at top-level (synchronously, before any seal/open) and only if unset, so we never
// clobber a real key a co-resident test or the environment already provided.
if (!process.env.GBRAIN_CONNECTOR_MASTER_KEY) {
  process.env.GBRAIN_CONNECTOR_MASTER_KEY = '11'.repeat(32);
}

const { calendarConnector, incrementalSync, readSyncToken, CHANNEL_TOKEN_HEADER, CalendarGoneError } =
  await import('../src/core/connectors/calendar.ts');
const { landRecords } = await import('../src/core/connectors/base.ts');

/** The bare access token the sealed connector_tokens row decrypts to — what the real
 *  getValidAccessToken returns and the connector prepends `Bearer ` to. */
const ACCESS_TOKEN = 'fresh-token';

/** Seal a StoredToken into the {kid,iv,ciphertext,tag} envelope a connector_tokens row
 *  stores, using the REAL sealToken. Used to seed the fake engine's token row. */
function sealedTokenRow(sourceId: string, account: string) {
  const tok: StoredToken = {
    accessToken: ACCESS_TOKEN,
    refreshToken: 'refresh-abc',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000), // far from expiry → no refresh
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    account,
  };
  const env = sealToken(tok);
  return {
    id: 1,
    source_id: sourceId,
    provider: 'calendar',
    account,
    kid: env.kid,
    iv: env.iv,
    ciphertext: env.ciphertext,
    tag: env.tag,
    expires_at: tok.expiresAt,
    status: 'active',
  };
}

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
  const watchChannelWrites: { patch: Record<string, unknown>; id: string }[] = [];
  const seenKeys = new Set<string>();
  const configState: Record<string, Record<string, unknown>> = { ...(opts.initialConfig ?? {}) };
  // The connector_tokens row the REAL getValidAccessToken reads. Seeded per source-id on
  // first lookup so the connector's getValidAccessToken(...) resolves to ACCESS_TOKEN.
  const tokenRows = new Map<string, ReturnType<typeof sealedTokenRow>>();
  const executeRaw = async (sql: string, params?: unknown[]) => {
      const p = params ?? [];
      // The REAL getValidAccessToken's readRow SELECT against connector_tokens. Return a
      // freshly-sealed active row so the real decrypt path yields ACCESS_TOKEN (and, being
      // far from expiry, never refreshes). account mirrors the requested source.
      if (/FROM connector_tokens/.test(sql)) {
        const sourceId = String(p[0]);
        const account = (configState[sourceId]?.connectors as any)?.calendar?.account ?? 'primary';
        const row = tokenRows.get(sourceId) ?? sealedTokenRow(sourceId, String(account));
        tokenRows.set(sourceId, row);
        return [row];
      }
      // The advisory-lock SELECT is postgres-only; our engine.kind is 'pglite' so
      // takeAdvisoryLock returns early and never issues it. No handler needed.
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
      // writeWatchChannel: jsonb_set(COALESCE(config,…), '{connectors,calendar}',
      // existing || $1::jsonb). Checked BEFORE the syncToken write because BOTH start
      // `UPDATE sources SET config = jsonb_set(` — the COALESCE marker disambiguates.
      // The shallow `||` merge PRESERVES sibling keys and overwrites the channel fields.
      if (/jsonb_set\(\s*COALESCE\(config/.test(sql)) {
        const patch = JSON.parse(p[0] as string) as Record<string, unknown>;
        const id = p[1] as string;
        watchChannelWrites.push({ patch, id });
        const cfg = (configState[id] ??= {});
        const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
        const cal = (connectors.calendar ??= {}) as Record<string, unknown>;
        Object.assign(cal, patch); // shallow merge — preserves siblings
        return [];
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
  };
  const engine = {
    kind: 'pglite',
    executeRaw,
    // The REAL getValidAccessToken wraps its read in engine.transaction(fn). Our fake
    // runs fn against an engine sharing the same executeRaw (no real tx needed — PGLite-
    // class semantics: a single serialized backend).
    transaction: async (fn: (tx: BrainEngine) => Promise<unknown>) => fn(engine as unknown as BrainEngine),
  } as unknown as BrainEngine;
  return { engine, inserts, syncTokenWrites, watchChannelWrites, configState };
}

// ── fetch stub for the Google Calendar events.list API ───────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Serve a queue of responses to events.list calls (URLs containing '/events?'). Each
 *  entry is either a JSON page (status 200) or a `{ status }` marker (e.g. 410) to drive
 *  the Gone path. events.watch POSTs (URLs ending '/events/watch') are answered from a
 *  fixed `watchBody`. Captures method + body so the watch test can assert what we sent. */
function stubCalendarFetch(
  responses: ({ status: 200; body: unknown } | { status: number })[],
  opts: { watchBody?: unknown } = {},
): { calls: { url: string; method: string; auth: string | undefined; body: unknown }[] } {
  const calls: { url: string; method: string; auth: string | undefined; body: unknown }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined; } catch { body = init?.body; }
    calls.push({ url: u, method, auth, body });
    // events.watch POST → fixed watch response.
    if (/\/events\/watch$/.test(u)) {
      const wb = opts.watchBody ?? { resourceId: 'resource-xyz', expiration: '9999999999999' };
      return { ok: true, status: 200, json: async () => wb, text: async () => '' } as unknown as Response;
    }
    // events.list (and any other GET) → next queued response.
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
    const records = calendarConnector.normalize(eventWithSecret, { id: 'src-cal', config: {} });
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
    // Finding 4: the organizer DISPLAY NAME (a personal name, outside redact's v1 regex
    // boundary) must NEVER survive into the candidate. metadataForEvent emits the email
    // only — and the candidate row carries no metadata column anyway (landRecords does
    // not surface metadata), so neither the name nor the email reaches a row.
    expect(blob).not.toContain('Board Chair');
    // A redaction-trail entry recorded the body drop.
    expect(JSON.stringify(cand.redactions)).toContain('body');
  });

  test('a secret in the event TITLE (kept→summary) is masked to [REDACTED]', async () => {
    const { engine, inserts } = makeFakeEngine();
    const ev = { id: 'event-titlesecret', summary: `urgent ${SECRET_MARKER} review`, start: { dateTime: '2026-06-20T15:00:00Z' } };
    await landRecords(engine, 'src-cal', calendarConnector, calendarConnector.normalize(ev, { id: 'src-cal', config: {} }));
    const cand = inserts.find((r) => r.source_record_id === 'event-titlesecret')!;
    expect(cand.proposed_markdown).not.toContain(SECRET_MARKER);
    expect(cand.proposed_markdown).toContain('[REDACTED]');
  });

  test('an events.list page normalizes every item', () => {
    const page = { items: [{ id: 'e1', summary: 'A' }, { id: 'e2', summary: 'B' }, { /* no id */ summary: 'skip' }] };
    const records = calendarConnector.normalize(page, { id: 'src-cal', config: {} });
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

  // Finding 2: concurrent pushes for ONE source must NOT regress the cursor. The two
  // incrementalSync calls are issued WITHOUT awaiting between them; the single-flight
  // mutex (withInProcessLock) must serialize them so the cursor advances monotonically.
  test('two concurrent incrementalSync calls for one source serialize (no cursor regression)', async () => {
    const { engine, syncTokenWrites } = makeFakeEngine();
    // Each list call returns a DISTINCT advancing syncToken. With serialization the
    // writes land in order; an interleave would let the second read the stale stored
    // token (still SYNC-A in this fake) and regress, or duplicate-list out of order.
    let n = 0;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
      n += 1;
      const tok = `SYNC-ADV-${n}`;
      return {
        ok: true, status: 200,
        json: async () => ({ items: [{ id: `e-${n}`, summary: `E${n}`, start: { dateTime: '2026-06-25T15:00:00Z' } }], nextSyncToken: tok }),
        text: async () => '',
      } as unknown as Response;
    }) as typeof fetch;
    const source: ConnectorSource = {
      id: 'src-cal',
      config: { connectors: { calendar: { enabled: true, account: 'primary', sync_token: 'SYNC-A' } } },
    };

    // Fire both without awaiting between — the mutex must run them one-after-another.
    const [a, b] = await Promise.all([incrementalSync(engine, source), incrementalSync(engine, source)]);
    expect(a + b).toBe(2); // both landed their event

    // Exactly two syncToken writes, and they are the two DISTINCT advancing tokens in
    // call order — proving the read-list-write ran serially, not interleaved.
    const tokens = syncTokenWrites.map((w) => w.token);
    expect(tokens).toEqual(['SYNC-ADV-1', 'SYNC-ADV-2']);
  });
});

// ── Finding 4: organizer is the EMAIL only, never the display NAME ─────────────────

describe('Calendar metadata (finding 4: organizer name never leaks)', () => {
  function metaOf(ev: Record<string, unknown>): Record<string, unknown> {
    // metadataForEvent is not exported; read it off the normalized record's item.
    const rec = calendarConnector.normalize(ev, { id: 'src-cal', config: {} })[0];
    return (rec.item.metadata ?? {}) as Record<string, unknown>;
  }

  test('organizer metadata carries the email, not the displayName', () => {
    const md = metaOf({ id: 'e-org', summary: 'X', organizer: { email: 'chair@example.com', displayName: 'Board Chair' } });
    expect(md.organizer).toBe('chair@example.com');
    expect(JSON.stringify(md)).not.toContain('Board Chair');
  });

  test('an organizer with ONLY a displayName (no email) drops organizer entirely', () => {
    const md = metaOf({ id: 'e-noemail', summary: 'X', organizer: { displayName: 'Just A Name' } });
    expect(md.organizer).toBeUndefined();
    expect(JSON.stringify(md)).not.toContain('Just A Name');
  });

  test('attendees become a COUNT, never the list', () => {
    const md = metaOf({ id: 'e-att', summary: 'X', attendees: [{ email: 'a@x.com' }, { email: 'b@x.com' }] });
    expect(md.attendee_count).toBe(2);
    expect(JSON.stringify(md)).not.toContain('a@x.com');
  });
});

// ── Finding 1: onConnect wires the push channel end-to-end ─────────────────────────

describe('Calendar onConnect (finding 1: events.watch + channel persisted)', () => {
  const PRIOR_PUBLIC_URL = process.env.GBRAIN_PUBLIC_URL;
  afterEach(() => {
    if (PRIOR_PUBLIC_URL === undefined) delete process.env.GBRAIN_PUBLIC_URL;
    else process.env.GBRAIN_PUBLIC_URL = PRIOR_PUBLIC_URL;
  });

  test('creates a watch channel and persists channel_id + secret (push path now live)', async () => {
    process.env.GBRAIN_PUBLIC_URL = 'https://brain.example.com';
    const { engine, watchChannelWrites, configState } = makeFakeEngine({
      // The connect/enable flow already created connectors.calendar with enabled+account.
      initialConfig: { 'src-cal': { connectors: { calendar: { enabled: true, account: 'cal-123', sync_token: 'KEEP-ME' } } } },
    });
    const { calls } = stubCalendarFetch([], { watchBody: { resourceId: 'res-1', expiration: '111' } });

    await calendarConnector.onConnect!(engine, 'src-cal', 'cal-123');

    // events.watch POST was issued to the right calendar with our address + token.
    const watchCall = calls.find((c) => /\/events\/watch$/.test(c.url))!;
    expect(watchCall).toBeDefined();
    expect(watchCall.method).toBe('POST');
    expect(watchCall.auth).toBe('Bearer fresh-token');
    const wb = watchCall.body as Record<string, unknown>;
    expect(wb.type).toBe('web_hook');
    expect(wb.address).toBe('https://brain.example.com/webhooks/calendar');
    expect(typeof wb.id).toBe('string'); // channel id
    expect(typeof wb.token).toBe('string'); // channel token (the push secret)

    // The channel binding was persisted, MERGING (not clobbering) the sibling sync_token.
    expect(watchChannelWrites).toHaveLength(1);
    const cal = (configState['src-cal'].connectors as any).calendar;
    expect(cal.channel_id).toBe(wb.id); // the route's lookup key
    expect(cal.secret).toBe(wb.token); // the route authenticates against this
    expect(cal.resource_id).toBe('res-1');
    expect(cal.sync_token).toBe('KEEP-ME'); // surgical merge preserved the sibling
  });

  test('refuses (throws) when GBRAIN_PUBLIC_URL is unset or non-https — no dead watch', async () => {
    delete process.env.GBRAIN_PUBLIC_URL;
    const { engine } = makeFakeEngine();
    await expect(calendarConnector.onConnect!(engine, 'src-cal', 'cal-123')).rejects.toThrow(/GBRAIN_PUBLIC_URL/);

    process.env.GBRAIN_PUBLIC_URL = 'http://insecure.example.com';
    await expect(calendarConnector.onConnect!(engine, 'src-cal', 'cal-123')).rejects.toThrow(/https/);
  });
});
