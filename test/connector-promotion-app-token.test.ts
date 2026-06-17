// TECH-2037 A3 Path 2 — GitHub App dispatch-token minting (getPromotionDispatchToken).
// Reuses github.ts::mintAppJwt; the installation-resolve + token-exchange use an injected
// fetch so no real network / GitHub App / installation is needed. A locally-generated RSA
// PKCS#8 key satisfies mintAppJwt's signing (the mocked fetch never validates it).
import { describe, test, expect } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  getPromotionDispatchToken,
  PROMOTION_APP_ID_ENV,
  PROMOTION_APP_PRIVATE_KEY_ENV,
  PROMOTION_INSTALLATION_ID_ENV,
  type AppAuthFetch,
} from '../src/core/connectors/promotion.ts';

const { privateKey: APP_KEY } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const APP_ID = '123456';

interface Call { url: string; method: string; auth: string }
function makeAppFetch(opts: { installationId?: string; token?: string; expiresAt?: string; failInstall?: boolean; failToken?: boolean } = {}): {
  fetchImpl: AppAuthFetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const installationId = opts.installationId ?? '99887766';
  const token = opts.token ?? 'ghs_minted_install_token';
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString();
  const fetchImpl: AppAuthFetch = async (url, init) => {
    calls.push({ url, method: init.method, auth: init.headers.authorization });
    if (url.endsWith('/installation')) {
      if (opts.failInstall) return { ok: false, status: 404, text: async () => 'not found' };
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: Number(installationId) }) };
    }
    if (url.includes('/access_tokens')) {
      if (opts.failToken) return { ok: false, status: 401, text: async () => 'bad jwt' };
      return { ok: true, status: 201, text: async () => JSON.stringify({ token, expires_at: expiresAt }) };
    }
    return { ok: false, status: 500, text: async () => 'unexpected url' };
  };
  return { fetchImpl, calls };
}

const env = (extra: Record<string, string | undefined> = {}) => {
  const m: Record<string, string | undefined> = {
    [PROMOTION_APP_ID_ENV]: APP_ID,
    [PROMOTION_APP_PRIVATE_KEY_ENV]: APP_KEY,
    ...extra,
  };
  return (key: string): string | undefined => m[key];
};

describe('getPromotionDispatchToken — GitHub App installation-token minting', () => {
  test('mints: resolve installation (GET) → exchange JWT (POST) → returns the installation token', async () => {
    const { fetchImpl, calls } = makeAppFetch({ installationId: '5550', token: 'ghs_tok_A' });
    const tok = await getPromotionDispatchToken('Owner/repo-mint-A', { getEnv: env(), fetchImpl });
    expect(tok).toBe('ghs_tok_A');
    expect(calls.length).toBe(2);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/repos/Owner/repo-mint-A/installation');
    expect(calls[0].auth.startsWith('Bearer ')).toBe(true); // App JWT, not a static token
    expect(calls[1].method).toBe('POST');
    expect(calls[1].url).toContain('/app/installations/5550/access_tokens');
    expect(calls[1].auth.startsWith('Bearer ')).toBe(true);
  });

  test('caches by repo: a second call within expiry does NOT re-fetch', async () => {
    const { fetchImpl, calls } = makeAppFetch({ installationId: '7000', token: 'ghs_tok_cache' });
    const now = () => 1_000_000;
    const a = await getPromotionDispatchToken('Owner/repo-cache', { getEnv: env(), fetchImpl, now });
    const b = await getPromotionDispatchToken('Owner/repo-cache', { getEnv: env(), fetchImpl, now });
    expect(a).toBe('ghs_tok_cache');
    expect(b).toBe('ghs_tok_cache');
    expect(calls.length).toBe(2); // only the first call hit the network; the second reused the cache
  });

  test('refreshes after expiry (clock advanced past the skew window)', async () => {
    const { fetchImpl, calls } = makeAppFetch({ installationId: '7100', token: 'ghs_tok_exp', expiresAt: new Date(2_000_000 + 3_600_000).toISOString() });
    let nowMs = 2_000_000;
    const now = () => nowMs;
    await getPromotionDispatchToken('Owner/repo-exp', { getEnv: env(), fetchImpl, now });
    nowMs = 2_000_000 + 3_600_000; // jump past expiry
    await getPromotionDispatchToken('Owner/repo-exp', { getEnv: env(), fetchImpl, now });
    expect(calls.length).toBe(4); // two full mints (2 calls each)
  });

  test('installation-id override skips the resolve GET', async () => {
    const { fetchImpl, calls } = makeAppFetch({ token: 'ghs_tok_override' });
    const tok = await getPromotionDispatchToken('Owner/repo-override', {
      getEnv: env({ [PROMOTION_INSTALLATION_ID_ENV]: '424242' }),
      fetchImpl,
    });
    expect(tok).toBe('ghs_tok_override');
    expect(calls.length).toBe(1); // exchange POST only — no resolve GET
    expect(calls[0].url).toContain('/app/installations/424242/access_tokens');
  });

  test('throws when App credentials are missing', async () => {
    const { fetchImpl } = makeAppFetch();
    await expect(getPromotionDispatchToken('Owner/r-nocreds', { getEnv: () => undefined, fetchImpl })).rejects.toThrow(/PRIVATE_KEY/);
  });

  test('throws when the App is not installed on the repo (resolve 404) — no token minted', async () => {
    const { fetchImpl, calls } = makeAppFetch({ installationId: '8100', failInstall: true });
    await expect(getPromotionDispatchToken('Owner/r-noinstall', { getEnv: env(), fetchImpl })).rejects.toThrow(/installation/i);
    expect(calls.some((c) => c.url.includes('/access_tokens'))).toBe(false); // never reached the exchange
  });

  test('never logs the private key, App JWT, or minted token', async () => {
    const captured: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = (...a: unknown[]) => captured.push(a.join(' '));
    console.warn = (...a: unknown[]) => captured.push(a.join(' '));
    console.error = (...a: unknown[]) => captured.push(a.join(' '));
    try {
      const { fetchImpl } = makeAppFetch({ installationId: '8200', token: 'ghs_SECRET_TOKEN_MARKER' });
      await getPromotionDispatchToken('Owner/repo-logs', { getEnv: env(), fetchImpl });
    } finally {
      console.log = orig.log; console.warn = orig.warn; console.error = orig.error;
    }
    const blob = captured.join('\n');
    expect(blob).not.toContain('ghs_SECRET_TOKEN_MARKER');
    expect(blob).not.toContain('BEGIN PRIVATE KEY');
    expect(blob).not.toContain(APP_KEY);
  });
});
