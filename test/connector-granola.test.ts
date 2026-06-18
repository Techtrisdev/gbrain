/**
 * connector-granola.test.ts — the Granola meeting-notes SaaSConnector.
 *
 * Mocks the Granola API (fetch stub) so the connector exercises normalize / backfill /
 * cursor WITHOUT a live API. Focus areas:
 *
 *   PRIVACY (load-bearing) — getNote NEVER requests include=transcript, and even when the
 *     API returns a transcript field, it never reaches a candidate column. SUMMARY-ONLY.
 *   normalize — a note detail → a docs-profile candidate (summary kept, owner NAME dropped,
 *     owner email masked by strip()).
 *   backfill — pages List Notes via cursor, fetches each detail, lands candidates, advances
 *     the watermark to the newest created_at; the trailing re-scan is idempotent.
 *   redaction — a secret-shaped string in the summary is masked by strip() in the landing path.
 *   config — readApiKey precedence (config > env), poll-only verifyWebhook fails closed.
 *
 * Candidate writes + the surgical jsonb_set watermark write go through a fake engine that
 * captures params (mirrors connector-calendar.test.ts, minus the custody/token layer —
 * Granola uses a static API key, not OAuth).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';

const {
  granolaConnector,
  listNotes,
  getNote,
  readApiKey,
  readWatermark,
  readQueryWatermark,
} = await import('../src/core/connectors/granola.ts');
const { landRecords } = await import('../src/core/connectors/base.ts');

const API_KEY = 'grn_test_key_xxxxxxxxxxxxxxxxxxxx';

// ── Fake engine: captures connector_candidates INSERTs + the watermark jsonb_set ──

function makeFakeEngine(opts: { initialConfig?: Record<string, Record<string, unknown>> } = {}) {
  const inserts: {
    source_record_id: string;
    provider: unknown;
    proposed_slug: unknown;
    proposed_markdown: string;
    redactions: unknown[];
    allParams: unknown[];
  }[] = [];
  const watermarkWrites: { watermark: string; id: string }[] = [];
  const seenKeys = new Set<string>();
  const configState: Record<string, Record<string, unknown>> = { ...(opts.initialConfig ?? {}) };

  const executeRaw = async (sql: string, params?: unknown[]) => {
    const p = params ?? [];
    if (/INSERT INTO connector_candidates/.test(sql)) {
      const key = `${p[0]}|${p[1]}|${p[2]}`;
      if (seenKeys.has(key)) return []; // ON CONFLICT DO NOTHING
      seenKeys.add(key);
      inserts.push({
        source_record_id: p[1] as string,
        provider: p[4],
        proposed_slug: p[5],
        proposed_markdown: p[6] as string,
        redactions: p[8] as unknown[],
        allParams: p,
      });
      return [{ id: inserts.length }];
    }
    // ON CONFLICT re-fetch SELECT
    if (/SELECT .* FROM connector_candidates WHERE/.test(sql)) {
      return [];
    }
    // Surgical watermark write: jsonb_set(COALESCE(config,…),'{connectors,granola,watermark}',…)
    if (/'\{connectors,granola,watermark\}'/.test(sql)) {
      const watermark = p[0] as string;
      const id = p[1] as string;
      watermarkWrites.push({ watermark, id });
      const cfg = (configState[id] ??= {});
      const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
      const g = (connectors.granola ??= {}) as Record<string, unknown>;
      g.watermark = watermark;
      return [];
    }
    return [];
  };

  const engine = { kind: 'pglite', executeRaw, transaction: (fn: (e: BrainEngine) => unknown) => fn(engine as BrainEngine) } as unknown as BrainEngine;
  return { engine, inserts, watermarkWrites, configState };
}

// ── Fetch stub: serves List Notes pages + Get Note details, records every URL ─────

interface StubNote {
  id: string;
  title?: string;
  owner?: { name?: string; email?: string };
  summary?: string;
  created_at?: string;
  // A transcript the stub returns to PROVE the connector ignores it. The connector must
  // never request it (no include param) and never surface it in a candidate.
  transcript?: unknown;
}

function stubGranolaFetch(opts: {
  pages: { notes: { id: string; created_at?: string }[]; hasMore?: boolean; cursor?: string }[];
  details: Record<string, StubNote>;
}) {
  const urls: string[] = [];
  let pageIdx = 0;
  globalThis.fetch = (async (url: string | URL, _init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    const detailMatch = u.match(/\/v1\/notes\/([^/?]+)(?:\?|$)/);
    if (detailMatch) {
      const id = decodeURIComponent(detailMatch[1]);
      const note = opts.details[id];
      if (!note) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      return { ok: true, status: 200, json: async () => note, text: async () => '' };
    }
    // List Notes — serve pages in order
    const page = opts.pages[Math.min(pageIdx, opts.pages.length - 1)];
    pageIdx += 1;
    return { ok: true, status: 200, json: async () => page, text: async () => '' };
  }) as unknown as typeof fetch;
  return { urls };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.GRANOLA_API_KEY;
});

function source(config: Record<string, unknown> = {}): ConnectorSource {
  return { id: 'src-granola', config };
}

// ── Tests ─────────────────────────────────────────────────────────────────────────

describe('Granola normalize', () => {
  test('note detail → docs candidate: summary kept, owner name dropped, transcript never present', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = granolaConnector.normalize(
      {
        notes: [
          {
            id: 'not_abc',
            title: 'Q3 roadmap sync',
            owner: { name: 'Jane Operator', email: 'jane@example.com' },
            summary: 'Agreed to ship the connector pilot. Action: wire Granola ingestion.',
            created_at: '2026-06-18T10:00:00Z',
            transcript: [{ speaker: 'x', text: 'RAW TRANSCRIPT SHOULD NEVER APPEAR' }],
          },
        ],
      },
      source(),
    );
    const result = await landRecords(engine, 'src-granola', granolaConnector, records);
    expect(result.written).toBe(1);
    const cand = inserts[0];
    expect(cand.provider).toBe('granola');
    expect(cand.proposed_slug).toBe('granola-note-not_abc');
    // summary content is kept
    expect(cand.proposed_markdown).toContain('Q3 roadmap sync');
    expect(cand.proposed_markdown).toContain('ship the connector pilot');
    // transcript NEVER reaches the candidate
    expect(cand.proposed_markdown).not.toContain('RAW TRANSCRIPT');
    // owner NAME is never emitted; owner email is masked by strip() (so neither leaks)
    expect(JSON.stringify(cand.allParams)).not.toContain('Jane Operator');
    expect(JSON.stringify(cand.allParams)).not.toContain('jane@example.com');
  });

  test('a non-string title (structured/object) does not throw — the page survives', async () => {
    const { engine, inserts } = makeFakeEngine();
    // The runtime JSON is `as`-cast, not validated; a structured title must not crash normalize.
    const records = granolaConnector.normalize(
      { notes: [{ id: 'n1', title: { text: 'x' }, summary: 's1' }, { id: 'n2', title: 'Real', summary: 's2' }] },
      source(),
    );
    const result = await landRecords(engine, 'src-granola', granolaConnector, records);
    expect(result.written).toBe(2); // both land; the bad title is simply omitted from metadata
    expect(inserts.length).toBe(2);
  });
});

describe('Granola redaction', () => {
  test('a secret-shaped string in the summary is masked by strip() in the landing path', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = granolaConnector.normalize(
      { notes: [{ id: 'not_sec', title: 'Creds', summary: 'deploy key AKIAIOSFODNN7EXAMPLE noted' }] },
      source(),
    );
    await landRecords(engine, 'src-granola', granolaConnector, records);
    expect(inserts[0].proposed_markdown).toContain('[REDACTED]');
    expect(inserts[0].proposed_markdown).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });
});

describe('Granola getNote — privacy', () => {
  test('getNote NEVER requests include=transcript', async () => {
    const { urls } = stubGranolaFetch({
      pages: [],
      details: { not_x: { id: 'not_x', summary: 'ok', transcript: ['nope'] } },
    });
    const detail = await getNote(API_KEY, 'not_x');
    expect(detail?.summary).toBe('ok');
    expect(urls.length).toBe(1);
    expect(urls[0]).not.toContain('include');
    expect(urls[0]).not.toContain('transcript');
    expect(urls[0]).toContain('/v1/notes/not_x');
  });

  test('getNote returns null on 404 (skips, does not abort)', async () => {
    stubGranolaFetch({ pages: [], details: {} });
    expect(await getNote(API_KEY, 'missing')).toBeNull();
  });
});

describe('Granola backfill', () => {
  test('pages via cursor, fetches each detail, lands candidates, advances watermark', async () => {
    const { engine, inserts, watermarkWrites } = makeFakeEngine();
    const { urls } = stubGranolaFetch({
      pages: [
        { notes: [{ id: 'n1' }, { id: 'n2' }], hasMore: true, cursor: 'CUR2' },
        { notes: [{ id: 'n3' }], hasMore: false },
      ],
      details: {
        n1: { id: 'n1', title: 'One', summary: 's1', created_at: '2026-06-17T09:00:00Z' },
        n2: { id: 'n2', title: 'Two', summary: 's2', created_at: '2026-06-18T09:00:00Z' },
        n3: { id: 'n3', title: 'Three', summary: 's3', created_at: '2026-06-16T09:00:00Z' },
      },
    });
    const landed = await granolaConnector.backfill!(engine, source({ connectors: { granola: { api_key: API_KEY } } }));
    expect(landed).toBe(3);
    expect(inserts.map((i) => i.source_record_id).sort()).toEqual(['n1', 'n2', 'n3']);
    // watermark advanced to the NEWEST created_at across all pages (normalized to UTC)
    expect(watermarkWrites.at(-1)?.watermark).toBe('2026-06-18T09:00:00.000Z');
    // second page used the cursor from the first
    expect(urls.some((u) => u.includes('cursor=CUR2'))).toBe(true);
    // no transcript ever requested
    expect(urls.every((u) => !u.includes('include'))).toBe(true);
  });

  test('terminates on a repeated/cyclic cursor instead of looping forever', async () => {
    const { engine, inserts } = makeFakeEngine();
    // The API misbehaves: every list page returns hasMore:true with the SAME cursor.
    stubGranolaFetch({
      pages: [{ notes: [{ id: 'n1' }], hasMore: true, cursor: 'STUCK' }],
      details: { n1: { id: 'n1', summary: 's1', created_at: '2026-06-18T09:00:00Z' } },
    });
    // Must return (not hang) — the repeated-cursor guard breaks the loop.
    const landed = await granolaConnector.backfill!(engine, source({ connectors: { granola: { api_key: API_KEY } } }));
    expect(landed).toBe(1); // landed once, deduped, then broke
    expect(inserts.length).toBe(1);
  });

  test('watermark advances by real INSTANT (parsed), not lexicographic string, across offsets', async () => {
    const { engine, watermarkWrites } = makeFakeEngine();
    // n_a string-sorts LOWER but is the LATER instant (14:00Z); n_b string-sorts HIGHER but
    // is EARLIER (09:30Z). A string compare would wrongly pick n_b; a parsed compare picks n_a.
    stubGranolaFetch({
      pages: [{ notes: [{ id: 'n_a' }, { id: 'n_b' }], hasMore: false }],
      details: {
        n_a: { id: 'n_a', summary: 'a', created_at: '2026-06-18T09:00:00-05:00' }, // 14:00Z
        n_b: { id: 'n_b', summary: 'b', created_at: '2026-06-18T11:30:00+02:00' }, // 09:30Z
      },
    });
    await granolaConnector.backfill!(engine, source({ connectors: { granola: { api_key: API_KEY } } }));
    // newest real instant is n_a's 14:00Z — persisted normalized to UTC
    expect(watermarkWrites.at(-1)?.watermark).toBe('2026-06-18T14:00:00.000Z');
  });

  test('throws a clear error when no API key is configured', async () => {
    const { engine } = makeFakeEngine();
    await expect(granolaConnector.backfill!(engine, source())).rejects.toThrow(/no API key/);
  });

  test('re-running backfill is idempotent (ON CONFLICT — no duplicate candidates)', async () => {
    const { engine, inserts } = makeFakeEngine();
    const cfg = source({ connectors: { granola: { api_key: API_KEY } } });
    const mk = () =>
      stubGranolaFetch({
        pages: [{ notes: [{ id: 'n1' }], hasMore: false }],
        details: { n1: { id: 'n1', summary: 's1', created_at: '2026-06-18T09:00:00Z' } },
      });
    mk();
    await granolaConnector.backfill!(engine, cfg);
    mk();
    await granolaConnector.backfill!(engine, cfg);
    expect(inserts.length).toBe(1); // second run dedupes
  });
});

describe('Granola config + cursor', () => {
  test('readApiKey: per-source config wins over env; null when neither', () => {
    process.env.GRANOLA_API_KEY = 'env-key';
    expect(readApiKey(source({ connectors: { granola: { api_key: 'cfg-key' } } }))).toBe('cfg-key');
    expect(readApiKey(source())).toBe('env-key');
    delete process.env.GRANOLA_API_KEY;
    expect(readApiKey(source())).toBeNull();
  });

  test('readQueryWatermark applies the lookback window (default 48h)', () => {
    const wm = '2026-06-18T00:00:00.000Z';
    const q = readQueryWatermark(source({ connectors: { granola: { watermark: wm } } }));
    // 48h before the watermark
    expect(q).toBe('2026-06-16T00:00:00.000Z');
    // null on first run (no watermark)
    expect(readQueryWatermark(source())).toBeNull();
  });

  test('readQueryWatermark honors a custom lookback_hours', () => {
    const wm = '2026-06-18T00:00:00.000Z';
    const q = readQueryWatermark(source({ connectors: { granola: { watermark: wm, lookback_hours: 24 } } }));
    expect(q).toBe('2026-06-17T00:00:00.000Z');
  });

  test('readWatermark returns null on first run', () => {
    expect(readWatermark(source())).toBeNull();
  });
});

describe('Granola poll-only contract', () => {
  test('verifyWebhook fails closed (no inbound webhooks)', () => {
    expect(granolaConnector.verifyWebhook(Buffer.from(''), {}, 'secret')).toBe(false);
  });

  test('accountFromPayload returns null', () => {
    expect(granolaConnector.accountFromPayload({})).toBeNull();
  });

  test('listNotes sets created_after + cursor and Bearer auth', async () => {
    const { urls } = stubGranolaFetch({ pages: [{ notes: [], hasMore: false }], details: {} });
    await listNotes(API_KEY, { createdAfter: '2026-06-01T00:00:00Z', cursor: 'C1' });
    expect(urls[0]).toContain('created_after=2026-06-01');
    expect(urls[0]).toContain('cursor=C1');
  });
});
