import { describe, expect, test } from 'bun:test';
import {
  isMigrationIdempotent,
  MigrationDriftError,
  MigrationRetryExhausted,
  MIGRATIONS,
  LATEST_VERSION,
} from '../src/core/migrate.ts';

describe('isMigrationIdempotent — D6 default', () => {
  test('default is true (existing migrations were authored as idempotent)', () => {
    expect(isMigrationIdempotent({ version: 1, name: 'x', sql: '' })).toBe(true);
  });

  test('explicit true', () => {
    expect(
      isMigrationIdempotent({ version: 1, name: 'x', sql: '', idempotent: true })
    ).toBe(true);
  });

  test('explicit false opts out (destructive)', () => {
    expect(
      isMigrationIdempotent({ version: 1, name: 'x', sql: '', idempotent: false })
    ).toBe(false);
  });

  test('every existing migration has idempotent default-true', () => {
    // Sanity: nothing in MIGRATIONS marks itself as non-idempotent today.
    // If a future migration sets idempotent: false, this assertion will
    // surface it as a change-of-shape signal that the test suite catches.
    for (const m of MIGRATIONS) {
      expect(isMigrationIdempotent(m)).toBe(true);
    }
  });
});

describe('LATEST_VERSION', () => {
  test('matches max version in MIGRATIONS', () => {
    const expected = Math.max(...MIGRATIONS.map(m => m.version));
    expect(LATEST_VERSION).toBe(expected);
  });
});

describe('MigrationDriftError', () => {
  test('carries the version + name + hint', () => {
    const err = new MigrationDriftError(42, 'pages_emotional_weight', 'column missing');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MigrationDriftError');
    expect(err.version).toBe(42);
    expect(err.migrationName).toBe('pages_emotional_weight');
    expect(err.hint).toBe('column missing');
    expect(err.message).toContain('v42');
    expect(err.message).toContain('pages_emotional_weight');
  });
});

describe('MigrationRetryExhausted (F2 named-PID UX)', () => {
  test('with a blocker, suggests pg_terminate_backend', () => {
    const err = new MigrationRetryExhausted(
      42,
      'some_migration',
      3,
      [{ pid: 12345, state: 'idle in transaction', query_start: '2026-05-08 14:02:00', query: 'SELECT 1' }],
      new Error('canceling statement due to statement timeout'),
    );
    expect(err.message).toContain('PID 12345');
    expect(err.message).toContain('pg_terminate_backend(12345)');
    expect(err.message).toContain('failed after 3 attempts');
    expect(err.lastBlockers[0].pid).toBe(12345);
  });

  test('without a blocker, suggests checking pg_locks + audit log', () => {
    const err = new MigrationRetryExhausted(
      1, 'm', 3, [],
      new Error('connection refused'),
    );
    expect(err.message).toContain('No idle-in-transaction blockers');
    expect(err.message).toContain('pg_locks');
  });
});

// TECH-2031: connector_candidates migration v93
// Moved here from migrate.test.ts to keep that file from growing further.
describe('TECH-2031 — migration v93 connector_candidates_table', () => {
  test('LATEST_VERSION is >= 93 after TECH-2031 lands', () => {
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(93);
  });

  test('MIGRATIONS contains an entry with version 93 and name connector_candidates_table', () => {
    const v93 = MIGRATIONS.find(m => m.version === 93);
    expect(v93).toBeDefined();
    expect(v93?.name).toBe('connector_candidates_table');
  });

  test('v93 migration SQL creates the connector_candidates table', () => {
    const v93 = MIGRATIONS.find(m => m.version === 93);
    expect(v93?.sql).toContain('CREATE TABLE IF NOT EXISTS connector_candidates');
  });

  test('v93 migration SQL creates the connector_candidates index', () => {
    const v93 = MIGRATIONS.find(m => m.version === 93);
    expect(v93?.sql).toContain('connector_candidates_source_status_proposed_idx');
  });

  test('v93 migration is marked idempotent', () => {
    const v93 = MIGRATIONS.find(m => m.version === 93);
    expect(v93?.idempotent).toBe(true);
  });

});
