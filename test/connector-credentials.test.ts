/**
 * Tests for src/core/connectors/credentials.ts (TECH-2033) — the encrypted
 * outbound-OAuth credential custody primitive.
 *
 * Proves the ticket's AC #8 set + the security invariants:
 *  1. Ciphertext-at-rest + no-leak: no plaintext access/refresh token appears
 *     in ANY connector_tokens column (and the row is decryptable via the API).
 *  2. Source predicate: a token stored under source A is invisible to source B
 *     (cross-source read denied).
 *  3. Single-flight under concurrency: N concurrent getValidAccessToken calls
 *     that all need a refresh hit the provider EXACTLY ONCE.
 *  4. Decrypt failure → needs_reauth (fail-closed) + ConnectorAuthError.
 *  5. Refresh reuse/revocation → needs_reauth (fail-closed) + ConnectorAuthError.
 *
 * Canonical PGLite block (R3 + R4 compliant): one engine per file, beforeEach
 * resets data, afterAll disconnects. pglite lacks real advisory-lock
 * concurrency, so the in-process mutex is what enforces single-flight here —
 * which is exactly the path the production postgres engine ALSO relies on for
 * same-process concurrency.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  getValidAccessToken,
  storeToken,
  registerOAuthProvider,
  getOAuthProvider,
  ConnectorAuthError,
  sealToken,
  openToken,
  type StoredToken,
  type OAuthProviderConfig,
} from '../src/core/connectors/credentials.ts';

// A 32-byte (64 hex char) master key for AES-256-GCM. Set before any seal/open.
const MASTER_KEY_HEX = '0'.repeat(64).replace(/0/g, () => 'a'); // 64 'a' chars = 32 bytes
process.env.GBRAIN_CONNECTOR_MASTER_KEY = MASTER_KEY_HEX;

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

// A distinctive plaintext we assert never appears at rest.
const ACCESS_SECRET = 'ACCESS-TOKEN-XQZR7B-not-in-any-column';
const REFRESH_SECRET = 'REFRESH-TOKEN-XQZR7B-not-in-any-column';

function freshToken(overrides: Partial<StoredToken> = {}): StoredToken {
  return {
    accessToken: ACCESS_SECRET,
    refreshToken: REFRESH_SECRET,
    expiresAt: new Date(Date.now() + 3600_000), // 1h out — not near expiry
    scope: 'read write',
    account: 'acct-123',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────
// Envelope round-trip (pure crypto)
// ─────────────────────────────────────────────────────────────────
describe('AES-256-GCM envelope', () => {
  test('seal → open round-trips a token; envelope carries 12-byte IV + 16-byte tag', () => {
    const t = freshToken();
    const env = sealToken(t);
    expect(env.kid).toBe('v1');
    expect(Buffer.from(env.iv, 'hex').length).toBe(12);
    expect(Buffer.from(env.tag, 'hex').length).toBe(16);
    // ciphertext is not plaintext
    expect(env.ciphertext).not.toContain(ACCESS_SECRET);

    const back = openToken(env);
    expect(back.accessToken).toBe(ACCESS_SECRET);
    expect(back.refreshToken).toBe(REFRESH_SECRET);
    expect(back.account).toBe('acct-123');
  });

  test('a tampered tag fails the auth check (open throws)', () => {
    const env = sealToken(freshToken());
    const badTag = Buffer.from(env.tag, 'hex');
    badTag[0] = badTag[0] ^ 0xff;
    expect(() => openToken({ ...env, tag: badTag.toString('hex') })).toThrow();
  });

  test('two seals of the same token use distinct IVs (no nonce reuse)', () => {
    const t = freshToken();
    expect(sealToken(t).iv).not.toBe(sealToken(t).iv);
  });
});

// ─────────────────────────────────────────────────────────────────
// Ciphertext-at-rest + no-leak
// ─────────────────────────────────────────────────────────────────
describe('storeToken: ciphertext at rest, no plaintext leak', () => {
  test('no column anywhere carries the plaintext access/refresh token', async () => {
    await storeToken(engine, 'default', 'fake', freshToken());

    const rows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT * FROM connector_tokens WHERE source_id = 'default' AND provider = 'fake'`,
    );
    expect(rows.length).toBe(1);
    const blob = JSON.stringify(rows[0]);
    expect(blob).not.toContain(ACCESS_SECRET);
    expect(blob).not.toContain(REFRESH_SECRET);
    // It IS recoverable through the encrypted envelope, though.
    const r = rows[0] as { kid: string; iv: string; ciphertext: string; tag: string; status: string };
    expect(r.status).toBe('active');
    const opened = openToken({ kid: r.kid, iv: r.iv, ciphertext: r.ciphertext, tag: r.tag });
    expect(opened.accessToken).toBe(ACCESS_SECRET);
  });

  test('getValidAccessToken returns the decrypted token when not near expiry', async () => {
    await storeToken(engine, 'default', 'fake', freshToken());
    const tok = await getValidAccessToken(engine, 'default', 'fake');
    expect(tok).toBe(ACCESS_SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────
// Source predicate (cross-source read denied)
// ─────────────────────────────────────────────────────────────────
describe('source predicate', () => {
  test('a token stored for source A is invisible to source B', async () => {
    // Register a second source so the FK holds.
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
    );
    await storeToken(engine, 'default', 'fake', freshToken());

    // Same provider, different source → no row → ConnectorAuthError.
    await expect(getValidAccessToken(engine, 'other', 'fake')).rejects.toBeInstanceOf(ConnectorAuthError);
    // The owning source still resolves.
    expect(await getValidAccessToken(engine, 'default', 'fake')).toBe(ACCESS_SECRET);
  });
});

// ─────────────────────────────────────────────────────────────────
// Single-flight under concurrency: EXACTLY ONE provider refresh call
// ─────────────────────────────────────────────────────────────────
describe('single-flight refresh under concurrency', () => {
  test('N concurrent refresh-needing calls hit the provider exactly once', async () => {
    let refreshCalls = 0;
    const provider: OAuthProviderConfig = {
      authorizeUrl: (state, redirectUri) => `https://fake.test/auth?state=${state}&redirect_uri=${redirectUri}`,
      exchangeCode: async () => freshToken(),
      refresh: async (refreshToken) => {
        refreshCalls++;
        // small async gap so concurrent callers would overlap without the lock
        await new Promise((r) => setTimeout(r, 25));
        return {
          accessToken: `REFRESHED-${refreshToken}`,
          refreshToken: 'rotated-refresh',
          expiresAt: new Date(Date.now() + 3600_000),
          scope: 'read write',
          account: 'acct-123',
        };
      },
    };
    registerOAuthProvider('singleflight', provider);

    // Store a token that is ALREADY near expiry so every call wants a refresh.
    await storeToken(engine, 'default', 'singleflight', freshToken({ expiresAt: new Date(Date.now() - 1000) }));

    const results = await Promise.all([
      getValidAccessToken(engine, 'default', 'singleflight'),
      getValidAccessToken(engine, 'default', 'singleflight'),
      getValidAccessToken(engine, 'default', 'singleflight'),
      getValidAccessToken(engine, 'default', 'singleflight'),
      getValidAccessToken(engine, 'default', 'singleflight'),
    ]);

    // EXACTLY ONE provider refresh call across 5 concurrent callers.
    expect(refreshCalls).toBe(1);
    // All callers see a valid (rotated) access token.
    for (const r of results) expect(r).toBe('REFRESHED-' + REFRESH_SECRET);

    // The rotated envelope was persisted (never burn a token you can't write back):
    // a subsequent call reuses the now-fresh token with NO further provider call.
    const after = await getValidAccessToken(engine, 'default', 'singleflight');
    expect(after).toBe('REFRESHED-' + REFRESH_SECRET);
    expect(refreshCalls).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// Decrypt failure → needs_reauth (fail-closed)
// ─────────────────────────────────────────────────────────────────
describe('decrypt failure → needs_reauth', () => {
  test('a corrupted ciphertext marks the connection needs_reauth and throws', async () => {
    await storeToken(engine, 'default', 'fake', freshToken({ expiresAt: new Date(Date.now() + 3600_000) }));
    // Corrupt the ciphertext at rest so GCM auth fails on open.
    await engine.executeRaw(
      `UPDATE connector_tokens SET ciphertext = 'deadbeef' WHERE source_id = 'default' AND provider = 'fake'`,
    );

    await expect(getValidAccessToken(engine, 'default', 'fake')).rejects.toBeInstanceOf(ConnectorAuthError);

    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM connector_tokens WHERE source_id = 'default' AND provider = 'fake'`,
    );
    expect(rows[0].status).toBe('needs_reauth');
  });
});

// ─────────────────────────────────────────────────────────────────
// Refresh reuse / revocation → needs_reauth (RFC 9700)
// ─────────────────────────────────────────────────────────────────
describe('refresh reuse/revocation → needs_reauth', () => {
  test('a provider that rejects the refresh token marks needs_reauth and throws', async () => {
    const provider: OAuthProviderConfig = {
      authorizeUrl: () => 'https://fake.test/auth',
      exchangeCode: async () => freshToken(),
      refresh: async () => {
        throw new Error('invalid_grant: refresh token reuse detected');
      },
    };
    registerOAuthProvider('reuse', provider);

    // Near-expiry so a refresh is attempted.
    await storeToken(engine, 'default', 'reuse', freshToken({ expiresAt: new Date(Date.now() - 1000) }));

    await expect(getValidAccessToken(engine, 'default', 'reuse')).rejects.toBeInstanceOf(ConnectorAuthError);

    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM connector_tokens WHERE source_id = 'default' AND provider = 'reuse'`,
    );
    expect(rows[0].status).toBe('needs_reauth');

    // A needs_reauth connection refuses subsequent reads (fail-closed).
    await expect(getValidAccessToken(engine, 'default', 'reuse')).rejects.toBeInstanceOf(ConnectorAuthError);
  });
});

// ─────────────────────────────────────────────────────────────────
// Provider registry sanity
// ─────────────────────────────────────────────────────────────────
describe('OAuth provider registry', () => {
  test('register then resolve; unknown → undefined', () => {
    const cfg: OAuthProviderConfig = {
      authorizeUrl: () => 'https://x.test',
      exchangeCode: async () => freshToken(),
      refresh: async () => freshToken(),
    };
    registerOAuthProvider('regprobe', cfg);
    expect(getOAuthProvider('regprobe')).toBe(cfg);
    expect(getOAuthProvider('nope-not-registered')).toBeUndefined();
  });
});
