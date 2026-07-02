/**
 * U8 — /admin static-asset reverse proxy (opt-in via ADMIN_ASSET_ORIGIN).
 *
 * Mirrors the serve-http unit-test seam (resolveBootstrapToken /
 * probeLiveness): the security-critical rules live in pure, exported helpers
 * that are exercised directly with an injected fetch stub — no live network,
 * no Express client (Express-layer wiring is covered by e2e).
 *
 * Asserts, per the U8 hardening contract:
 *   (a) a /admin/* asset request proxies to the origin and the upstream request
 *       provably OMITS Cookie / Authorization (only the bypass token travels);
 *   (b) /admin/api/*, /admin/events, /admin/login, /admin/auth/* stay LOCAL
 *       (never proxied — the fetch stub is not called);
 *   (c) an unset (or whitespace-only) ADMIN_ASSET_ORIGIN → null gate → the
 *       caller keeps the pre-U8 embedded/dev fallback (no proxy);
 *   (d) path traversal and non-GET/HEAD methods are rejected;
 *   + the in-memory TTL cache serves last-good bytes on an origin blip and
 *     fails closed (503) only on a cold miss.
 */

import { describe, test, expect } from 'bun:test';
import {
  resolveAdminAssetOrigin,
  isAdminLocalRoute,
  normalizeAdminAssetPath,
  proxyAdminAsset,
  type AdminAssetCacheEntry,
  type AdminProxyDeps,
} from '../src/commands/serve-http.ts';

const ORIGIN = 'https://admin.example.internal';
const BYPASS = 'bypass-token-abc123';

/** Records every outbound fetch so header/URL/method can be asserted. */
function makeFetchStub(
  behavior: Response | (() => Response | Promise<Response>) | Error,
) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = (async (input: any, init: any) => {
    calls.push({ url: String(input), init });
    if (behavior instanceof Error) throw behavior;
    return typeof behavior === 'function' ? await behavior() : behavior;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function makeDeps(
  fetchFn: typeof fetch,
  overrides: Partial<AdminProxyDeps> = {},
): AdminProxyDeps {
  return {
    origin: ORIGIN,
    bypassToken: BYPASS,
    fetchFn,
    cache: new Map<string, AdminAssetCacheEntry>(),
    ttlMs: 60_000,
    now: () => 1_000,
    ...overrides,
  };
}

/** Lower-cases header keys so presence checks are case-insensitive. */
function headerKeys(init: any): string[] {
  return Object.keys(init?.headers ?? {}).map(k => k.toLowerCase());
}

describe('resolveAdminAssetOrigin (U8 fail-closed gate)', () => {
  test('unset → null (caller keeps pre-U8 embedded/dev fallback, no proxy)', () => {
    expect(resolveAdminAssetOrigin({})).toBeNull();
  });

  test('empty / whitespace-only → null (fail closed, treated as unset)', () => {
    expect(resolveAdminAssetOrigin({ ADMIN_ASSET_ORIGIN: '' })).toBeNull();
    expect(resolveAdminAssetOrigin({ ADMIN_ASSET_ORIGIN: '   ' })).toBeNull();
  });

  test('set → trimmed origin (proxy enabled)', () => {
    expect(resolveAdminAssetOrigin({ ADMIN_ASSET_ORIGIN: '  https://x.internal  ' }))
      .toBe('https://x.internal');
  });
});

describe('isAdminLocalRoute (exclusions stay local, never proxied)', () => {
  test('the four local surfaces return true', () => {
    expect(isAdminLocalRoute('/admin/api/requests')).toBe(true);
    expect(isAdminLocalRoute('/admin/events')).toBe(true);
    expect(isAdminLocalRoute('/admin/login')).toBe(true);
    expect(isAdminLocalRoute('/admin/auth/nonce-xyz')).toBe(true);
  });

  test('a static asset path returns false (proxy candidate)', () => {
    expect(isAdminLocalRoute('/admin/')).toBe(false);
    expect(isAdminLocalRoute('/admin/assets/app.js')).toBe(false);
  });
});

describe('normalizeAdminAssetPath (traversal rejection)', () => {
  test('valid /admin paths pass through unchanged', () => {
    expect(normalizeAdminAssetPath('/admin/')).toBe('/admin/');
    expect(normalizeAdminAssetPath('/admin/assets/app.js')).toBe('/admin/assets/app.js');
    expect(normalizeAdminAssetPath('/admin')).toBe('/admin');
  });

  test('literal .. segment rejected', () => {
    expect(normalizeAdminAssetPath('/admin/../etc/passwd')).toBeNull();
    expect(normalizeAdminAssetPath('/admin/assets/../../secret')).toBeNull();
  });

  test('percent-encoded dots / slashes / backslashes rejected (any case)', () => {
    expect(normalizeAdminAssetPath('/admin/%2e%2e/secret')).toBeNull();
    expect(normalizeAdminAssetPath('/admin/%2E%2E/secret')).toBeNull();
    expect(normalizeAdminAssetPath('/admin/assets%2f..%2fx')).toBeNull();
    expect(normalizeAdminAssetPath('/admin/x%5c..')).toBeNull();
  });

  test('literal backslash / NUL rejected', () => {
    expect(normalizeAdminAssetPath('/admin/a\\b')).toBeNull();
    expect(normalizeAdminAssetPath('/admin/a\0b')).toBeNull();
  });

  test('path outside the /admin prefix rejected', () => {
    expect(normalizeAdminAssetPath('/mcp')).toBeNull();
    expect(normalizeAdminAssetPath('/adminx')).toBeNull();
  });
});

describe('proxyAdminAsset — (a) proxies + strips Cookie/Authorization', () => {
  test('GET /admin/ forwards to the origin with ONLY the bypass token', async () => {
    const upstream = new Response('<!doctype html>hello', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const { fn, calls } = makeFetchStub(upstream);
    const result = await proxyAdminAsset('/admin/', 'GET', '', makeDeps(fn));

    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.status).toBe(200);
      expect(result.contentType).toBe('text/html; charset=utf-8');
      expect(result.body.toString()).toBe('<!doctype html>hello');
      expect(result.fromCache).toBe(false);
    }

    // Exactly one upstream call, to the composed URL, method GET.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${ORIGIN}/admin/`);
    expect((calls[0].init.method as string).toUpperCase()).toBe('GET');

    // The security-critical assertion: the admin session cookie /
    // Authorization NEVER transit to the private origin; only the bypass
    // token (plus a minimal Accept) is present.
    const keys = headerKeys(calls[0].init);
    expect(keys).not.toContain('cookie');
    expect(keys).not.toContain('authorization');
    expect(calls[0].init.headers['x-vercel-protection-bypass']).toBe(BYPASS);
  });

  test('asset path with query string is forwarded verbatim', async () => {
    const upstream = new Response('body{}', {
      status: 200,
      headers: { 'content-type': 'text/css' },
    });
    const { fn, calls } = makeFetchStub(upstream);
    const result = await proxyAdminAsset('/admin/assets/app.css', 'GET', '?v=2', makeDeps(fn));
    expect(result.kind).toBe('response');
    expect(calls[0].url).toBe(`${ORIGIN}/admin/assets/app.css?v=2`);
  });

  test('trailing-slash origin is normalized (no double slash)', async () => {
    const { fn, calls } = makeFetchStub(new Response('x', { status: 200 }));
    await proxyAdminAsset('/admin/assets/app.js', 'GET', '', makeDeps(fn, { origin: 'https://x/' }));
    expect(calls[0].url).toBe('https://x/admin/assets/app.js');
  });

  test('HEAD is forwarded (method allowed)', async () => {
    const { fn, calls } = makeFetchStub(new Response(null, { status: 200 }));
    const result = await proxyAdminAsset('/admin/assets/app.js', 'HEAD', '', makeDeps(fn));
    expect(result.kind).toBe('response');
    expect(calls).toHaveLength(1);
    expect((calls[0].init.method as string).toUpperCase()).toBe('HEAD');
  });
});

describe('proxyAdminAsset — (b) local exclusions are never proxied', () => {
  for (const p of ['/admin/api/requests', '/admin/events', '/admin/login', '/admin/auth/nonce']) {
    test(`${p} → local, fetch not called`, async () => {
      const { fn, calls } = makeFetchStub(new Error('should not be called'));
      const result = await proxyAdminAsset(p, 'GET', '', makeDeps(fn));
      expect(result.kind).toBe('local');
      expect(calls).toHaveLength(0);
    });
  }
});

describe('proxyAdminAsset — (d) traversal + method rejection', () => {
  test('literal traversal → 400, fetch not called', async () => {
    const { fn, calls } = makeFetchStub(new Error('should not be called'));
    const result = await proxyAdminAsset('/admin/../etc/passwd', 'GET', '', makeDeps(fn));
    expect(result).toEqual({ kind: 'reject', status: 400 });
    expect(calls).toHaveLength(0);
  });

  test('encoded traversal (%2e%2e) → 400, fetch not called', async () => {
    const { fn, calls } = makeFetchStub(new Error('should not be called'));
    const result = await proxyAdminAsset('/admin/%2e%2e/secret', 'GET', '', makeDeps(fn));
    expect(result).toEqual({ kind: 'reject', status: 400 });
    expect(calls).toHaveLength(0);
  });

  test('non-GET/HEAD method (POST) → 405, fetch not called', async () => {
    const { fn, calls } = makeFetchStub(new Error('should not be called'));
    const result = await proxyAdminAsset('/admin/assets/app.js', 'POST', '', makeDeps(fn));
    expect(result).toEqual({ kind: 'reject', status: 405 });
    expect(calls).toHaveLength(0);
  });

  test('local-route exclusion wins over method gate (DELETE /admin/api → local)', async () => {
    const { fn, calls } = makeFetchStub(new Error('should not be called'));
    const result = await proxyAdminAsset('/admin/api/x', 'DELETE', '', makeDeps(fn));
    expect(result.kind).toBe('local');
    expect(calls).toHaveLength(0);
  });
});

describe('proxyAdminAsset — TTL cache + fail-closed fallback', () => {
  test('second request within TTL is served from cache (no refetch)', async () => {
    const cache = new Map<string, AdminAssetCacheEntry>();
    const okFetch = makeFetchStub(new Response('cached-bytes', {
      status: 200,
      headers: { 'content-type': 'application/javascript' },
    }));
    const deps = makeDeps(okFetch.fn, { cache, now: () => 1_000 });

    const first = await proxyAdminAsset('/admin/assets/app.js', 'GET', '', deps);
    expect(first.kind).toBe('response');
    if (first.kind === 'response') expect(first.fromCache).toBe(false);

    // A throwing fetch proves the second request never reaches the origin.
    const boom = makeFetchStub(new Error('origin down'));
    const second = await proxyAdminAsset('/admin/assets/app.js', 'GET', '', {
      ...deps,
      fetchFn: boom.fn,
      now: () => 30_000, // still < 1_000 + 60_000
    });
    expect(second.kind).toBe('response');
    if (second.kind === 'response') {
      expect(second.fromCache).toBe(true);
      expect(second.body.toString()).toBe('cached-bytes');
      expect(second.contentType).toBe('application/javascript');
    }
    expect(boom.calls).toHaveLength(0);
  });

  test('origin blip past TTL serves last-good cached bytes', async () => {
    const cache = new Map<string, AdminAssetCacheEntry>();
    const okFetch = makeFetchStub(new Response('good', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    }));
    await proxyAdminAsset('/admin/assets/x.txt', 'GET', '', makeDeps(okFetch.fn, { cache, now: () => 1_000 }));

    // TTL lapsed AND origin throws → last-good bytes, not a crash.
    const boom = makeFetchStub(new Error('ECONNREFUSED'));
    const result = await proxyAdminAsset('/admin/assets/x.txt', 'GET', '', makeDeps(boom.fn, { cache, now: () => 999_999 }));
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.fromCache).toBe(true);
      expect(result.body.toString()).toBe('good');
    }
  });

  test('cold miss + origin failure fails closed with 503', async () => {
    const boom = makeFetchStub(new Error('ECONNREFUSED'));
    const result = await proxyAdminAsset('/admin/assets/never.js', 'GET', '', makeDeps(boom.fn));
    expect(result).toEqual({ kind: 'reject', status: 503 });
  });

  test('non-200 upstream responses are not cached', async () => {
    const cache = new Map<string, AdminAssetCacheEntry>();
    const notFound = makeFetchStub(new Response('missing', { status: 404 }));
    const r1 = await proxyAdminAsset('/admin/assets/missing.js', 'GET', '', makeDeps(notFound.fn, { cache }));
    expect(r1.kind).toBe('response');
    if (r1.kind === 'response') expect(r1.status).toBe(404);
    expect(cache.size).toBe(0);
  });

  test('works without a bypass token (header simply omitted)', async () => {
    const { fn, calls } = makeFetchStub(new Response('x', { status: 200 }));
    const result = await proxyAdminAsset('/admin/', 'GET', '', makeDeps(fn, { bypassToken: undefined }));
    expect(result.kind).toBe('response');
    expect(headerKeys(calls[0].init)).not.toContain('x-vercel-protection-bypass');
  });
});
