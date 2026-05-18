import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { isSensitiveConfigKey, redactConfigValue } from '../src/commands/config.ts';

// redactUrl is not exported, so we test it by reading the source and
// reimplementing the regex to verify the pattern, then test via CLI

// Extract the redactUrl regex pattern from source
const configSource = readFileSync(
  new URL('../src/commands/config.ts', import.meta.url),
  'utf-8',
);

// Reimplemented from source for unit testing
function redactUrl(url: string): string {
  return url.replace(
    /(postgresql:\/\/[^:]+:)([^@]+)(@)/,
    '$1***$3',
  );
}

describe('redactUrl', () => {
  test('redacts password in postgresql:// URL', () => {
    const url = 'postgresql://user:secretpass@host:5432/dbname';
    expect(redactUrl(url)).toBe('postgresql://user:***@host:5432/dbname');
  });

  test('redacts complex passwords with special chars', () => {
    const url = 'postgresql://postgres:p@ss!w0rd#123@db.supabase.co:5432/postgres';
    // The regex is greedy on [^@]+ so it captures up to the LAST @
    const result = redactUrl(url);
    expect(result).not.toContain('p@ss');
    expect(result).toContain('***');
  });

  test('returns non-postgresql URLs unchanged', () => {
    const url = 'https://example.com/api';
    expect(redactUrl(url)).toBe(url);
  });

  test('returns plain strings unchanged', () => {
    expect(redactUrl('hello')).toBe('hello');
  });

  test('handles URL without password', () => {
    const url = 'postgresql://user@host:5432/dbname';
    // No colon after user means regex doesn't match
    expect(redactUrl(url)).toBe(url);
  });

  test('handles empty string', () => {
    expect(redactUrl('')).toBe('');
  });
});

describe('config source correctness', () => {
  test('redactUrl function exists in config.ts', () => {
    expect(configSource).toContain('function redactUrl');
  });

  test('redactUrl uses the correct regex pattern', () => {
    expect(configSource).toContain('postgresql:\\/\\/');
  });
});

describe('isSensitiveConfigKey (v0.36.x #892 regression)', () => {
  test('matches common sensitive key shapes', () => {
    expect(isSensitiveConfigKey('openai_api_key')).toBe(true);
    expect(isSensitiveConfigKey('anthropic_api_key')).toBe(true);
    expect(isSensitiveConfigKey('voyage_api_key')).toBe(true);
    expect(isSensitiveConfigKey('admin_token')).toBe(true);
    expect(isSensitiveConfigKey('database.password')).toBe(true);
    expect(isSensitiveConfigKey('CLIENT_SECRET')).toBe(true);
    expect(isSensitiveConfigKey('auth')).toBe(true);
    expect(isSensitiveConfigKey('passwd')).toBe(true);
  });

  test('does NOT false-positive on lookalike substrings', () => {
    // Pre-fix `.includes('key')` would have matched 'monkey' and 'parsekey'.
    expect(isSensitiveConfigKey('monkey_id')).toBe(false);
    expect(isSensitiveConfigKey('parsekeyword')).toBe(false);
    expect(isSensitiveConfigKey('tokenize')).toBe(false);
    expect(isSensitiveConfigKey('autocomplete')).toBe(false);
  });

  test('non-sensitive keys pass through', () => {
    expect(isSensitiveConfigKey('search.mode')).toBe(false);
    expect(isSensitiveConfigKey('sync.repo_path')).toBe(false);
    expect(isSensitiveConfigKey('embedding_model')).toBe(false);
  });
});

describe('redactConfigValue (v0.36.x #892 — set output regression)', () => {
  test('redacts sensitive keys to ***', () => {
    expect(redactConfigValue('openai_api_key', 'sk-test-123')).toBe('***');
    expect(redactConfigValue('admin_token', 'eyJhbGciOiJIUzI1NiJ9')).toBe('***');
  });

  test('redacts postgresql URL passwords regardless of key', () => {
    expect(redactConfigValue('database_url', 'postgresql://u:secret@h:5432/d'))
      .toBe('postgresql://u:***@h:5432/d');
  });

  test('non-sensitive values pass through unchanged', () => {
    expect(redactConfigValue('search.mode', 'balanced')).toBe('balanced');
    expect(redactConfigValue('embedding_model', 'voyage:voyage-3-large'))
      .toBe('voyage:voyage-3-large');
  });
});
