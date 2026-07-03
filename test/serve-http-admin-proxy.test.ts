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
  extractAdminProxyArgs,
  ADMIN_ASSET_CACHE_MAX_ENTRIES,
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

    // The outbound header set is built from scratch: ONLY accept + the bypass
    // token travel. Asserting the EXACT key set (not just "cookie absent",
    // which is vacuous here since proxyAdminAsset never receives inbound
    // headers) proves nothing extra is ever attached. The inbound-headers
    // guarantee is covered at the Express-handler seam (extractAdminProxyArgs).
    expect(headerKeys(calls[0].init).sort()).toEqual(['accept', 'x-vercel-protection-bypass']);
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

// A fetch that resolves ONLY when its injected AbortSignal fires — a genuine
// hang the timeout must break (mirrors real fetch honoring the signal). If the
// handler forgot to pass a signal this promise never settles and the test times
// out, which is itself the failure signal for F2.
function makeHangingFetch() {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = ((input: any, init: any) => {
    calls.push({ url: String(input), init });
    return new Promise<Response>((_resolve, reject) => {
      const signal: AbortSignal | undefined = init?.signal;
      if (!signal) return; // no signal → real hang → test times out (F2 not fixed)
      const onAbort = () => reject(signal.reason ?? new DOMException('aborted', 'AbortError'));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('extractAdminProxyArgs — (a′) Express-handler seam: ONLY path/method/search flow in', () => {
  test('returns exactly {reqPath, method, search} — nothing else', () => {
    expect(
      extractAdminProxyArgs({ path: '/admin/assets/app.js', method: 'GET', originalUrl: '/admin/assets/app.js?v=7' }),
    ).toEqual({ reqPath: '/admin/assets/app.js', method: 'GET', search: '?v=7' });
  });

  test('no query string → empty search', () => {
    expect(extractAdminProxyArgs({ path: '/admin/', method: 'HEAD', originalUrl: '/admin/' }))
      .toEqual({ reqPath: '/admin/', method: 'HEAD', search: '' });
  });

  test('inbound headers / cookies are NEVER read (the real guarantee, not structural)', () => {
    // A request whose headers/cookies THROW on access. Because the proxy's sole
    // Express call site is this extractor, if it touched any inbound header the
    // Cookie/Authorization could reach the private origin — this test would then
    // throw. It passes only because path/method/originalUrl are the ONLY reads.
    const trap = new Proxy(
      { path: '/admin/x.js', method: 'GET', originalUrl: '/admin/x.js?a=1' } as Record<string, unknown>,
      {
        get(target, prop) {
          if (prop === 'headers' || prop === 'cookies' || prop === 'header' || prop === 'get') {
            throw new Error(`extractAdminProxyArgs read a forbidden inbound property: ${String(prop)}`);
          }
          return target[prop as string];
        },
      },
    ) as unknown as { path: string; method: string; originalUrl: string };
    expect(extractAdminProxyArgs(trap)).toEqual({ reqPath: '/admin/x.js', method: 'GET', search: '?a=1' });
  });
});

describe('proxyAdminAsset — F1 bounded LRU cache (memory-exhaustion DoS)', () => {
  test('cycling many distinct cache keys stays at or below the cap (not unbounded)', async () => {
    const cache = new Map<string, AdminAssetCacheEntry>();
    // Fresh 200 per call so every distinct query string is a distinct cache key.
    const okFetch = makeFetchStub(() => new Response('x', { status: 200, headers: { 'content-type': 'text/plain' } }));
    for (let i = 0; i < 500; i++) {
      await proxyAdminAsset('/admin/assets/app.js', 'GET', `?v=${i}`, makeDeps(okFetch.fn, { cache, now: () => 1_000 }));
    }
    // 500 distinct keys inserted, but the LRU evicts the oldest on each insert
    // past capacity → the Map saturates AT the cap, it does not grow to 500.
    expect(cache.size).toBe(ADMIN_ASSET_CACHE_MAX_ENTRIES);
    expect(cache.size).toBeLessThanOrEqual(ADMIN_ASSET_CACHE_MAX_ENTRIES);
  });

  test('an oversized body is proxied but never cached', async () => {
    const cache = new Map<string, AdminAssetCacheEntry>();
    const big = 'a'.repeat(64);
    const okFetch = makeFetchStub(new Response(big, { status: 200, headers: { 'content-type': 'text/plain' } }));
    const result = await proxyAdminAsset('/admin/assets/big.bin', 'GET', '', makeDeps(okFetch.fn, { cache, maxBodyBytes: 32, now: () => 1_000 }));
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.body.toString()).toBe(big); // served in full
      expect(result.fromCache).toBe(false);
    }
    expect(cache.size).toBe(0); // but not retained
  });
});

describe('proxyAdminAsset — F2 fetch timeout (a hung origin must not park the handler)', () => {
  test('a hung origin aborts via the timeout → cold miss fails closed with 503', async () => {
    const { fn, calls } = makeHangingFetch();
    const result = await proxyAdminAsset('/admin/assets/app.js', 'GET', '', makeDeps(fn, { timeoutMs: 25 }));
    expect(result).toEqual({ kind: 'reject', status: 503 });
    // The handler passed a real AbortSignal (proves the timeout is wired, F2).
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test('a hung origin with a warm cache serves last-good bytes (not a 503)', async () => {
    const cache = new Map<string, AdminAssetCacheEntry>();
    await proxyAdminAsset(
      '/admin/assets/app.js', 'GET', '',
      makeDeps(makeFetchStub(new Response('warm', { status: 200, headers: { 'content-type': 'text/plain' } })).fn, { cache, now: () => 1_000 }),
    );
    const { fn } = makeHangingFetch();
    const result = await proxyAdminAsset('/admin/assets/app.js', 'GET', '', makeDeps(fn, { cache, now: () => 999_999, timeoutMs: 25 }));
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.fromCache).toBe(true);
      expect(result.body.toString()).toBe('warm');
    }
  });
});

describe('proxyAdminAsset — F4 3xx upstream → SPA index fallback (same-origin, no redirect leak)', () => {
  test('a GET that upstream 302s is served the SPA index.html, not a bare redirect', async () => {
    // First upstream call: the deep link 302s (no matching static file). Second
    // call: the index. The handler must re-fetch /admin/index.html and return it.
    let n = 0;
    const fn = (async (input: any, _init: any) => {
      n++;
      if (n === 1) return new Response(null, { status: 302, headers: { location: '/admin/' } });
      return new Response('<!doctype html>app-shell', { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const calls: string[] = [];
    const wrapped = (async (input: any, init: any) => { calls.push(String(input)); return fn(input, init); }) as unknown as typeof fetch;

    const result = await proxyAdminAsset('/admin/agents/123', 'GET', '', makeDeps(wrapped));
    expect(result.kind).toBe('response');
    if (result.kind === 'response') {
      expect(result.status).toBe(200);
      expect(result.contentType).toBe('text/html');
      expect(result.body.toString()).toBe('<!doctype html>app-shell');
    }
    // Second fetch targeted the index, not a redirect chase of the deep link.
    expect(calls).toEqual([`${ORIGIN}/admin/agents/123`, `${ORIGIN}/admin/index.html`]);
  });

  test('HEAD is NOT rewritten to the index (no body to fall back to)', async () => {
    const { fn, calls } = makeFetchStub(new Response(null, { status: 302, headers: { location: '/admin/' } }));
    const result = await proxyAdminAsset('/admin/agents/123', 'HEAD', '', makeDeps(fn));
    expect(result.kind).toBe('response');
    if (result.kind === 'response') expect(result.status).toBe(302);
    expect(calls).toHaveLength(1); // no index re-fetch for HEAD
  });
});

describe('unset ADMIN_ASSET_ORIGIN → pre-U8 dev/embedded fallback (behavior preserved)', () => {
  // The Express wiring registers the proxy catch-all ONLY inside
  // `if (resolveAdminAssetOrigin())`. With the env unset (or whitespace-only)
  // the gate is null → that block is skipped entirely → the pre-U8
  // express.static (dev) / embedded-manifest branch serves /admin, so default
  // public deployments are byte-identical to before U8 (no proxy is wired).
  test('unset gate resolves null → proxy catch-all is never wired (dev/embedded path used)', () => {
    const saved = process.env.ADMIN_ASSET_ORIGIN;
    delete (process.env as Record<string, string | undefined>).ADMIN_ASSET_ORIGIN;
    try {
      expect(resolveAdminAssetOrigin()).toBeNull();
    } finally {
      if (saved === undefined) delete (process.env as Record<string, string | undefined>).ADMIN_ASSET_ORIGIN;
      else process.env.ADMIN_ASSET_ORIGIN = saved;
    }
  });

  test('set gate resolves the trimmed origin → proxy catch-all is wired', () => {
    expect(resolveAdminAssetOrigin({ ADMIN_ASSET_ORIGIN: '  https://admin.internal  ' })).toBe('https://admin.internal');
  });
});
