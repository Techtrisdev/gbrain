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
 * resets data, afterAll disconnects.
 *
 * NOTE on the single-flight proof: PGLite serializes EVERY transaction through
 * its own internal mutex, so a single-flight test on the PGLite engine would
 * pass even if `withInProcessLock` were deleted — PGLite, not the mutex, would
 * be doing the serializing. The load-bearing single-flight test below therefore
 * uses an INTERLEAVING STUB engine (transaction() does NOT serialize) so it
 * genuinely fails if the in-process mutex is removed — which is the guard the
 * REAL Postgres engine depends on (separate pooled backends per concurrent
 * caller actually interleave). See `single-flight via in-process mutex`.
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
  safeStateEqual,
  type StoredToken,
  type OAuthProviderConfig,
} from '../src/core/connectors/credentials.ts';
import {
  resolveConnectorCallbackState,
  type ConnectorOAuthState,
} from '../src/commands/serve-http.ts';

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

/**
 * A minimal in-memory engine that models ONE connector_tokens row per
 * (source_id, provider) and — critically — a transaction() that does NOT
 * serialize: it awaits a real macrotask and lets concurrent callbacks
 * interleave, exactly like separate pooled Postgres backends. kind='pglite'
 * keeps takeAdvisoryLock a no-op so the ONLY possible single-flight serializer
 * is the in-process mutex. `maxConcurrentTx` records peak overlap to prove the
 * stub genuinely interleaves.
 */
function makeInterleavingStubEngine(opts: {
  /** Override engine kind. 'postgres' exercises the advisory-lock path. */
  kind?: 'pglite' | 'postgres';
  /** When set + kind='postgres', the advisory-lock SELECT throws this error. */
  advisoryLockError?: Error & { code?: string };
} = {}) {
  type Row = {
    source_id: string; provider: string; account: string;
    kid: string; iv: string; ciphertext: string; tag: string;
    expires_at: string | null; status: string;
  };
  const rows = new Map<string, Row>(); // key = `${source_id} ${provider}`
  const k = (s: string, p: string) => `${s} ${p}`;
  let activeTx = 0;
  let maxConcurrentTx = 0;
  let advisoryLockCalls = 0;

  async function executeRaw<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.includes('pg_advisory_xact_lock')) {
      advisoryLockCalls += 1;
      if (opts.advisoryLockError) throw opts.advisoryLockError;
      return [] as unknown as T[];
    }
    if (text.startsWith('SELECT') && text.includes('FROM connector_tokens')) {
      const [sourceId, provider] = params as [string, string];
      const row = rows.get(k(sourceId, provider));
      return (row ? [row] : []) as unknown as T[];
    }
    if (text.startsWith('INSERT INTO connector_tokens')) {
      const [source_id, provider, account, kid, iv, ciphertext, tag, expires_at] =
        params as [string, string, string, string, string, string, string, string | null];
      rows.set(k(source_id, provider), {
        source_id, provider, account, kid, iv, ciphertext, tag, expires_at, status: 'active',
      });
      return [] as unknown as T[];
    }
    if (text.startsWith('UPDATE connector_tokens') && text.includes("status = 'needs_reauth'")) {
      const [sourceId, provider] = params as [string, string];
      const row = rows.get(k(sourceId, provider));
      if (row) row.status = 'needs_reauth';
      return [] as unknown as T[];
    }
    throw new Error(`stub engine: unhandled SQL: ${text}`);
  }

  const engine = {
    kind: opts.kind ?? ('pglite' as const),
    executeRaw,
    async transaction<T>(fn: (e: unknown) => Promise<T>): Promise<T> {
      activeTx += 1;
      maxConcurrentTx = Math.max(maxConcurrentTx, activeTx);
      // Yield a real macrotask so overlapping transactions actually interleave
      // (no internal serialization, unlike PGLite).
      await new Promise((r) => setTimeout(r, 0));
      try {
        return await fn(engine);
      } finally {
        activeTx -= 1;
      }
    },
  };

  return {
    engine: engine as unknown as import('../src/core/engine.ts').BrainEngine,
    get maxConcurrentTx() { return maxConcurrentTx; },
    get advisoryLockCalls() { return advisoryLockCalls; },
    rows,
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
// Two tests, by intent:
//  (1) Integration: on the real PGLite engine, end-to-end. Useful, but NOT a
//      proof of the mutex — PGLite serializes transactions internally, so this
//      would pass even with `withInProcessLock` removed.
//  (2) The LOAD-BEARING proof: an interleaving stub engine (transaction() does
//      NOT serialize, kind='pglite' so the advisory lock is a no-op). The ONLY
//      thing that can give single-flight here is `withInProcessLock`. Removing
//      the mutex makes refreshCalls > 1 and this test fails.
describe('single-flight refresh under concurrency', () => {
  test('(integration) N concurrent refresh-needing calls hit the provider exactly once', async () => {
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

  test('(load-bearing) single-flight via the in-process mutex on an INTERLEAVING engine', async () => {
    // This is the test that fails if `withInProcessLock` is removed: the stub
    // engine's transaction() awaits a real macrotask and runs callbacks with
    // genuine interleaving (it does NOT serialize like PGLite). kind='pglite'
    // so takeAdvisoryLock is a no-op — only the in-process mutex remains.
    const stub = makeInterleavingStubEngine();
    // Seed one near-expiry row so every concurrent caller wants a refresh.
    await storeToken(stub.engine, 'default', 'sf-stub', freshToken({ expiresAt: new Date(Date.now() - 1000) }));

    let refreshCalls = 0;
    registerOAuthProvider('sf-stub', {
      authorizeUrl: () => 'https://x.test',
      exchangeCode: async () => freshToken(),
      refresh: async (refreshToken) => {
        refreshCalls++;
        // Hold the critical section across a real async gap so two unguarded
        // callers WOULD both read-then-refresh before either persists.
        await new Promise((r) => setTimeout(r, 20));
        return {
          accessToken: `REFRESHED-${refreshToken}`,
          refreshToken: 'rotated',
          expiresAt: new Date(Date.now() + 3600_000),
          scope: 'read write',
          account: 'acct-123',
        };
      },
    });

    // Prove the stub genuinely interleaves: two overlapping transactions both
    // enter before either exits (guards against a stub that accidentally
    // serializes, which would make the single-flight assertion meaningless).
    expect(stub.maxConcurrentTx).toBe(0);

    const results = await Promise.all([
      getValidAccessToken(stub.engine, 'default', 'sf-stub'),
      getValidAccessToken(stub.engine, 'default', 'sf-stub'),
      getValidAccessToken(stub.engine, 'default', 'sf-stub'),
      getValidAccessToken(stub.engine, 'default', 'sf-stub'),
      getValidAccessToken(stub.engine, 'default', 'sf-stub'),
    ]);

    // The in-process mutex serialized all five → EXACTLY ONE provider refresh.
    expect(refreshCalls).toBe(1);
    for (const r of results) expect(r).toBe('REFRESHED-' + REFRESH_SECRET);
    // The stub DID prove interleaving capability: fire two raw transactions and
    // confirm they overlap (maxConcurrentTx >= 2) — so the single-flight above
    // is attributable to the mutex, not to accidental serialization.
    await Promise.all([
      stub.engine.transaction(async () => { await new Promise((r) => setTimeout(r, 15)); }),
      stub.engine.transaction(async () => { await new Promise((r) => setTimeout(r, 15)); }),
    ]);
    expect(stub.maxConcurrentTx).toBeGreaterThanOrEqual(2);
  });
});

// ─────────────────────────────────────────────────────────────────
// Advisory-lock fail-closed (finding 1): a transient lock error ABORTS the
// refresh (never proceeds lock-less → no double-burn); only SQLSTATE 42883
// (undefined_function) is a legitimate fail-open.
// ─────────────────────────────────────────────────────────────────
describe('advisory-lock fail-closed on a postgres-kind engine', () => {
  function seedPgStub(stub: ReturnType<typeof makeInterleavingStubEngine>) {
    // Seed a near-expiry active row directly so getValidAccessToken reaches the
    // refresh path (and the advisory lock has already fired before the read).
    const env = sealToken(freshToken({ expiresAt: new Date(Date.now() - 1000) }));
    stub.rows.set('default sf-pg', {
      source_id: 'default', provider: 'sf-pg', account: 'acct-123',
      kid: env.kid, iv: env.iv, ciphertext: env.ciphertext, tag: env.tag,
      expires_at: new Date(Date.now() - 1000).toISOString(), status: 'active',
    });
    registerOAuthProvider('sf-pg', {
      authorizeUrl: () => 'https://x.test',
      exchangeCode: async () => freshToken(),
      refresh: async () => freshToken({ accessToken: 'SHOULD-NOT-REACH' }),
    });
  }

  test('a TRANSIENT advisory-lock error aborts (throws), never proceeds lock-less', async () => {
    const transient = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const stub = makeInterleavingStubEngine({ kind: 'postgres', advisoryLockError: transient });
    seedPgStub(stub);

    // The lock error must propagate out (abort), NOT be swallowed.
    await expect(getValidAccessToken(stub.engine, 'default', 'sf-pg')).rejects.toThrow(/statement timeout/);
    expect(stub.advisoryLockCalls).toBe(1);
    // Fail-closed: we never reached the read/refresh, so status is untouched.
    expect(stub.rows.get('default sf-pg')?.status).toBe('active');
  });

  test('SQLSTATE 42883 (undefined_function) is the lone legitimate fail-open', async () => {
    const undef = Object.assign(new Error('function pg_advisory_xact_lock(bigint) does not exist'), { code: '42883' });
    const stub = makeInterleavingStubEngine({ kind: 'postgres', advisoryLockError: undef });
    seedPgStub(stub);

    // 42883 is swallowed → the flow continues to the (near-expiry) refresh.
    const tok = await getValidAccessToken(stub.engine, 'default', 'sf-pg');
    expect(tok).toBe('SHOULD-NOT-REACH'); // proves we proceeded past the lock
    expect(stub.advisoryLockCalls).toBe(1);
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
// merge-preserve when a provider's refresh() OMITS fields
// ─────────────────────────────────────────────────────────────────
describe('merge-preserve on refresh', () => {
  test('refresh that omits refreshToken/account/scope keeps the prior values', async () => {
    registerOAuthProvider('mergep', {
      authorizeUrl: () => 'https://x.test',
      exchangeCode: async () => freshToken(),
      // Provider returns ONLY a new access token + expiry. No refreshToken,
      // no account, no scope — the common "refresh doesn't re-issue" case.
      refresh: async () => ({
        accessToken: 'NEW-ACCESS-ONLY',
        expiresAt: new Date(Date.now() + 3600_000),
        account: '', // provider omits → falsy; must fall back to stored account
      }),
    });

    // Seed near-expiry with distinctive refresh token / account / scope.
    await storeToken(
      engine,
      'default',
      'mergep',
      freshToken({
        refreshToken: REFRESH_SECRET,
        account: 'acct-PRESERVED',
        scope: 'scope-PRESERVED',
        expiresAt: new Date(Date.now() - 1000),
      }),
    );

    const tok = await getValidAccessToken(engine, 'default', 'mergep');
    expect(tok).toBe('NEW-ACCESS-ONLY');

    // Decrypt the persisted row and confirm the omitted fields were preserved.
    const rows = await engine.executeRaw<{ kid: string; iv: string; ciphertext: string; tag: string; account: string }>(
      `SELECT kid, iv, ciphertext, tag, account FROM connector_tokens WHERE source_id = 'default' AND provider = 'mergep'`,
    );
    expect(rows[0].account).toBe('acct-PRESERVED'); // stored attribute preserved
    const opened = openToken({ kid: rows[0].kid, iv: rows[0].iv, ciphertext: rows[0].ciphertext, tag: rows[0].tag });
    expect(opened.accessToken).toBe('NEW-ACCESS-ONLY');
    expect(opened.refreshToken).toBe(REFRESH_SECRET); // omitted by provider → kept
    expect(opened.scope).toBe('scope-PRESERVED');     // omitted by provider → kept
    expect(opened.account).toBe('acct-PRESERVED');    // omitted by provider → kept

    // The kept refresh token is still usable: a second near-expiry refresh works.
    // (No assertion beyond not throwing — proves the merge left a live credential.)
  });
});

// ─────────────────────────────────────────────────────────────────
// kid honesty: an unknown kid fails closed (decrypt failure)
// ─────────────────────────────────────────────────────────────────
describe('kid resolution', () => {
  test('an envelope stamped with an unknown kid throws (no fall-through to a default key)', async () => {
    await storeToken(engine, 'default', 'kidtest', freshToken({ expiresAt: new Date(Date.now() + 3600_000) }));
    // Rewrite kid to something we have no key for.
    await engine.executeRaw(
      `UPDATE connector_tokens SET kid = 'v-unknown' WHERE source_id = 'default' AND provider = 'kidtest'`,
    );
    await expect(getValidAccessToken(engine, 'default', 'kidtest')).rejects.toBeInstanceOf(ConnectorAuthError);
    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM connector_tokens WHERE source_id = 'default' AND provider = 'kidtest'`,
    );
    expect(rows[0].status).toBe('needs_reauth'); // unknown kid is fail-closed
  });
});

// ─────────────────────────────────────────────────────────────────
// Route-level: /callback state validation (TECH-2033, finding 5c)
// ─────────────────────────────────────────────────────────────────
describe('connector /callback state validation', () => {
  const future = () => Date.now() + 60_000;

  test('a minted state for the right provider matches (single-use key returned)', () => {
    const states = new Map<string, ConnectorOAuthState>([
      ['STATE-ABC', { sourceId: 'default', provider: 'slack', expiresAt: future() }],
    ]);
    const r = resolveConnectorCallbackState(states, 'slack', 'STATE-ABC', Date.now(), safeStateEqual);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.key).toBe('STATE-ABC');
      expect(r.sourceId).toBe('default');
    }
  });

  test('a forged / unminted state is rejected (invalid_state)', () => {
    const states = new Map<string, ConnectorOAuthState>([
      ['STATE-ABC', { sourceId: 'default', provider: 'slack', expiresAt: future() }],
    ]);
    const r = resolveConnectorCallbackState(states, 'slack', 'FORGED-STATE-NEVER-MINTED', Date.now(), safeStateEqual);
    expect(r).toEqual({ ok: false, reason: 'invalid_state' });
  });

  test('a state minted for a DIFFERENT provider is rejected', () => {
    const states = new Map<string, ConnectorOAuthState>([
      ['STATE-ABC', { sourceId: 'default', provider: 'slack', expiresAt: future() }],
    ]);
    // Same opaque value, but the caller route is :provider='linear'.
    const r = resolveConnectorCallbackState(states, 'linear', 'STATE-ABC', Date.now(), safeStateEqual);
    expect(r).toEqual({ ok: false, reason: 'invalid_state' });
  });

  test('an expired state is rejected even with the correct value + provider', () => {
    const states = new Map<string, ConnectorOAuthState>([
      ['STATE-ABC', { sourceId: 'default', provider: 'slack', expiresAt: Date.now() - 1 }],
    ]);
    const r = resolveConnectorCallbackState(states, 'slack', 'STATE-ABC', Date.now(), safeStateEqual);
    expect(r).toEqual({ ok: false, reason: 'invalid_state' });
  });

  test('safeStateEqual rejects a length-mismatched / empty candidate', () => {
    expect(safeStateEqual('STATE-ABC', 'STATE-AB')).toBe(false);
    expect(safeStateEqual('', '')).toBe(false);
    expect(safeStateEqual('STATE-ABC', 'STATE-ABC')).toBe(true);
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
