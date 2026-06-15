/**
 * connector-github.test.ts — the GitHub KNOWLEDGE SaaSConnector (TECH-2041).
 *
 * Mocks the GitHub REST API (fetch stub) AND the installation-token mint so the connector
 * exercises normalize / backfill / verify WITHOUT a live API or a real App key. Covers the
 * five ticket-required scenarios:
 *
 *   1. an issue update webhook → a high-confidence metadata candidate.
 *   2. an ETag 304 Not Modified on backfill → no-op (no candidate).
 *   3. a bad signature → reject (verifyWebhook false).
 *   4. a replayed delivery (same issue/PR id) → dedupe via the candidate ON CONFLICT.
 *   5. a secret in an issue body → never reaches a candidate row.
 *
 * Plus: the DISTINCT provider key (`github_kb`, so the inbound route is /webhooks/github_kb
 * and the git-sync /webhooks/github is untouched), the GitHub App JWT→installation-token
 * pattern (node:crypto, NOT user OAuth), and the backfill watermark+ETag persistence.
 *
 * No custody module: GitHub App installation-token auth does NOT go through the TECH-2033
 * credentials layer (there is no per-user grant), so the connector's getInstallationToken
 * mints from a (test-provided) App private key + the mocked token-exchange fetch. Candidate
 * writes go through a fake engine that captures the toRow INSERT params and models the
 * surgical jsonb_set watermark/ETag writes (mirrors connector-linear / connector-calendar).
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';

const {
  githubConnector,
  fetchIssuesPage,
  readBackfillWatermark,
  readBackfillEtag,
  signGitHubWebhook,
  mintAppJwt,
  readRepoFullName,
} = await import('../src/core/connectors/github.ts');
const { landRecords } = await import('../src/core/connectors/base.ts');

// ── A real RSA keypair so the REAL node:crypto RS256 JWT mint path works ───────────
// PKCS#8 ("BEGIN PRIVATE KEY") — the format the connector requires. Generated once;
// the installation-token EXCHANGE is mocked, so we never hit GitHub.
const { privateKey: APP_PRIVATE_KEY_PEM } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const APP_ID = '123456';
const INSTALLATION_ID = '987654';
const INSTALLATION_TOKEN = 'ghs_installation_token_abc';
const WEBHOOK_SECRET = 'github-kb-webhook-signing-secret';
const SECRET_MARKER = 'AKIAIOSFODNN7EXAMPLE'; // AWS-key-shaped; strip() masks it
const REPO = 'acme/widgets';

// Seed the App-auth env so getInstallationToken mints (set only if unset, never clobber).
if (!process.env.GBRAIN_GITHUB_APP_PRIVATE_KEY) process.env.GBRAIN_GITHUB_APP_PRIVATE_KEY = APP_PRIVATE_KEY_PEM;
if (!process.env.GBRAIN_GITHUB_APP_ID) process.env.GBRAIN_GITHUB_APP_ID = APP_ID;

/** The receiver passes the resolved source to normalize; github_kb ignores it (ingests all
 *  issues/PRs on the connected repo). A minimal source satisfies the signature. */
const SRC: ConnectorSource = { id: 'src-gh', config: {} };

// ── Fake engine: captures connector_candidates INSERTs + surgical config UPDATEs ──

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
  const watermarkWrites: { watermark: string; id: string }[] = [];
  const etagWrites: { etag: string; id: string }[] = [];
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
      // Surgical watermark write: jsonb_set(config, '{connectors,github_kb,backfill_cursor}', …).
      if (/'\{connectors,github_kb,backfill_cursor\}'/.test(sql)) {
        const watermark = p[0] as string;
        const id = p[1] as string;
        watermarkWrites.push({ watermark, id });
        const cfg = (configState[id] ??= {});
        const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
        const gh = (connectors.github_kb ??= {}) as Record<string, unknown>;
        gh.backfill_cursor = watermark;
        return [];
      }
      // Surgical ETag write: jsonb_set(config, '{connectors,github_kb,backfill_etag}', …).
      if (/'\{connectors,github_kb,backfill_etag\}'/.test(sql)) {
        const etag = p[0] as string;
        const id = p[1] as string;
        etagWrites.push({ etag, id });
        const cfg = (configState[id] ??= {});
        const connectors = (cfg.connectors ??= {}) as Record<string, Record<string, unknown>>;
        const gh = (connectors.github_kb ??= {}) as Record<string, unknown>;
        gh.backfill_etag = etag;
        return [];
      }
      // toRow's fetch-on-conflict SELECT
      return [{ id: 0 }];
    },
  } as unknown as BrainEngine;
  return { engine, inserts, watermarkWrites, etagWrites, configState };
}

// ── fetch stub: GitHub App token exchange + issues-list ────────────────────────────

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/**
 * Stub fetch for two GitHub endpoints:
 *   - POST /app/installations/{id}/access_tokens  → a fixed installation token.
 *   - GET  /repos/{repo}/issues                    → the next queued response.
 * A queued issues response is either { status: 200, body, etag? } or { status: 304, etag? }
 * (the conditional-request no-op). Captures every call for assertions.
 */
function stubGitHubFetch(
  issuesResponses: ({ status: 200; body: unknown; etag?: string } | { status: 304; etag?: string })[],
): { calls: { url: string; method: string; auth: string | undefined; ifNoneMatch: string | undefined }[] } {
  const calls: { url: string; method: string; auth: string | undefined; ifNoneMatch: string | undefined }[] = [];
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const h = (init?.headers as Record<string, string> | undefined) ?? {};
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url: u, method, auth: h.authorization, ifNoneMatch: h['if-none-match'] });

    // App JWT → installation token exchange.
    if (/\/app\/installations\/.*\/access_tokens$/.test(u)) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }),
        text: async () => '',
        headers: new Headers(),
      } as unknown as Response;
    }

    // Issues list → next queued response.
    const r = issuesResponses[Math.min(i, issuesResponses.length - 1)];
    i += 1;
    if (r.status === 304) {
      return {
        ok: false,
        status: 304,
        json: async () => [],
        text: async () => '',
        headers: new Headers(r.etag ? { etag: r.etag } : {}),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => r.body,
      text: async () => '',
      headers: new Headers(r.etag ? { etag: r.etag } : {}),
    } as unknown as Response;
  }) as typeof fetch;
  return { calls };
}

// ── Representative payloads ────────────────────────────────────────────────────────

/** An `issues` `edited` webhook (a field change) carrying a secret in the body. */
const issueEdited = {
  action: 'edited',
  repository: { full_name: REPO, id: 42 },
  installation: { id: Number(INSTALLATION_ID) },
  issue: {
    id: 1001,
    number: 7,
    state: 'open',
    title: 'Investigate the flaky deploy step',
    body: `Stack trace attached. Note the leaked key ${SECRET_MARKER} — please rotate. Pay Jane Smith $250k.`,
    html_url: 'https://github.com/acme/widgets/issues/7',
    user: { login: 'octocat' },
    labels: [{ name: 'bug' }, { name: 'ci' }],
    updated_at: '2026-06-15T10:00:00Z',
  },
};

// ── 1. an issue update → a high-confidence metadata candidate ─────────────────────

describe('GitHub_kb normalize (AC4: issue/PR → metadata candidate)', () => {
  test('an issue `edited` event lands a high-confidence candidate (number/state/title, no body)', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = githubConnector.normalize(issueEdited, SRC);
    expect(records).toHaveLength(1);

    const result = await landRecords(engine, 'src-gh', githubConnector, records);
    expect(result).toEqual({ written: 1, total: 1 });

    const cand = inserts.find((r) => r.source_record_id === 'issue:1001')!;
    expect(cand).toBeDefined();
    expect(cand.provider).toBe('github_kb');
    expect(cand.confidence).toBe(0.9);
    expect(cand.status).toBe('pending');
    expect(cand.proposed_slug).toBe('github-issue-1001');
    // Structural summary: kind + number + state + title — never the body.
    expect(cand.proposed_markdown).toBe('Issue #7 [open]: Investigate the flaky deploy step');
  });

  test('a pull_request event is keyed pr:<id> and labelled PR', () => {
    const prOpened = {
      action: 'opened',
      repository: { full_name: REPO },
      pull_request: {
        id: 2002,
        number: 31,
        state: 'open',
        title: 'Add retry to the sync worker',
        html_url: 'https://github.com/acme/widgets/pull/31',
        // A pull_request WEBHOOK object does NOT carry a nested pull_request marker; the
        // kind ('pr') is determined by the top-level routing key (.pull_request).
        updated_at: '2026-06-15T11:00:00Z',
      },
    };
    const records = githubConnector.normalize(prOpened, SRC);
    expect(records).toHaveLength(1);
    expect(records[0].sourceRecordId).toBe('pr:2002');
    expect(records[0].proposedSlug).toBe('github-pr-2002');
    expect(records[0].item.summary).toBe('PR #31 [open]: Add retry to the sync worker');
  });

  test('a non-issue/PR event (ping) yields no records', () => {
    expect(githubConnector.normalize({ action: 'ping', repository: { full_name: REPO } }, SRC)).toHaveLength(0);
  });

  test('accountFromPayload resolves the repo full_name (falls back to installation id)', () => {
    expect(githubConnector.accountFromPayload(issueEdited)).toBe(REPO);
    expect(githubConnector.accountFromPayload({ installation: { id: 555 } })).toBe('555');
    expect(githubConnector.accountFromPayload({})).toBeNull();
  });
});

// ── 2. an ETag 304 → no-op (no candidate) ──────────────────────────────────────────

describe('GitHub_kb backfill (AC4: incremental + ETag 304 no-op)', () => {
  test('lists issues since the watermark, lands candidates, persists watermark + ETag', async () => {
    const { engine, inserts, watermarkWrites, etagWrites, configState } = makeFakeEngine();
    const { calls } = stubGitHubFetch([
      {
        status: 200,
        etag: 'W/"etag-1"',
        body: [
          { id: 11, number: 1, state: 'open', title: 'A', html_url: 'h', updated_at: '2026-06-15T09:00:00Z' },
          { id: 12, number: 2, state: 'closed', title: 'B', html_url: 'h', updated_at: '2026-06-15T09:30:00Z' },
        ],
      },
    ]);
    const source: ConnectorSource = {
      id: 'src-gh',
      config: { connectors: { github_kb: { enabled: true, account: REPO, repo: REPO, installation_id: INSTALLATION_ID } } },
    };

    const landed = await githubConnector.backfill!(engine, source);
    expect(landed).toBe(2);
    expect(inserts.map((r) => r.source_record_id).sort()).toEqual(['issue:11', 'issue:12']);

    // The token-exchange call used the App JWT (Bearer <jwt>); the issues call used the
    // BARE installation token under Bearer.
    const tokenCall = calls.find((c) => /access_tokens$/.test(c.url))!;
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.auth?.startsWith('Bearer ')).toBe(true);
    const issuesCall = calls.find((c) => /\/issues\?/.test(c.url))!;
    expect(issuesCall.auth).toBe(`Bearer ${INSTALLATION_TOKEN}`);
    expect(issuesCall.url).toContain('state=all');

    // Watermark advanced to the newest updated_at; the fresh ETag persisted.
    expect(watermarkWrites).toEqual([{ watermark: '2026-06-15T09:30:00Z', id: 'src-gh' }]);
    expect(etagWrites).toEqual([{ etag: 'W/"etag-1"', id: 'src-gh' }]);
    expect((configState['src-gh'].connectors as any).github_kb.backfill_cursor).toBe('2026-06-15T09:30:00Z');
    expect((configState['src-gh'].connectors as any).github_kb.backfill_etag).toBe('W/"etag-1"');
  });

  test('a 304 Not Modified (matching ETag) → no candidate, no watermark move', async () => {
    const { engine, inserts, watermarkWrites, etagWrites } = makeFakeEngine();
    const { calls } = stubGitHubFetch([{ status: 304, etag: 'W/"etag-1"' }]);
    const source: ConnectorSource = {
      id: 'src-gh',
      config: {
        connectors: {
          github_kb: {
            enabled: true,
            account: REPO,
            repo: REPO,
            installation_id: INSTALLATION_ID,
            backfill_cursor: '2026-06-15T09:30:00Z',
            backfill_etag: 'W/"etag-1"',
          },
        },
      },
    };

    const landed = await githubConnector.backfill!(engine, source);
    expect(landed).toBe(0);
    expect(inserts).toHaveLength(0);
    expect(watermarkWrites).toHaveLength(0);
    expect(etagWrites).toHaveLength(0);

    // The conditional request carried the stored ETag in If-None-Match.
    const issuesCall = calls.find((c) => /\/issues\?/.test(c.url))!;
    expect(issuesCall.ifNoneMatch).toBe('W/"etag-1"');
  });

  test('fetchIssuesPage returns notModified on a raw 304', async () => {
    stubGitHubFetch([{ status: 304, etag: 'W/"x"' }]);
    const page = await fetchIssuesPage(INSTALLATION_TOKEN, REPO, '2026-06-15T00:00:00Z', 'W/"x"');
    expect(page.notModified).toBe(true);
    expect(page.items).toHaveLength(0);
  });
});

// ── 3. a bad signature → reject ─────────────────────────────────────────────────────

describe('GitHub_kb verifyWebhook (AC3: sha256= HMAC, constant-time)', () => {
  function body(payload: Record<string, unknown>): Buffer {
    return Buffer.from(JSON.stringify(payload), 'utf8');
  }

  test('valid sha256=-prefixed signature → true', () => {
    const b = body(issueEdited);
    const headers = { 'x-hub-signature-256': signGitHubWebhook(b, WEBHOOK_SECRET) };
    expect(githubConnector.verifyWebhook(b, headers, WEBHOOK_SECRET)).toBe(true);
  });

  test('bad signature (wrong secret) → reject', () => {
    const b = body(issueEdited);
    const headers = { 'x-hub-signature-256': signGitHubWebhook(b, 'wrong-secret') };
    expect(githubConnector.verifyWebhook(b, headers, WEBHOOK_SECRET)).toBe(false);
  });

  test('tampered body → reject', () => {
    const b = body(issueEdited);
    const headers = { 'x-hub-signature-256': signGitHubWebhook(b, WEBHOOK_SECRET) };
    const tampered = Buffer.from(b);
    tampered[10] = tampered[10] ^ 0xff;
    expect(githubConnector.verifyWebhook(tampered, headers, WEBHOOK_SECRET)).toBe(false);
  });

  test('a signature WITHOUT the sha256= prefix → reject (GitHub always sends the prefix)', () => {
    const b = body(issueEdited);
    const bare = signGitHubWebhook(b, WEBHOOK_SECRET).slice('sha256='.length);
    expect(githubConnector.verifyWebhook(b, { 'x-hub-signature-256': bare }, WEBHOOK_SECRET)).toBe(false);
  });

  test('missing signature header → reject', () => {
    expect(githubConnector.verifyWebhook(body(issueEdited), {}, WEBHOOK_SECRET)).toBe(false);
  });

  test('the signature header name is the GitHub one (lowercase)', () => {
    expect(githubConnector.signatureHeader).toBe('x-hub-signature-256');
  });

  test('the provider key is DISTINCT (github_kb), so it routes off /webhooks/github', () => {
    // The distinct key is what keeps the generic /webhooks/:provider receiver from
    // colliding with the git-sync /webhooks/github route.
    expect(githubConnector.provider).toBe('github_kb');
  });
});

// ── 4. a replayed delivery → dedupe via the candidate ON CONFLICT ──────────────────

describe('GitHub_kb delivery idempotency (AC3: replay → ON CONFLICT no-op)', () => {
  test('a re-land of the SAME record is a no-op (source_id, source_record_id, version collide)', async () => {
    const { engine, inserts } = makeFakeEngine();
    // A replayed GitHub delivery carries the same issue/PR id → the same source_record_id, so
    // the second land collides on the candidate UNIQUE and writes nothing. This is the durable,
    // content-keyed idempotency guarantee — there is no in-body delivery-id LRU (the generic
    // receiver hands normalize the parsed JSON body, not the X-GitHub-Delivery HTTP header, so
    // an in-body check would be inert).
    const records = githubConnector.normalize(issueEdited, SRC);
    await landRecords(engine, 'src-gh', githubConnector, records);
    const firstCount = inserts.length;
    expect(firstCount).toBe(1);
    const second = await landRecords(engine, 'src-gh', githubConnector, records);
    expect(second.written).toBe(0);
    expect(inserts.length).toBe(firstCount);
  });
});

// ── 5. a secret in an issue body → never reaches a row ──────────────────────────────

describe('GitHub_kb redaction (AC4: issue body dropped; secrets never reach a row)', () => {
  test('the issue body (with a secret + PII) is dropped; nothing leaks into the candidate', async () => {
    const { engine, inserts } = makeFakeEngine();
    const records = githubConnector.normalize(issueEdited, SRC);
    await landRecords(engine, 'src-gh', githubConnector, records);

    const blob = JSON.stringify(inserts);
    // The body is dropped by minimize; the secret + the PII/deal-terms strip() can't even
    // catch never appear anywhere in the row.
    expect(blob).not.toContain(SECRET_MARKER);
    expect(blob).not.toContain('Jane Smith');
    expect(blob).not.toContain('250k');
    expect(blob).not.toContain('Stack trace');
    // A redaction-trail entry recorded the body drop.
    const cand = inserts.find((r) => r.source_record_id === 'issue:1001')!;
    expect(JSON.stringify(cand.redactions)).toContain('body');
  });

  test('a secret in the TITLE (kept→summary) is masked to [REDACTED]', async () => {
    const { engine, inserts } = makeFakeEngine();
    const payload = {
      action: 'opened',
      repository: { full_name: REPO },
      issue: {
        id: 1003,
        number: 9,
        state: 'open',
        title: `urgent ${SECRET_MARKER} rotate`,
        html_url: 'https://github.com/acme/widgets/issues/9',
        updated_at: '2026-06-15T12:00:00Z',
      },
    };
    await landRecords(engine, 'src-gh', githubConnector, githubConnector.normalize(payload, SRC));
    const cand = inserts.find((r) => r.source_record_id === 'issue:1003')!;
    expect(cand.proposed_markdown).not.toContain(SECRET_MARKER);
    expect(cand.proposed_markdown).toContain('[REDACTED]');
    expect(JSON.stringify(cand.redactions)).toContain('summary');
  });

  test('a secret-shaped label name never reaches a row (metadata not surfaced)', async () => {
    const { engine, inserts } = makeFakeEngine();
    const payload = {
      action: 'labeled',
      repository: { full_name: REPO },
      issue: {
        id: 1004,
        number: 10,
        state: 'open',
        title: 'Labelled',
        labels: [{ name: `label-${SECRET_MARKER}` }, { name: 'ok' }],
        html_url: 'h',
        updated_at: '2026-06-15T12:30:00Z',
      },
    };
    await landRecords(engine, 'src-gh', githubConnector, githubConnector.normalize(payload, SRC));
    expect(JSON.stringify(inserts)).not.toContain(SECRET_MARKER);
  });
});

// ── GitHub App auth: JWT mint is real RS256; installation token is minted, not OAuth ──

describe('GitHub App auth (AC2: RS256 JWT → installation token, NOT user OAuth)', () => {
  test('mintAppJwt produces a 3-segment RS256 JWT with the App id as iss', () => {
    const jwt = mintAppJwt(APP_PRIVATE_KEY_PEM, APP_ID);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    expect(header.alg).toBe('RS256');
    expect(payload.iss).toBe(APP_ID);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  test('mintAppJwt rejects a PKCS#1 ("BEGIN RSA PRIVATE KEY") key with guidance', () => {
    expect(() => mintAppJwt('-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----', APP_ID)).toThrow(/PKCS#8/);
  });

  test('mintAppJwt leaves a clock-skew margin: exp is not pinned to the 600s ceiling (F2)', () => {
    const before = Math.floor(Date.now() / 1000);
    const jwt = mintAppJwt(APP_PRIVATE_KEY_PEM, APP_ID);
    const after = Math.floor(Date.now() / 1000);
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    // exp must clear a margin under GitHub's 600s ceiling so a host clock a few seconds ahead
    // of GitHub's (or in-flight latency) cannot push the observed exp past the ceiling → 401.
    expect(payload.exp - before).toBeLessThanOrEqual(600);
    expect(payload.exp - after).toBeLessThanOrEqual(540);
    expect(payload.iat).toBeLessThanOrEqual(before);
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });

  test('the connector does NOT register an OAuth provider (App auth is not user OAuth)', async () => {
    const { getOAuthProvider } = await import('../src/core/connectors/credentials.ts');
    expect(getOAuthProvider('github_kb')).toBeUndefined();
  });
});

// ── F4: repo full_name validated before it reaches the issues-list URL path ─────────

describe('GitHub_kb config validation (F4: repo owner/name shape)', () => {
  test('readRepoFullName accepts a valid owner/name', () => {
    const src: ConnectorSource = { id: 's', config: { connectors: { github_kb: { repo: 'acme/widgets' } } } };
    expect(readRepoFullName(src)).toBe('acme/widgets');
  });

  test('readRepoFullName throws on a malformed repo (path-injection-shaped value)', () => {
    const src: ConnectorSource = { id: 's', config: { connectors: { github_kb: { repo: '../../etc?x=1' } } } };
    expect(() => readRepoFullName(src)).toThrow(/owner\/name/);
  });

  test('readRepoFullName returns null when neither repo nor account is set', () => {
    const src: ConnectorSource = { id: 's', config: { connectors: { github_kb: {} } } };
    expect(readRepoFullName(src)).toBeNull();
  });
});
