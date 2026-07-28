/**
 * test/rate-limit-key.test.ts — pins the per-principal rate-limit keying.
 *
 * The property that matters is NOT "the key looks right". It is:
 *   two distinct principals must never share a bucket, and the degenerate
 *   case must be per-IP rather than global.
 * A limiter that collapses everyone into one key is worse than no limiter,
 * because it converts an attacker's traffic into a denial of service against
 * every legitimate caller.
 */

import { test, expect, describe } from 'bun:test';
import { rateLimitKey, basicAuthClientId, resolveTrustProxy } from '../src/core/rate-limit-key.ts';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('basicAuthClientId', () => {
  test('extracts the user-id from a well-formed Basic header', () => {
    expect(basicAuthClientId(`Basic ${b64('client-abc:secret')}`)).toBe('client-abc');
  });

  test('splits on the FIRST colon — secrets may contain colons', () => {
    expect(basicAuthClientId(`Basic ${b64('client-abc:se:cr:et')}`)).toBe('client-abc');
  });

  test('handles a missing secret', () => {
    expect(basicAuthClientId(`Basic ${b64('client-abc')}`)).toBe('client-abc');
  });

  test('is case-insensitive on the scheme', () => {
    expect(basicAuthClientId(`basic ${b64('c1:s')}`)).toBe('c1');
  });

  test.each([
    ['undefined', undefined],
    ['empty', ''],
    ['wrong scheme', 'Bearer abc'],
    ['no payload', 'Basic '],
    ['empty user-id', `Basic ${b64(':secret')}`],
    ['whitespace user-id', `Basic ${b64('   :secret')}`],
  ])('returns undefined for %s rather than throwing', (_label, input) => {
    expect(basicAuthClientId(input as string | undefined)).toBeUndefined();
  });

  test('malformed base64 degrades to undefined, never throws', () => {
    expect(() => basicAuthClientId('Basic !!!not-base64!!!')).not.toThrow();
  });
});

describe('rateLimitKey — precedence', () => {
  test('authenticated client id wins over everything', () => {
    const k = rateLimitKey({
      ip: '1.2.3.4',
      auth: { clientId: 'jarvis' },
      headers: { authorization: `Basic ${b64('other:s')}` },
    });
    expect(k).toBe('cid:jarvis');
  });

  test('falls back to Basic user-id when unauthenticated', () => {
    const k = rateLimitKey({ ip: '1.2.3.4', headers: { authorization: `Basic ${b64('simon:s')}` } });
    expect(k).toBe('basic:simon');
  });

  test('falls back to ip when there is no identity at all', () => {
    expect(rateLimitKey({ ip: '9.9.9.9' })).toBe('ip:9.9.9.9');
  });

  test('reads headers via req.get when present (Express shape)', () => {
    const k = rateLimitKey({ ip: '1.1.1.1', get: (n) => (n.toLowerCase() === 'authorization' ? `Basic ${b64('viaget:s')}` : undefined) });
    expect(k).toBe('basic:viaget');
  });
});

describe('rateLimitKey — the invariants that make it a security control', () => {
  test('two distinct authenticated clients NEVER share a bucket', () => {
    const a = rateLimitKey({ ip: '10.0.0.1', auth: { clientId: 'alpha' } });
    const b = rateLimitKey({ ip: '10.0.0.1', auth: { clientId: 'beta' } });
    expect(a).not.toBe(b);
  });

  test('same IP, different principals, still separate buckets — this is the whole point', () => {
    // The production failure mode: every caller arrives with an identical
    // req.ip because trust proxy is misconfigured. Keying must still separate.
    const shared = '127.0.0.1';
    const keys = new Set([
      rateLimitKey({ ip: shared, auth: { clientId: 'c1' } }),
      rateLimitKey({ ip: shared, auth: { clientId: 'c2' } }),
      rateLimitKey({ ip: shared, headers: { authorization: `Basic ${b64('c3:s')}` } }),
    ]);
    expect(keys.size).toBe(3);
  });

  test('a client_id cannot be chosen to collide with an IP-derived key', () => {
    const spoof = rateLimitKey({ ip: '5.5.5.5', auth: { clientId: 'ip:9.9.9.9' } });
    const real = rateLimitKey({ ip: '9.9.9.9' });
    expect(spoof).not.toBe(real);
  });

  test('never returns a constant when any identity or IP exists', () => {
    expect(rateLimitKey({ ip: '8.8.8.8' })).not.toBe('unattributed');
  });

  test('only a request with no identity AND no ip reaches the last resort', () => {
    expect(rateLimitKey({})).toBe('unattributed');
  });

  test('a hostile oversized client id cannot bloat the key store', () => {
    const k = rateLimitKey({ auth: { clientId: 'x'.repeat(5000) } });
    expect(k.length).toBeLessThanOrEqual(128);
  });

  test('never throws on adversarial input', () => {
    expect(() => rateLimitKey({ headers: { authorization: ['a', 'b'] as unknown as string } })).not.toThrow();
    expect(() => rateLimitKey({ ip: '' })).not.toThrow();
  });
});

describe('resolveTrustProxy', () => {
  test('defaults to loopback when unset — no silent change for existing deploys', () => {
    expect(resolveTrustProxy({})).toBe('loopback');
    expect(resolveTrustProxy({ GBRAIN_TRUST_PROXY: '  ' })).toBe('loopback');
  });

  test('accepts a hop count', () => {
    expect(resolveTrustProxy({ GBRAIN_TRUST_PROXY: '1' })).toBe(1);
    expect(resolveTrustProxy({ GBRAIN_TRUST_PROXY: '2' })).toBe(2);
  });

  test('0 means trust nothing and must stay numeric, not fall back', () => {
    expect(resolveTrustProxy({ GBRAIN_TRUST_PROXY: '0' })).toBe(0);
  });

  test("'false' disables trust entirely", () => {
    expect(resolveTrustProxy({ GBRAIN_TRUST_PROXY: 'false' })).toBe(false);
  });

  test('passes an IP/CIDR list through to Express', () => {
    expect(resolveTrustProxy({ GBRAIN_TRUST_PROXY: '10.0.0.0/8' })).toBe('10.0.0.0/8');
  });
});
