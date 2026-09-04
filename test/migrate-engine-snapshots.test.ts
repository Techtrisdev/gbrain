import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { __testing } from '../src/commands/migrate-engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('migrate-engine durable rollback evidence', () => {
  let source: PGLiteEngine;
  let target: PGLiteEngine;

  beforeAll(async () => {
    source = new PGLiteEngine();
    target = new PGLiteEngine();
    await source.connect({});
    await target.connect({});
    await source.initSchema();
    await target.initSchema();
    await source.executeRaw("SET TIME ZONE 'America/New_York'");
    await target.executeRaw("SET TIME ZONE 'UTC'");
  });

  afterAll(async () => {
    await source.disconnect();
    await target.disconnect();
  });

  test('copies database-exact JSON and remains idempotent', async () => {
    await source.executeRaw(
      `INSERT INTO migration_page_snapshots
         (migration_id, source_id, slug, pre_state_hash, pre_frontmatter,
          pre_content_hash, post_content_hash, snapshot_format, applied_at)
       VALUES
         ('v0.13.1', 'source-a', 'projects/large', 'state-a',
          '{"rank":9007199254740993}'::jsonb, 'before', 'after',
          'database_exact', '2026-09-04T12:00:00Z')`,
    );

    expect(await __testing.copyMigrationPageSnapshots(source, target)).toBe(1);
    expect(await __testing.copyMigrationPageSnapshots(source, target)).toBe(1);
    expect(await target.executeRaw(
      `SELECT pre_frontmatter->>'rank' AS rank, pre_content_hash, post_content_hash,
              snapshot_format, applied_at::text AS applied_at
         FROM migration_page_snapshots`,
    )).toEqual([{
      rank: '9007199254740993',
      pre_content_hash: 'before',
      post_content_hash: 'after',
      snapshot_format: 'database_exact',
      applied_at: '2026-09-04 12:00:00+00',
    }]);
  });

  test('preserves page creation and update timestamps across engine migration', async () => {
    await source.putPage('projects/timestamped', {
      type: 'note',
      title: 'Timestamped page',
      compiled_truth: 'Preserve its era.',
      timeline: '',
      frontmatter: { owner: 'migration' },
    }, { sourceId: 'default' });
    await source.executeRaw(
      `UPDATE pages
          SET created_at = '2026-04-19T12:00:00Z',
              updated_at = '2026-04-20T12:00:00Z'
        WHERE source_id = 'default' AND slug = 'projects/timestamped'`,
    );
    const page = (await source.listPages({ sourceId: 'default', limit: 10 }))
      .find((candidate) => candidate.slug === 'projects/timestamped');
    expect(page).toBeDefined();

    await __testing.copyPageCore(target, page!);
    try {
      expect(await target.executeRaw(
        `SELECT created_at::text AS created_at, updated_at::text AS updated_at
           FROM pages
          WHERE source_id = 'default' AND slug = 'projects/timestamped'`,
      )).toEqual([{
        created_at: '2026-04-19 12:00:00+00',
        updated_at: '2026-04-20 12:00:00+00',
      }]);
    } finally {
      await target.executeRaw(
        `DELETE FROM pages WHERE source_id = 'default' AND slug = 'projects/timestamped'`,
      );
    }
  });

  test('rejects an existing target snapshot with conflicting evidence', async () => {
    await target.executeRaw(
      `UPDATE migration_page_snapshots SET pre_content_hash = 'conflict'
        WHERE migration_id = 'v0.13.1' AND source_id = 'source-a'
          AND slug = 'projects/large' AND pre_state_hash = 'state-a'`,
    );
    await expect(__testing.copyMigrationPageSnapshots(source, target))
      .rejects.toThrow('target has conflicting migration snapshot');
  });

  test('treats zero-page rollback evidence as data and clears it atomically', async () => {
    expect((await target.getStats()).page_count).toBe(0);
    expect(await __testing.countMigrationPageSnapshots(target)).toBe(1);
    await __testing.clearMigrationTarget(target);
    expect(await __testing.countMigrationPageSnapshots(target)).toBe(0);
  });
});
