/**
 * Tests for src/core/connectors/redact.ts (TECH-2032).
 *
 * Pure functions — no DB engine required. Covers strip() PII + secret masking,
 * minimize() field-minimization, the fail-closed unknown-profile path, the
 * body-drop + secret-mask acceptance scenario, and idempotency.
 */

import { describe, test, expect } from 'bun:test';
import { minimize, strip, isKnownProfile, type RawConnectorItem } from '../src/core/connectors/redact.ts';

describe('strip — PII (mirrors scrubPii) + secret shapes', () => {
  test('masks the six PII families', () => {
    expect(strip('reach me at alice@example.com')).not.toContain('alice@example.com');
    expect(strip('call 555-123-4567')).toContain('[REDACTED]');
    expect(strip('ssn 123-45-6789')).toContain('[REDACTED]');
    expect(strip('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdEFGHijkl')).toContain('[REDACTED]');
    expect(strip('Authorization: Bearer abcdef1234567890XYZ')).toContain('[REDACTED]');
    expect(strip('card 4111 1111 1111 1111')).toContain('[REDACTED]'); // valid-Luhn Visa test number
  });

  test('masks common secret shapes', () => {
    expect(strip('key AKIAIOSFODNN7EXAMPLE here')).toContain('[REDACTED]');
    expect(strip('token ghp_' + 'a'.repeat(36))).toContain('[REDACTED]');
    expect(strip('xoxb-123456789012-abcdefghijkl')).toContain('[REDACTED]');
    expect(strip('google AIza' + 'a'.repeat(35))).toContain('[REDACTED]');
    expect(strip('openai sk-' + 'a'.repeat(32))).toContain('[REDACTED]');
    expect(strip('stripe sk_live_' + 'a'.repeat(24))).toContain('[REDACTED]');
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIsecretkeymaterial\n-----END RSA PRIVATE KEY-----';
    expect(strip(pem)).not.toContain('MIIsecretkeymaterial');
  });

  test('leaves clean text untouched', () => {
    expect(strip('the quarterly report shipped on schedule')).toBe('the quarterly report shipped on schedule');
  });

  test('is idempotent', () => {
    const once = strip('email bob@example.com and key AKIAIOSFODNN7EXAMPLE');
    expect(strip(once)).toBe(once);
  });

  test('empty / falsy input is returned unchanged', () => {
    expect(strip('')).toBe('');
  });
});

describe('minimize — field-minimization with fail-closed profiles', () => {
  const commsItem = (): RawConnectorItem => ({
    sourceRecordId: 'msg-42',
    metadata: { channel: 'general', author: 'carol', secret_token: 'AKIAIOSFODNN7EXAMPLE', dm_field: 'private' },
    summary: 'shipped the fix',
    body: 'full message body — sensitive content + AKIAIOSFODNN7EXAMPLE',
  });

  test('comms-class drops the body (AC4)', () => {
    const out = minimize(commsItem(), 'comms');
    expect('body' in out).toBe(false);
    expect(out.redactions).toContainEqual({ field: 'body', action: 'dropped' });
  });

  test('keeps only allowlisted metadata; drops the rest', () => {
    const out = minimize(commsItem(), 'comms');
    expect(out.metadata.channel).toBe('general');
    expect(out.metadata.author).toBe('carol');
    expect('secret_token' in out.metadata).toBe(false);
    expect('dm_field' in out.metadata).toBe(false);
    expect(out.redactions).toContainEqual({ field: 'metadata.secret_token', action: 'dropped' });
  });

  test('a secret embedded in a kept field is masked (AC4)', () => {
    const item: RawConnectorItem = {
      sourceRecordId: 'msg-43',
      metadata: { url: 'https://x.test/?t=AKIAIOSFODNN7EXAMPLE' },
      summary: 'creds AKIAIOSFODNN7EXAMPLE and bob@example.com',
    };
    const out = minimize(item, 'comms');
    expect(out.summary).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out.summary).not.toContain('bob@example.com');
    expect(out.summary).toContain('[REDACTED]');
    expect(String(out.metadata.url)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out.redactions).toContainEqual({ field: 'summary', action: 'masked' });
  });

  test('unknown profile → maximal minimization, fail-closed (AC2)', () => {
    const out = minimize(commsItem(), 'totally-unknown-class');
    expect(Object.keys(out.metadata)).toHaveLength(0);
    expect(out.summary).toBeUndefined();
    expect('body' in out).toBe(false);
    expect(out.sourceRecordId).toBe('msg-42'); // identity preserved
  });

  test('isKnownProfile distinguishes known vs unknown', () => {
    expect(isKnownProfile('comms')).toBe(true);
    expect(isKnownProfile('crm')).toBe(true);
    expect(isKnownProfile('definitely-not-a-class')).toBe(false);
  });

  test('re-redaction is idempotent (AC3)', () => {
    const once = minimize(commsItem(), 'comms');
    const twice = minimize(once, 'comms');
    expect(twice.metadata).toEqual(once.metadata);
    expect(twice.summary).toEqual(once.summary);
    expect('body' in twice).toBe(false);
  });

  test('non-string metadata values survive verbatim when allowlisted', () => {
    const item: RawConnectorItem = { sourceRecordId: 'i-1', metadata: { number: 7, url: 'https://x.test/a' } };
    const out = minimize(item, 'code');
    expect(out.metadata.number).toBe(7);
    expect(out.metadata.url).toBe('https://x.test/a');
  });
});

describe('strip — hardened secret coverage (review fixes)', () => {
  test('AWS secret access key (prefix-less, in a secret-named assignment) is masked', () => {
    const out = strip('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(out).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(out).toContain('[REDACTED]');
  });

  test('basic-auth URL credential is masked even with an IP / bare host', () => {
    expect(strip('https://svc:abc123XYZtoken@10.0.0.5:5432/db')).not.toContain('abc123XYZtoken');
    expect(strip('postgres://user:p4ssw0rd@db-internal/app')).not.toContain('p4ssw0rd');
    expect(strip('https://alice:s3cr3tval@github.com/o/r.git')).not.toContain('s3cr3tval');
  });

  test('non-Bearer Authorization schemes (Basic/token) are masked', () => {
    expect(strip('Authorization: Basic dXNlcjpwYXNzd29yZA==')).not.toContain('dXNlcjpwYXNzd29yZA==');
    expect(strip('Authorization: token abcdef0123456789')).not.toContain('abcdef0123456789');
  });

  test('Authorization prose (capitalized non-scheme words) is NOT over-redacted', () => {
    // Anchored to the known scheme set, so approval-comment phrasing survives intact.
    expect(strip('Authorization: Manager approval needed first')).toBe('Authorization: Manager approval needed first');
    expect(strip('Authorization: Pending review by the security team')).toBe('Authorization: Pending review by the security team');
  });

  test('Google OAuth client secret + Azure AccountKey are masked', () => {
    expect(strip('client GOCSPX-' + 'a'.repeat(28))).toContain('[REDACTED]');
    expect(strip('AccountKey=' + 'a'.repeat(40) + '==;')).toContain('[REDACTED]');
  });

  test('generic secret-named assignment masks the value, keeps the key', () => {
    const out = strip("client_secret='" + 'x'.repeat(24) + "'");
    expect(out).toContain('client_secret');
    expect(out).not.toContain('x'.repeat(24));
  });
});

describe('strip — ReDoS / performance bound (review fix)', () => {
  test('repeated unterminated PEM markers stay linear (the bounded-gap fix)', () => {
    // Unbounded, this input measured ~11s (quadratic). With the {0,8192}? gap bound
    // it is linear (~300ms for 20k markers); a generous ceiling proves the fix
    // without flaking on machine variance.
    const pathological = '-----BEGIN A PRIVATE KEY-----'.repeat(20000);
    const t0 = performance.now();
    strip(pathological);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('strip — idempotency across the full pattern catalog', () => {
  const catalog = [
    'email a@b.com', '555-123-4567', '123-45-6789',
    'Bearer abcdef1234567890XYZ', 'card 4111 1111 1111 1111',
    'AKIAIOSFODNN7EXAMPLE', 'ghp_' + 'a'.repeat(36), 'xoxb-123456789012-abcdefghijkl',
    'AIza' + 'a'.repeat(35), 'sk-' + 'a'.repeat(32), 'sk_live_' + 'a'.repeat(24),
    'GOCSPX-' + 'a'.repeat(28), 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    'https://u:p4sslong@10.0.0.5/x', 'Authorization: Basic dXNlcjpwYXNz',
  ];
  for (const input of catalog) {
    test(`strip(strip(x)) === strip(x): ${input.slice(0, 22)}`, () => {
      const once = strip(input);
      expect(strip(once)).toBe(once);
    });
  }
});

describe('strip — documented v1 coverage boundary (intentionally NOT masked)', () => {
  // These need context/NER and are explicitly out of scope for v1. Asserting current
  // behavior PINS the boundary so any future accidental narrowing shows up in the diff.
  test('IPv4, IBAN, and a bare personal name pass through unchanged', () => {
    expect(strip('host 192.168.1.42 reachable')).toContain('192.168.1.42');
    expect(strip('iban GB29NWBK60161331926819')).toContain('GB29NWBK60161331926819');
    expect(strip('owner is Jane Doe per the record')).toContain('Jane Doe');
  });
});
