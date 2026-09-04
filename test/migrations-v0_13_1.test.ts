/**
 * v0.13.1 migration tests — grandfather validate:false onto existing pages.
 *
 * Verifies:
 *   - Registry contains v0_13_1 in semver order
 *   - Orchestrator is idempotent (running twice is a no-op on the 2nd pass)
 *   - Pages with existing `validate` key are NOT modified
 *   - Rollback log lines are written pre-mutation
 *   - dryRun does not mutate anything
 *
 * Note: tests run the orchestrator via direct engine manipulation rather
 * than through the full migration-runner entry point. The runner is tested
 * in test/apply-migrations.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { tmpdir } from 'os';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';

import { migrations, getMigration } from '../src/commands/migrations/index.ts';
import { __testing, v0_13_1 } from '../src/commands/migrations/v0_13_1.ts';
import { gbrainPath } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { contentHash } from '../src/core/utils.ts';
import { withEnv } from './helpers/with-env.ts';

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
  test('dryRun skips the connect phase', async () => {
    const result = await v0_13_1.orchestrator({ yes: true, dryRun: true, noAutopilotInstall: true });
    const connectPhase = result.phases.find(p => p.name === 'connect');
    expect(connectPhase?.status).toBe('skipped');
    expect(connectPhase?.detail).toBe('dry-run');
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

        const rowsBefore = await engine.executeRaw<Record<string, unknown>>(
          `SELECT *
             FROM pages
            WHERE slug IN ('projects/same', 'projects/validated', 'projects/durable',
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
        expect(first.files_rewritten).toBe(5);
        expect(first.phases.find((phase) => phase.name === 'snapshot')?.detail).toBe('6 page references');
        expect(first.phases.find((phase) => phase.name === 'grandfather')?.detail)
          .toBe('touched=5 skipped=1 failed=0');
        expect(first.phases.find((phase) => phase.name === 'verify')).toMatchObject({
          status: 'complete',
          detail: 'eligible pages without validate key: 0',
        });

        const rowsAfterFirst = await engine.executeRaw<Record<string, unknown>>(
          `SELECT *
             FROM pages
            WHERE slug IN ('projects/same', 'projects/validated', 'projects/durable',
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

        const rollbackLines = readFileSync(gbrainPath('migrations', 'v0_13_1-rollback.jsonl'), 'utf-8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(rollbackLines.every(({ migration }) => migration === 'v0.13.1')).toBe(true);
        expect(rollbackLines.map(({ source_id, slug, pre_frontmatter }) => ({
          source_id,
          slug,
          pre_frontmatter,
        }))).toEqual([
          {
            source_id: 'capture-events',
            slug: 'projects/durable',
            pre_frontmatter: durableCaptureSource.frontmatter,
          },
          {
            source_id: 'default',
            slug: 'projects/same',
            pre_frontmatter: defaultDuplicate.frontmatter,
          },
          {
            source_id: 'other-source',
            slug: 'capture/foreign',
            pre_frontmatter: foreignRawSlug.frontmatter,
          },
          {
            source_id: 'source-a',
            slug: 'projects/same',
            pre_frontmatter: sourceA.frontmatter,
          },
          {
            source_id: 'source-b',
            slug: 'projects/same',
            pre_frontmatter: sourceB.frontmatter,
          },
        ]);

        const second = await __testing.migrateConnectedEngine(
          engine,
          { yes: true, dryRun: false, noAutopilotInstall: true },
        );
        expect(second.files_rewritten).toBe(0);
        expect(second.phases.find((phase) => phase.name === 'grandfather')?.detail)
          .toBe('touched=0 skipped=6 failed=0');
        const rowsAfterSecond = await engine.executeRaw(
          `SELECT *
             FROM pages
            WHERE slug IN ('projects/same', 'projects/validated', 'projects/durable',
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
          status: 'failed',
          detail: 'eligible pages without validate key: 1',
        });
      });
    } finally {
      rmSync(migrationHome, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('v0_13_1 legacy schema compatibility', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
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
