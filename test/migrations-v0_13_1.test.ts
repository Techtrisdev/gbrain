/**
 * v0.13.1 migration tests — grandfather validate:false onto existing pages.
 *
 * Verifies:
 *   - Registry contains v0_13_1 in semver order
 *   - Orchestrator is idempotent (running twice is a no-op on the 2nd pass)
 *   - Pages with existing `validate` key are NOT modified
 *   - Durable source-qualified rollback snapshots preserve exact JSON values
 *   - dryRun does not mutate anything
 *
 * Note: tests run the orchestrator via direct engine manipulation rather
 * than through the full migration-runner entry point. The runner is tested
 * in test/apply-migrations.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

import { migrations, getMigration } from '../src/commands/migrations/index.ts';
import { __testing, v0_13_1, v0_40_9 } from '../src/commands/migrations/v0_13_1.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { contentHash } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

function exactDatabasePageHash(page: {
  title: string;
  type: string;
  compiled_truth: string;
  timeline: string;
  frontmatter_text: string;
}): string {
  let compactFrontmatter = '';
  let inString = false;
  let escaped = false;
  for (const char of page.frontmatter_text) {
    if (inString) {
      compactFrontmatter += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      compactFrontmatter += char;
    } else if (!/\s/.test(char)) {
      compactFrontmatter += char;
    }
  }
  const payload =
    `{"title":${JSON.stringify(page.title)},"type":${JSON.stringify(page.type)}` +
    `,"compiled_truth":${JSON.stringify(page.compiled_truth)}` +
    `,"timeline":${JSON.stringify(page.timeline || '')}` +
    `,"frontmatter":${compactFrontmatter}}`;
  return createHash('sha256').update(payload).digest('hex');
}

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('migrations registry', () => {
  test('v0.13.1 is registered', () => {
    const m = getMigration('0.13.1');
    expect(m).not.toBeNull();
    expect(m?.version).toBe('0.13.1');
  });

  test('v0.13.1 is listed in semver order after v0.12.0', () => {
    const versions = migrations.map(m => m.version);
    expect(versions.indexOf('0.13.1')).toBeGreaterThan(versions.indexOf('0.12.0'));
  });

  test('v0.13.1 feature pitch has headline + description', () => {
    expect(v0_13_1.featurePitch.headline.length).toBeGreaterThan(10);
    expect(v0_13_1.featurePitch.description?.length).toBeGreaterThan(20);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator behavior
// ---------------------------------------------------------------------------
//
// The orchestrator reads config via loadConfig() which reads from
// ~/.gbrain/config.json. We can't easily stand that up in a test, so the
// test below validates the pieces we CAN test without the config flow:
// registry integration + shape of the migration module. Full end-to-end
// with a real engine + config is in test/e2e/migration-flow.test.ts.
//
// Idempotency behavior is verified by unit testing the writer path
// (test/writer.test.ts: "validators skip pages with validate:false
// frontmatter") and the per-page frontmatter preservation logic in the
// setFrontmatterField test.

describe('v0_13_1 orchestrator — dry-run path', () => {
  let preparationEngine: PGLiteEngine;

  beforeAll(async () => {
    preparationEngine = new PGLiteEngine();
    await preparationEngine.connect({});
    await preparationEngine.initSchema();
  });

  afterAll(async () => {
    await preparationEngine.disconnect();
  });

  test('dryRun skips the connect phase', async () => {
    const result = await v0_13_1.orchestrator({ yes: true, dryRun: true, noAutopilotInstall: true });
    const connectPhase = result.phases.find(p => p.name === 'connect');
    expect(connectPhase?.status).toBe('skipped');
    expect(connectPhase?.detail).toBe('dry-run');
  });

  test('prepares a v115 engine through the current schema before page repair', async () => {
    await preparationEngine.executeRaw('DROP TABLE migration_page_snapshots');
    await preparationEngine.setConfig('version', '115');
    await __testing.prepareConnectedEngine(preparationEngine);
    expect(await preparationEngine.executeRaw(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'migration_page_snapshots'`,
    )).toEqual([{ table_name: 'migration_page_snapshots' }]);
    expect(await preparationEngine.getConfig('version')).toBe(String(LATEST_VERSION));
  }, 60_000);

  test('v0.40.9 repair is registered after prior orchestrators', () => {
    const versions = migrations.map(m => m.version);
    expect(getMigration('0.40.9')).toBe(v0_40_9);
    expect(versions.indexOf('0.40.9')).toBeGreaterThan(versions.indexOf('0.32.2'));
  });
});

describe('v0_13_1 orchestrator multi-source identity', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('updates only exact eligible rows without collapsing source-owned state', async () => {
    const migrationHome = mkdtempSync(join(tmpdir(), 'v0_13_1-multi-source-'));

    try {
      await withEnv({ GBRAIN_HOME: migrationHome }, async () => {
        for (const sourceId of ['source-a', 'source-b', 'capture-events', 'other-source']) {
          await engine.executeRaw(
            `INSERT INTO sources (id, name)
             VALUES ($1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [sourceId, sourceId],
          );
        }

        const sourceA = {
          type: 'note',
          page_kind: 'code' as const,
          title: 'Source A title',
          compiled_truth: 'Source A content.',
          timeline: 'Source A timeline.',
          frontmatter: { owner: 'source-a', rank: 1 },
        };
        const sourceB = {
          type: 'note',
          page_kind: 'image' as const,
          title: 'Source B title',
          compiled_truth: 'Source B content.',
          timeline: 'Source B timeline.',
          frontmatter: { owner: 'source-b', rank: 2 },
        };
        const defaultDuplicate = {
          type: 'note',
          title: 'Default duplicate title',
          compiled_truth: 'Default duplicate content.',
          timeline: '',
          frontmatter: { owner: 'default' },
        };
        const durableCaptureSource = {
          type: 'note',
          title: 'Durable capture-events page',
          compiled_truth: 'Durable content.',
          timeline: '',
          frontmatter: { owner: 'capture-events-durable' },
        };
        const foreignRawSlug = {
          type: 'note',
          title: 'Foreign raw-shaped page',
          compiled_truth: 'Foreign content.',
          timeline: '',
          frontmatter: { owner: 'other-source' },
        };
        const rawCapture = {
          type: 'note',
          title: 'Raw capture evidence',
          compiled_truth: 'Raw evidence.',
          timeline: '',
          frontmatter: { owner: 'raw-capture' },
        };
        const deleted = {
          type: 'note',
          title: 'Soft deleted page',
          compiled_truth: 'Deleted content.',
          timeline: '',
          frontmatter: { owner: 'deleted' },
        };

        await engine.putPage('projects/same', sourceA, { sourceId: 'source-a' });
        await engine.putPage('projects/same', sourceB, { sourceId: 'source-b' });
        await engine.putPage('projects/same', defaultDuplicate, { sourceId: 'default' });
        await engine.putPage('projects/validated', {
          type: 'note',
          title: 'Explicit validation',
          compiled_truth: 'Already decided.',
          timeline: '',
          frontmatter: { owner: 'explicit', validate: true },
        }, { sourceId: 'source-a' });
        await engine.putPage('projects/durable', durableCaptureSource, { sourceId: 'capture-events' });
        await engine.putPage('capture/foreign', foreignRawSlug, { sourceId: 'other-source' });
        await engine.putPage('capture/raw', rawCapture, { sourceId: 'capture-events' });
        await engine.putPage('projects/deleted', deleted, { sourceId: 'source-a' });
        await engine.executeRaw(
          `UPDATE pages SET deleted_at = now()
            WHERE source_id = $1 AND slug = $2`,
          ['source-a', 'projects/deleted'],
        );
        await engine.executeRaw(
          `INSERT INTO pages
             (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
           VALUES
             ('source-a', 'projects/large-number', 'note', 'Large numeric metadata',
              'Preserve the exact database JSON value.', '',
              '{"owner":"large","rank":9007199254740993}'::jsonb,
              'legacy-large-number')`,
        );
        await engine.executeRaw(
          `UPDATE pages SET created_at = '2026-04-20T00:00:00Z'::timestamptz`,
        );

        const rowsBefore = await engine.executeRaw<Record<string, unknown>>(
          `SELECT *, frontmatter::text AS frontmatter_text
             FROM pages
            WHERE slug IN ('projects/same', 'projects/validated', 'projects/durable',
                           'projects/large-number',
                           'projects/deleted', 'capture/foreign', 'capture/raw')
            ORDER BY source_id, slug`,
        );
        const beforeByIdentity = new Map(
          rowsBefore.map((row) => [`${row.source_id}:${row.slug}`, row]),
        );

        const first = await __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
        );
        expect(first.status).toBe('complete');
        expect(first.files_rewritten).toBe(6);
        expect(first.phases.find((phase) => phase.name === 'snapshot')?.detail).toBe('6 page references');
        expect(first.phases.find((phase) => phase.name === 'grandfather')?.detail)
          .toBe('touched=6 skipped=0 failed=0');
        expect(first.phases.find((phase) => phase.name === 'verify')).toMatchObject({
          status: 'complete',
          detail: 'eligible pages without validate key: 0',
        });

        const rowsAfterFirst = await engine.executeRaw<Record<string, unknown>>(
          `SELECT *, frontmatter::text AS frontmatter_text
             FROM pages
            WHERE slug IN ('projects/same', 'projects/validated', 'projects/durable',
                           'projects/large-number',
                           'projects/deleted', 'capture/foreign', 'capture/raw')
            ORDER BY source_id, slug`,
        );
        const byIdentity = new Map(rowsAfterFirst.map((row) => [`${row.source_id}:${row.slug}`, row]));
        const migratedA = byIdentity.get('source-a:projects/same')!;
        const migratedB = byIdentity.get('source-b:projects/same')!;
        const beforeA = beforeByIdentity.get('source-a:projects/same')!;
        const beforeB = beforeByIdentity.get('source-b:projects/same')!;

        expect(migratedA).toMatchObject({
          title: sourceA.title,
          compiled_truth: sourceA.compiled_truth,
          page_kind: 'code',
          frontmatter: { owner: 'source-a', rank: 1, validate: false },
        });
        expect(migratedB).toMatchObject({
          title: sourceB.title,
          compiled_truth: sourceB.compiled_truth,
          page_kind: 'image',
          frontmatter: { owner: 'source-b', rank: 2, validate: false },
        });
        expect(migratedA.content_hash).toBe(contentHash({
          type: String(beforeA.type),
          title: String(beforeA.title),
          compiled_truth: String(beforeA.compiled_truth),
          timeline: String(beforeA.timeline),
          frontmatter: {
            ...(beforeA.frontmatter as Record<string, unknown>),
            validate: false,
          },
        }));
        expect(migratedB.content_hash).toBe(contentHash({
          type: String(beforeB.type),
          title: String(beforeB.title),
          compiled_truth: String(beforeB.compiled_truth),
          timeline: String(beforeB.timeline),
          frontmatter: {
            ...(beforeB.frontmatter as Record<string, unknown>),
            validate: false,
          },
        }));

        const withoutIntendedUpdateColumns = (row: Record<string, unknown>) => {
          const {
            frontmatter: _frontmatter,
            content_hash: _contentHash,
            updated_at: _updatedAt,
            generation: _generation,
            frontmatter_text: _frontmatterText,
            ...untouched
          } = row;
          return untouched;
        };
        for (const row of rowsAfterFirst) {
          const before = beforeByIdentity.get(`${row.source_id}:${row.slug}`)!;
          expect(withoutIntendedUpdateColumns(row)).toEqual(withoutIntendedUpdateColumns(before));
        }

        expect(byIdentity.get('default:projects/same')).toMatchObject({
          title: defaultDuplicate.title,
          compiled_truth: defaultDuplicate.compiled_truth,
          frontmatter: { owner: 'default', validate: false },
        });
        expect(byIdentity.get('capture-events:projects/durable')?.frontmatter)
          .toEqual({ owner: 'capture-events-durable', validate: false });
        expect(byIdentity.get('other-source:capture/foreign')?.frontmatter)
          .toEqual({ owner: 'other-source', validate: false });

        const rawRow = byIdentity.get('capture-events:capture/raw')!;
        expect(rawRow.frontmatter).toEqual(rawCapture.frontmatter);
        expect(rawRow.content_hash).toBe(contentHash(rawCapture));
        expect(rawRow.deleted_at).toBeNull();
        const deletedRow = byIdentity.get('source-a:projects/deleted')!;
        expect(deletedRow.frontmatter).toEqual(deleted.frontmatter);
        expect(deletedRow.content_hash).toBe(contentHash(deleted));
        expect(deletedRow.deleted_at).not.toBeNull();

        const rollbackRows = await engine.executeRaw<{
          migration_id: string;
          source_id: string;
          slug: string;
          pre_frontmatter: Record<string, unknown>;
          pre_frontmatter_text: string;
          pre_content_hash: string | null;
          post_content_hash: string | null;
          snapshot_format: string;
        }>(
          `SELECT migration_id, source_id, slug,
                  pre_frontmatter, pre_frontmatter::text AS pre_frontmatter_text,
                  pre_content_hash, post_content_hash, snapshot_format
             FROM migration_page_snapshots
            WHERE migration_id = 'v0.13.1'
            ORDER BY source_id, slug`,
        );
        expect(rollbackRows.every(({ migration_id }) => migration_id === 'v0.13.1')).toBe(true);
        for (const snapshot of rollbackRows) {
          const before = beforeByIdentity.get(`${snapshot.source_id}:${snapshot.slug}`)!;
          expect(snapshot.pre_content_hash).toBe(before.content_hash as string | null);
          expect(snapshot.pre_frontmatter_text).toBe(before.frontmatter_text as string);
          expect(snapshot.snapshot_format).toBe('database_exact');
          expect(snapshot.post_content_hash).toBe(
            byIdentity.get(`${snapshot.source_id}:${snapshot.slug}`)!.content_hash as string,
          );
        }
        expect(rollbackRows.map(({ source_id, slug }) => `${source_id}:${slug}`)).toEqual([
          'capture-events:projects/durable',
          'default:projects/same',
          'other-source:capture/foreign',
          'source-a:projects/large-number',
          'source-a:projects/same',
          'source-b:projects/same',
        ]);
        const exactLargeNumber = await engine.executeRaw<{ rank: string }>(
          `SELECT pre_frontmatter->>'rank' AS rank
             FROM migration_page_snapshots
            WHERE migration_id = 'v0.13.1'
              AND source_id = 'source-a'
              AND slug = 'projects/large-number'`,
        );
        expect(exactLargeNumber).toEqual([{ rank: '9007199254740993' }]);
        const migratedLargeNumber = await engine.executeRaw<{
          rank: string;
          validate: string;
          frontmatter_text: string;
          content_hash: string;
        }>(
          `SELECT frontmatter->>'rank' AS rank,
                  frontmatter->>'validate' AS validate,
                  frontmatter::text AS frontmatter_text,
                  content_hash
             FROM pages
            WHERE source_id = 'source-a'
              AND slug = 'projects/large-number'`,
        );
        expect(migratedLargeNumber[0]).toMatchObject({ rank: '9007199254740993', validate: 'false' });
        const exactHash = exactDatabasePageHash({
          title: 'Large numeric metadata',
          type: 'note',
          compiled_truth: 'Preserve the exact database JSON value.',
          timeline: '',
          frontmatter_text: migratedLargeNumber[0]!.frontmatter_text,
        });
        expect(migratedLargeNumber[0]!.content_hash).toBe(exactHash);
        expect(migratedLargeNumber[0]!.content_hash).not.toBe(contentHash({
          type: 'note',
          title: 'Large numeric metadata',
          compiled_truth: 'Preserve the exact database JSON value.',
          timeline: '',
          frontmatter: { owner: 'large', rank: 9007199254740993, validate: false },
        }));

        await engine.putPage('projects/over-grandfathered', {
          type: 'note',
          title: 'Post-rollout page',
          compiled_truth: 'Validation was disabled by the old migration.',
          timeline: '',
          frontmatter: { owner: 'post-rollout', validate: false },
        }, { sourceId: 'source-b' });
        await engine.putPage('projects/original-ledger-format', {
          type: 'note',
          title: 'Original ledger format',
          compiled_truth: 'This proves source-less v0.13.0 evidence restores default.',
          timeline: '',
          frontmatter: { owner: 'original-format', validate: false },
        }, { sourceId: 'default' });
        await engine.executeRaw(
          `UPDATE pages SET created_at = '2026-09-04T23:00:00Z'::timestamptz
            WHERE (source_id = 'source-b' AND slug = 'projects/over-grandfathered')
               OR (source_id = 'default' AND slug = 'projects/original-ledger-format')`,
        );

        mkdirSync(join(migrationHome, '.gbrain', 'migrations'), { recursive: true });
        const legacyLedgerEntries = [
          {
            migration: 'v0.13.1',
            source_id: 'legacy-source',
            slug: 'projects/already-migrated',
            timestamp: '2026-09-05T00:00:00Z',
            pre_frontmatter: { owner: 'legacy' },
          },
          {
            migration: 'v0.13.1',
            source_id: 'source-b',
            slug: 'projects/over-grandfathered',
            timestamp: '2026-09-05T00:00:00Z',
            pre_frontmatter: { owner: 'stale-duplicate' },
          },
          {
            migration: 'v0.13.1',
            source_id: 'source-b',
            slug: 'projects/over-grandfathered',
            timestamp: '2026-09-05T00:00:00Z',
            pre_frontmatter: { owner: 'post-rollout' },
          },
          {
            migration: 'v0.13.0',
            slug: 'projects/original-ledger-format',
            timestamp: '2026-09-05T00:00:00Z',
            pre_frontmatter: { owner: 'original-format' },
          },
        ];
        writeFileSync(
          join(migrationHome, '.gbrain', 'migrations', 'v0_13_1-rollback.jsonl'),
          legacyLedgerEntries.map((entry) => JSON.stringify(entry)).join('\n') + '\n',
          'utf8',
        );

        const second = await __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
          '0.40.9',
        );
        expect(second.version).toBe('0.40.9');
        expect(second.files_rewritten).toBe(2);
        expect(second.phases.find((phase) => phase.name === 'snapshot')?.detail)
          .toBe('0 page references');
        expect(second.phases.find((phase) => phase.name === 'grandfather')?.detail)
          .toBe('touched=0 skipped=0 failed=0');
        expect(second.phases.find((phase) => phase.name === 'legacy-rollback-import')?.detail)
          .toBe('imported=4 already_present=0');
        expect(second.phases.find((phase) => phase.name === 'over-grandfather-restore')?.detail)
          .toBe('restored=2 skipped=1 failed=0');
        expect(await engine.executeRaw(
          `SELECT source_id, slug, frontmatter
             FROM pages
            WHERE slug IN ('projects/over-grandfathered', 'projects/original-ledger-format')
            ORDER BY source_id, slug`,
        )).toEqual([
          {
            source_id: 'default',
            slug: 'projects/original-ledger-format',
            frontmatter: { owner: 'original-format' },
          },
          {
            source_id: 'source-b',
            slug: 'projects/over-grandfathered',
            frontmatter: { owner: 'post-rollout' },
          },
        ]);
        expect(await engine.executeRaw(
          `SELECT snapshot_format, pre_content_hash, pre_frontmatter
             FROM migration_page_snapshots
            WHERE migration_id = 'v0.13.1'
              AND source_id = 'legacy-source'
              AND slug = 'projects/already-migrated'`,
        )).toEqual([{
          snapshot_format: 'legacy_jsonl',
          pre_content_hash: null,
          pre_frontmatter: { owner: 'legacy' },
        }]);
        const rowsAfterSecond = await engine.executeRaw(
          `SELECT *, frontmatter::text AS frontmatter_text
             FROM pages
            WHERE slug IN ('projects/same', 'projects/validated', 'projects/durable',
                           'projects/large-number',
                           'projects/deleted', 'capture/foreign', 'capture/raw')
            ORDER BY source_id, slug`,
        );
        expect(rowsAfterSecond).toEqual(rowsAfterFirst);

        await engine.putPage('projects/unmigrated', {
          type: 'note',
          title: 'Late eligible page',
          compiled_truth: 'This row proves verification is not a global lower bound.',
          timeline: '',
          frontmatter: { owner: 'late' },
        }, { sourceId: 'source-b' });
        expect(await __testing.verifyEligiblePopulation(engine)).toMatchObject({
          status: 'complete',
          detail: 'eligible pages without validate key: 0',
        });
        expect(await engine.executeRaw(
          `SELECT frontmatter FROM pages
            WHERE source_id = 'source-b' AND slug = 'projects/unmigrated'`,
        )).toEqual([{ frontmatter: { owner: 'late' } }]);
        await engine.executeRaw(
          `UPDATE pages SET created_at = '2026-04-20T00:00:00Z'::timestamptz
            WHERE source_id = 'source-b' AND slug = 'projects/unmigrated'`,
        );
        expect(await __testing.verifyEligiblePopulation(engine)).toMatchObject({
          status: 'failed',
          detail: 'eligible pages without validate key: 1',
        });
        await engine.executeRaw(
          `DELETE FROM pages WHERE source_id = 'source-b' AND slug = 'projects/unmigrated'`,
        );
      });
    } finally {
      rmSync(migrationHome, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('v0_13_1 compare-and-set and snapshot history', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('migration-race', 'migration-race') ON CONFLICT DO NOTHING`,
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('concurrent page change fails explicitly and leaves no orphan snapshot', async () => {
    await engine.putPage('projects/race', {
      type: 'note', title: 'Race', compiled_truth: 'Before.', timeline: '',
      frontmatter: { owner: 'before' },
    }, { sourceId: 'migration-race' });
    await engine.executeRaw(
      `UPDATE pages SET created_at = '2026-04-20T00:00:00Z'::timestamptz
        WHERE source_id = 'migration-race' AND slug = 'projects/race'`,
    );
    const originalExecuteRaw = engine.executeRaw.bind(engine);
    let injected = false;
    engine.executeRaw = (async <T>(sql: string, params?: unknown[]): Promise<T[]> => {
      if (!injected && sql.includes('WITH target AS') && params?.[2] === 'projects/race') {
        injected = true;
        await originalExecuteRaw(
          `UPDATE pages
              SET frontmatter = '{"owner":"concurrent"}'::jsonb,
                  content_hash = 'concurrent-change'
            WHERE source_id = 'migration-race' AND slug = 'projects/race'`,
        );
      }
      return originalExecuteRaw<T>(sql, params);
    }) as typeof engine.executeRaw;

    const migrationHome = mkdtempSync(join(tmpdir(), 'v0_13_1-cas-'));
    try {
      const result = await withEnv({ GBRAIN_HOME: migrationHome }, () =>
        __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
        ));
      expect(result.status).toBe('failed');
      const detail = result.phases.find((phase) => phase.name === 'grandfather')?.detail ?? '';
      expect(detail).toContain('touched=0 skipped=0 failed=1');
      expect(detail).toContain('compare-and-set rejected the update');
      expect(detail).not.toContain('division by zero');
      expect(await originalExecuteRaw(
        `SELECT COUNT(*)::int AS count FROM migration_page_snapshots
          WHERE migration_id = 'v0.13.1'
            AND source_id = 'migration-race'
            AND slug = 'projects/race'`,
      )).toEqual([{ count: 0 }]);
      expect(await originalExecuteRaw(
        `SELECT frontmatter FROM pages
          WHERE source_id = 'migration-race' AND slug = 'projects/race'`,
      )).toEqual([{ frontmatter: { owner: 'concurrent' } }]);
    } finally {
      engine.executeRaw = originalExecuteRaw as typeof engine.executeRaw;
      await originalExecuteRaw(
        `DELETE FROM pages WHERE source_id = 'migration-race' AND slug = 'projects/race'`,
      );
      rmSync(migrationHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('logical and stored-hash pre-states get distinct rollback snapshots', async () => {
    await engine.putPage('projects/replayed', {
      type: 'note', title: 'Replay', compiled_truth: 'Stable body.', timeline: '',
      frontmatter: { owner: 'state-a' },
    }, { sourceId: 'migration-race' });
    await engine.executeRaw(
      `UPDATE pages SET created_at = '2026-04-20T00:00:00Z'::timestamptz
        WHERE source_id = 'migration-race' AND slug = 'projects/replayed'`,
    );
    const migrationHome = mkdtempSync(join(tmpdir(), 'v0_13_1-replay-'));
    try {
      const first = await withEnv({ GBRAIN_HOME: migrationHome }, () =>
        __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
        ));
      expect(first.status).toBe('complete');

      await engine.executeRaw(
        `UPDATE pages
            SET frontmatter = '{"owner":"state-b"}'::jsonb,
                content_hash = 'state-b'
          WHERE source_id = 'migration-race' AND slug = 'projects/replayed'`,
      );
      const second = await withEnv({ GBRAIN_HOME: migrationHome }, () =>
        __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
        ));
      expect(second.status).toBe('complete');
      await engine.executeRaw(
        `UPDATE pages
            SET frontmatter = '{"owner":"state-b"}'::jsonb,
                content_hash = 'state-c'
          WHERE source_id = 'migration-race' AND slug = 'projects/replayed'`,
      );
      const third = await withEnv({ GBRAIN_HOME: migrationHome }, () =>
        __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
        ));
      expect(third.status).toBe('complete');
      const snapshots = await engine.executeRaw<{
        owner: string;
        pre_state_hash: string;
        snapshot_format: string;
      }>(
        `SELECT pre_frontmatter->>'owner' AS owner, pre_state_hash, snapshot_format
           FROM migration_page_snapshots
          WHERE migration_id = 'v0.13.1'
            AND source_id = 'migration-race'
            AND slug = 'projects/replayed'
          ORDER BY applied_at, pre_state_hash`,
      );
      expect(snapshots.map(({ owner }) => owner).sort()).toEqual(['state-a', 'state-b', 'state-b']);
      expect(new Set(snapshots.map(({ pre_state_hash }) => pre_state_hash)).size).toBe(3);
      expect(snapshots.every(({ snapshot_format }) => snapshot_format === 'database_exact')).toBe(true);
    } finally {
      await engine.executeRaw(
        `DELETE FROM pages WHERE source_id = 'migration-race' AND slug = 'projects/replayed'`,
      );
      rmSync(migrationHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('does not restore a post-rollout exemption when ledger frontmatter is stale', async () => {
    await engine.putPage('projects/restore-conflict', {
      type: 'note', title: 'Restore conflict', compiled_truth: 'Keep current state.', timeline: '',
      frontmatter: { owner: 'current', validate: false },
    }, { sourceId: 'migration-race' });
    const migrationHome = mkdtempSync(join(tmpdir(), 'v0_13_1-restore-conflict-'));
    try {
      mkdirSync(join(migrationHome, '.gbrain', 'migrations'), { recursive: true });
      writeFileSync(
        join(migrationHome, '.gbrain', 'migrations', 'v0_13_1-rollback.jsonl'),
        JSON.stringify({
          migration: 'v0.13.1',
          source_id: 'migration-race',
          slug: 'projects/restore-conflict',
          timestamp: '2026-09-05T00:00:00Z',
          pre_frontmatter: { owner: 'stale-ledger' },
        }) + '\n',
        'utf8',
      );
      const result = await withEnv({ GBRAIN_HOME: migrationHome }, () =>
        __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
          '0.40.9',
        ));
      expect(result.status).toBe('failed');
      expect(result.phases.find((phase) => phase.name === 'over-grandfather-restore')?.detail)
        .toContain('no legacy ledger entry matches');
      expect(await engine.executeRaw(
        `SELECT frontmatter FROM pages
          WHERE source_id = 'migration-race' AND slug = 'projects/restore-conflict'`,
      )).toEqual([{ frontmatter: { owner: 'current', validate: false } }]);
    } finally {
      await engine.executeRaw(
        `DELETE FROM pages WHERE source_id = 'migration-race' AND slug = 'projects/restore-conflict'`,
      );
      rmSync(migrationHome, { recursive: true, force: true });
    }
  }, 60_000);

  test('does not restore a legacy page whose creation time was reset after the ledger entry', async () => {
    await engine.putPage('projects/migrated-legacy', {
      type: 'note', title: 'Migrated legacy page', compiled_truth: 'Keep its exemption.', timeline: '',
      frontmatter: { owner: 'legacy', validate: false },
    }, { sourceId: 'default' });
    const migrationHome = mkdtempSync(join(tmpdir(), 'v0_13_1-migrated-legacy-'));
    try {
      mkdirSync(join(migrationHome, '.gbrain', 'migrations'), { recursive: true });
      writeFileSync(
        join(migrationHome, '.gbrain', 'migrations', 'v0_13_1-rollback.jsonl'),
        JSON.stringify({
          migration: 'v0.13.0',
          timestamp: '2026-04-20T12:00:00Z',
          slug: 'projects/migrated-legacy',
          pre_frontmatter: { owner: 'legacy' },
        }) + '\n',
        'utf8',
      );
      const result = await withEnv({ GBRAIN_HOME: migrationHome }, () =>
        __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
          '0.40.9',
        ));
      expect(result.status).toBe('failed');
      expect(result.phases.find((phase) => phase.name === 'over-grandfather-restore')?.detail)
        .toContain('no legacy ledger entry matches');
      expect(await engine.executeRaw(
        `SELECT frontmatter FROM pages
          WHERE source_id = 'default' AND slug = 'projects/migrated-legacy'`,
      )).toEqual([{ frontmatter: { owner: 'legacy', validate: false } }]);
    } finally {
      await engine.executeRaw(
        `DELETE FROM pages WHERE source_id = 'default' AND slug = 'projects/migrated-legacy'`,
      );
      rmSync(migrationHome, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('v0_13_1 legacy schema compatibility', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('works before source_id and deleted_at exist, and with either column absent', async () => {
    const cases = [
      { hasSourceId: false, hasDeletedAt: false, expectedTouched: 1 },
      { hasSourceId: true, hasDeletedAt: false, expectedTouched: 2 },
      { hasSourceId: false, hasDeletedAt: true, expectedTouched: 1 },
    ];

    for (const schema of cases) {
      await engine.executeRaw('DROP TABLE IF EXISTS pages CASCADE');
      await engine.executeRaw(`
        CREATE TABLE pages (
          id SERIAL PRIMARY KEY,
          ${schema.hasSourceId ? "source_id TEXT NOT NULL DEFAULT 'default'," : ''}
          slug TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          compiled_truth TEXT NOT NULL DEFAULT '',
          timeline TEXT NOT NULL DEFAULT '',
          frontmatter JSONB NOT NULL DEFAULT '{}',
          content_hash TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
          ${schema.hasDeletedAt ? ', deleted_at TIMESTAMPTZ' : ''},
          UNIQUE (${schema.hasSourceId ? 'source_id, slug' : 'slug'})
        )
      `);

      if (schema.hasSourceId) {
        await engine.executeRaw(
          `INSERT INTO pages
             (source_id, slug, type, title, compiled_truth, timeline, frontmatter)
           VALUES
             ('capture-events', 'capture/raw', 'note', 'Raw', 'Raw body', '', '{"owner":"raw"}'::jsonb),
             ('capture-events', 'projects/durable', 'note', 'Durable', 'Durable body', '', '{"owner":"durable"}'::jsonb),
             ('other-source', 'capture/foreign', 'note', 'Foreign', 'Foreign body', '', '{"owner":"foreign"}'::jsonb)`,
        );
      } else {
        await engine.executeRaw(
          `INSERT INTO pages
             (slug, type, title, compiled_truth, timeline, frontmatter${schema.hasDeletedAt ? ', deleted_at' : ''})
           VALUES
             ('projects/active', 'note', 'Active', 'Active body', '', '{"owner":"active"}'::jsonb${schema.hasDeletedAt ? ', NULL' : ''})
             ${schema.hasDeletedAt
               ? ", ('projects/deleted', 'note', 'Deleted', 'Deleted body', '', '{\"owner\":\"deleted\"}'::jsonb, now())"
               : ''}`,
        );
      }
      await engine.executeRaw(
        `UPDATE pages SET created_at = '2026-04-20T00:00:00Z'::timestamptz`,
      );

      const migrationHome = mkdtempSync(join(tmpdir(), 'v0_13_1-legacy-'));
      try {
        await withEnv({ GBRAIN_HOME: migrationHome }, async () => {
          const result = await __testing.migrateConnectedEngine(
            engine,
            { yes: true, dryRun: false, noAutopilotInstall: true },
          );
          expect(result.status).toBe('complete');
          expect(result.files_rewritten).toBe(schema.expectedTouched);
          expect(result.phases.find((phase) => phase.name === 'verify')?.status).toBe('complete');
        });
      } finally {
        rmSync(migrationHome, { recursive: true, force: true });
      }

      const rows = await engine.executeRaw<{
        source_id: string;
        slug: string;
        frontmatter: Record<string, unknown>;
        deleted_at: Date | null;
      }>(
        `SELECT ${schema.hasSourceId ? 'source_id' : "'default' AS source_id"},
                slug, frontmatter,
                ${schema.hasDeletedAt ? 'deleted_at' : 'NULL AS deleted_at'}
           FROM pages
          ORDER BY source_id, slug`,
      );

      if (schema.hasSourceId) {
        expect(rows).toEqual([
          {
            source_id: 'capture-events',
            slug: 'capture/raw',
            frontmatter: { owner: 'raw' },
            deleted_at: null,
          },
          {
            source_id: 'capture-events',
            slug: 'projects/durable',
            frontmatter: { owner: 'durable', validate: false },
            deleted_at: null,
          },
          {
            source_id: 'other-source',
            slug: 'capture/foreign',
            frontmatter: { owner: 'foreign', validate: false },
            deleted_at: null,
          },
        ]);
      } else if (schema.hasDeletedAt) {
        expect(rows[0]).toMatchObject({
          slug: 'projects/active',
          frontmatter: { owner: 'active', validate: false },
          deleted_at: null,
        });
        expect(rows[1]?.slug).toBe('projects/deleted');
        expect(rows[1]?.frontmatter).toEqual({ owner: 'deleted' });
        expect(rows[1]?.deleted_at).not.toBeNull();
      } else {
        expect(rows).toEqual([{
          source_id: 'default',
          slug: 'projects/active',
          frontmatter: { owner: 'active', validate: false },
          deleted_at: null,
        }]);
      }
    }
  }, 60_000);
});
