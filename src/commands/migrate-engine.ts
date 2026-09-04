/**
 * Engine migration: transfer brain data between PGLite and Postgres.
 *
 * Usage:
 *   gbrain migrate --to supabase [--url <connection_string>]
 *   gbrain migrate --to pglite [--path <db_path>]
 *   gbrain migrate --to <engine> --force  (overwrite non-empty target)
 */

import { createEngine } from '../core/engine-factory.ts';
import { loadConfig, saveConfig, toEngineConfig, gbrainPath, type GBrainConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import type { EngineConfig, Page } from '../core/types.ts';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { createProgress } from '../core/progress.ts';
import { getCliOptions, cliOptsToProgressOptions } from '../core/cli-options.ts';

interface MigrateOpts {
  targetEngine: 'postgres' | 'pglite';
  targetUrl?: string;
  targetPath?: string;
  force: boolean;
}

function parseArgs(args: string[]): MigrateOpts {
  const toIdx = args.indexOf('--to');
  if (toIdx === -1 || !args[toIdx + 1]) {
    throw new Error('Usage: gbrain migrate --to <supabase|pglite> [--url <url>] [--path <path>] [--force]');
  }

  const targetRaw = args[toIdx + 1];
  const targetEngine = targetRaw === 'supabase' ? 'postgres' : targetRaw as 'postgres' | 'pglite';
  if (targetEngine !== 'postgres' && targetEngine !== 'pglite') {
    throw new Error(`Unknown target engine: "${targetRaw}". Use: supabase or pglite`);
  }

  const urlIdx = args.indexOf('--url');
  const pathIdx = args.indexOf('--path');

  return {
    targetEngine,
    targetUrl: urlIdx !== -1 ? args[urlIdx + 1] : undefined,
    targetPath: pathIdx !== -1 ? args[pathIdx + 1] : undefined,
    force: args.includes('--force'),
  };
}

function getManifestPath(): string {
  return gbrainPath('migrate-manifest.json');
}

interface MigrateManifest {
  completed_slugs: string[];
  target_engine: string;
  started_at: string;
}

interface MigrationPageSnapshotRow {
  migration_id: string;
  source_id: string;
  slug: string;
  pre_state_hash: string;
  pre_frontmatter_text: string;
  pre_content_hash: string | null;
  post_content_hash: string | null;
  snapshot_format: string;
  applied_at_utc: string;
}

async function hasMigrationSnapshotTable(engine: BrainEngine): Promise<boolean> {
  const rows = await engine.executeRaw<{ present: number }>(
    `SELECT 1 AS present FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'migration_page_snapshots'`,
  );
  return rows.length === 1;
}

async function countMigrationPageSnapshots(engine: BrainEngine): Promise<number> {
  if (!await hasMigrationSnapshotTable(engine)) return 0;
  const rows = await engine.executeRaw<{ count: number | string }>(
    'SELECT COUNT(*) AS count FROM migration_page_snapshots',
  );
  return Number(rows[0]?.count ?? 0);
}

async function clearMigrationTarget(engine: BrainEngine): Promise<void> {
  await engine.transaction(async (tx) => {
    await tx.executeRaw('DELETE FROM pages');
    await tx.executeRaw('DELETE FROM migration_page_snapshots');
  });
}

/** Copy rollback evidence exactly; never round-trip JSONB through JavaScript. */
async function copyMigrationPageSnapshots(source: BrainEngine, target: BrainEngine): Promise<number> {
  if (!await hasMigrationSnapshotTable(source)) return 0;
  if (!await hasMigrationSnapshotTable(target)) {
    throw new Error('target schema is missing migration_page_snapshots');
  }
  const rows = await source.executeRaw<MigrationPageSnapshotRow>(
    `SELECT migration_id, source_id, slug, pre_state_hash,
            pre_frontmatter::text AS pre_frontmatter_text,
            pre_content_hash, post_content_hash, snapshot_format,
            (applied_at AT TIME ZONE 'UTC')::text AS applied_at_utc
       FROM migration_page_snapshots
      ORDER BY migration_id, source_id, slug, pre_state_hash`,
  );
  for (const row of rows) {
    const inserted = await target.executeRaw<{ migration_id: string }>(
      `INSERT INTO migration_page_snapshots
         (migration_id, source_id, slug, pre_state_hash, pre_frontmatter,
          pre_content_hash, post_content_hash, snapshot_format, applied_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamp AT TIME ZONE 'UTC')
       ON CONFLICT (migration_id, source_id, slug, pre_state_hash) DO NOTHING
       RETURNING migration_id`,
      [
        row.migration_id, row.source_id, row.slug, row.pre_state_hash,
        row.pre_frontmatter_text, row.pre_content_hash, row.post_content_hash,
        row.snapshot_format, row.applied_at_utc,
      ],
    );
    if (inserted.length === 1) continue;
    const existing = await target.executeRaw<MigrationPageSnapshotRow>(
      `SELECT migration_id, source_id, slug, pre_state_hash,
              pre_frontmatter::text AS pre_frontmatter_text,
              pre_content_hash, post_content_hash, snapshot_format,
              (applied_at AT TIME ZONE 'UTC')::text AS applied_at_utc
         FROM migration_page_snapshots
        WHERE migration_id = $1 AND source_id = $2 AND slug = $3 AND pre_state_hash = $4`,
      [row.migration_id, row.source_id, row.slug, row.pre_state_hash],
    );
    if (JSON.stringify(existing[0]) !== JSON.stringify(row)) {
      throw new Error(
        `target has conflicting migration snapshot: ${row.migration_id}:${row.source_id}:${row.slug}:${row.pre_state_hash}`,
      );
    }
  }
  return rows.length;
}

function loadManifest(): MigrateManifest | null {
  const path = getManifestPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

function saveManifest(manifest: MigrateManifest): void {
  writeFileSync(getManifestPath(), JSON.stringify(manifest, null, 2));
}

function clearManifest(): void {
  const path = getManifestPath();
  if (existsSync(path)) unlinkSync(path);
}

/** Copy the page body and preserve the timestamps used by era-sensitive repairs. */
async function copyPageCore(target: BrainEngine, page: Page): Promise<void> {
  await target.putPage(page.slug, {
    type: page.type,
    title: page.title,
    compiled_truth: page.compiled_truth,
    timeline: page.timeline,
    frontmatter: page.frontmatter,
    content_hash: page.content_hash,
  }, { sourceId: page.source_id });
  const preserved = await target.executeRaw<{ id: string }>(
    `UPDATE pages
        SET created_at = $3::timestamptz,
            updated_at = $4::timestamptz
      WHERE source_id = $1 AND slug = $2
      RETURNING id`,
    [page.source_id, page.slug, page.created_at.toISOString(), page.updated_at.toISOString()],
  );
  if (preserved.length !== 1) {
    throw new Error(`failed to preserve page timestamps: ${page.source_id}:${page.slug}`);
  }
}

export async function runMigrateEngine(sourceEngine: BrainEngine, args: string[]): Promise<void> {
  const opts = parseArgs(args);
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Check source != target
  if (config.engine === opts.targetEngine) {
    console.error(`Already using ${opts.targetEngine} engine. Nothing to migrate.`);
    process.exit(1);
  }

  // Build target config
  const targetConfig: EngineConfig = { engine: opts.targetEngine };
  if (opts.targetEngine === 'postgres') {
    targetConfig.database_url = opts.targetUrl || process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
    if (!targetConfig.database_url) {
      console.error('Target is Supabase but no connection string provided. Use: --url <connection_string>');
      process.exit(1);
    }
  } else {
    targetConfig.database_path = opts.targetPath || gbrainPath('brain.pglite');
  }

  // Connect to target
  console.log(`Connecting to target (${opts.targetEngine})...`);
  const targetEngine = await createEngine(targetConfig);
  await targetEngine.connect(targetConfig);
  await targetEngine.initSchema();

  // Check if target has data
  const targetStats = await targetEngine.getStats();
  const targetSnapshotCount = await countMigrationPageSnapshots(targetEngine);
  const targetHasData = targetStats.page_count > 0 || targetSnapshotCount > 0;
  if (targetHasData && !opts.force) {
    console.error(
      `Target brain is not empty (${targetStats.page_count} pages, ${targetSnapshotCount} migration snapshots).`,
    );
    console.error('Run with --force to overwrite, or migrate to an empty brain.');
    await targetEngine.disconnect();
    process.exit(1);
  }

  if (targetHasData && opts.force) {
    console.log('--force: wiping target brain...');
    // v0.18.0+ multi-source: deletePage(slug) is now source-scoped (defaults
    // to 'default'), so per-page iteration would skip non-default-source
    // rows. migrate-engine --force is a destructive wipe across the entire
    // brain — all sources, all pages — so we issue a raw DELETE that matches
    // the original semantic. Cascades through content_chunks / page_links /
    // tags / timeline_entries / page_versions via existing FKs.
    await clearMigrationTarget(targetEngine);
  }

  // Load or create manifest for resume
  let manifest = loadManifest();
  if (manifest && manifest.target_engine !== opts.targetEngine) {
    console.log('Previous migration was to a different target. Starting fresh.');
    manifest = null;
  }
  // v0.32.8 F8: manifest keys are now `${source_id}::${slug}` so multi-source
  // migrations don't collide on same-slug-different-source pages. Pre-v0.32.8
  // entries were bare slugs; we keep treating those as default-source for
  // back-compat resume.
  const completedSet = new Set(manifest?.completed_slugs || []);
  const makeManifestKey = (sourceId: string, slug: string): string =>
    sourceId === 'default' ? slug : `${sourceId}::${slug}`;
  if (!manifest) {
    manifest = {
      completed_slugs: [],
      target_engine: opts.targetEngine,
      started_at: new Date().toISOString(),
    };
  }

  // Get all source pages
  const sourceStats = await sourceEngine.getStats();
  const allPages = await sourceEngine.listPages({ limit: 100000 });
  const pagesToMigrate = allPages.filter(p => !completedSet.has(makeManifestKey(p.source_id, p.slug)));

  console.log(`Migrating ${pagesToMigrate.length} pages (${allPages.length} total, ${completedSet.size} already done)...`);

  const progress = createProgress(cliOptsToProgressOptions(getCliOptions()));
  progress.start('migrate.copy_pages', pagesToMigrate.length);

  let migrated = 0;
  for (const page of pagesToMigrate) {
    // v0.32.8 F8: thread source_id end-to-end so multi-source pages migrate
    // intact. Pre-fix: putPage / getTags / getTimeline / getRawData / getLinks
    // all silently defaulted to source_id='default', so non-default-source
    // tags / timeline / raw / links were either dropped or attached to the
    // wrong row.
    const sourceOpts = { sourceId: page.source_id };

    // Copy the page without losing its original era or source identity.
    await copyPageCore(targetEngine, page);

    // Copy chunks with embeddings.
    const chunks = await sourceEngine.getChunksWithEmbeddings(page.slug, sourceOpts);
    if (chunks.length > 0) {
      await targetEngine.upsertChunks(page.slug, chunks.map(c => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        embedding: c.embedding || undefined,
        model: c.model,
        token_count: c.token_count || undefined,
      })), sourceOpts);
    }

    // Copy tags
    const tags = await sourceEngine.getTags(page.slug, sourceOpts);
    for (const tag of tags) {
      await targetEngine.addTag(page.slug, tag, sourceOpts);
    }

    // Copy timeline
    const timeline = await sourceEngine.getTimeline(page.slug, sourceOpts);
    for (const entry of timeline) {
      await targetEngine.addTimelineEntry(page.slug, {
        date: entry.date,
        source: entry.source,
        summary: entry.summary,
        detail: entry.detail,
      }, sourceOpts);
    }

    // Copy raw data
    const rawData = await sourceEngine.getRawData(page.slug, undefined, sourceOpts);
    for (const rd of rawData) {
      await targetEngine.putRawData(page.slug, rd.source, rd.data, sourceOpts);
    }

    // Copy versions
    const versions = await sourceEngine.getVersions(page.slug, sourceOpts);
    // Versions are snapshots, we recreate them on the target
    // (createVersion takes a snapshot of current state, which we just set)

    // Track progress with composite key so multi-source resume is correct.
    manifest!.completed_slugs.push(makeManifestKey(page.source_id, page.slug));
    saveManifest(manifest!);
    migrated++;
    progress.tick(1, page.slug);
  }
  progress.finish();

  const snapshotsCopied = await copyMigrationPageSnapshots(sourceEngine, targetEngine);
  if (snapshotsCopied > 0) {
    console.log(`Copied ${snapshotsCopied} durable migration rollback snapshot(s).`);
  }

  // Copy links (after all pages exist in target).
  // v0.32.8 F8: thread source_id so cross-source links migrate correctly.
  console.log('Copying links...');
  progress.start('migrate.copy_links', allPages.length);
  for (const page of allPages) {
    const sourceOpts = { sourceId: page.source_id };
    const links = await sourceEngine.getLinks(page.slug, sourceOpts);
    for (const link of links) {
      await targetEngine.addLink(
        link.from_slug, link.to_slug,
        link.context, link.link_type,
        undefined, undefined, undefined,
        { fromSourceId: page.source_id, toSourceId: page.source_id },
      );
    }
    progress.tick(1);
  }
  progress.finish();

  // Copy config (selective).
  //
  // v0.37 fix wave Lane C.4: these DB-plane writes are SCHEMA METADATA for
  // the target engine — they record "the schema was sized using this
  // embedding model + dimension." They are NOT the runtime gateway config
  // (which lives in the file plane via `~/.gbrain/config.json`). When this
  // function copies them, it's preserving the schema-applied state across
  // the migration, not re-pointing the gateway. The newConfig below
  // doesn't carry these fields because the user's existing file config
  // already has them (or didn't, in which case the file plane should stay
  // unset and re-read from gateway defaults).
  const configKeys = ['embedding_model', 'embedding_dimensions', 'chunk_strategy'];
  for (const key of configKeys) {
    const val = await sourceEngine.getConfig(key);
    if (val) await targetEngine.setConfig(key, val);
  }

  // Update local config. v0.37 fix wave: preserve existing file-plane
  // embedding/expansion/chat config across the engine migration; only
  // the engine + connection target should change.
  const existingFile = (await import('../core/config.ts')).loadConfigFileOnly() ?? ({} as GBrainConfig);
  const newConfig: GBrainConfig = {
    ...existingFile,
    engine: opts.targetEngine,
    ...(opts.targetEngine === 'postgres'
      ? { database_url: targetConfig.database_url, database_path: undefined }
      : { database_path: targetConfig.database_path, database_url: undefined }),
  };
  saveConfig(newConfig);

  // Clean up
  clearManifest();

  console.log(`\nMigration complete. ${migrated} pages transferred.`);
  console.log(`Config updated to engine: ${opts.targetEngine}`);
  if (config.engine === 'pglite' && config.database_path) {
    console.log(`Original PGLite brain preserved at ${config.database_path} (backup).`);
  }

  // Post-migrate verification: confirm the target is healthy before we
  // leave the user. Catches incomplete copies, schema drift, and missing
  // embeddings immediately instead of on next CLI use. Non-fatal — prints
  // warnings and keeps going so the user sees the full picture.
  console.log('\nVerifying target...');
  try {
    await verifyTarget(targetEngine, sourceStats.page_count);
  } catch (e) {
    console.warn(`  Verification could not complete: ${e instanceof Error ? e.message : String(e)}`);
  }

  await targetEngine.disconnect();
}

export const __testing = {
  copyMigrationPageSnapshots,
  countMigrationPageSnapshots,
  clearMigrationTarget,
  copyPageCore,
};

/**
 * Lightweight doctor-style verify run against the migrated target.
 * Prints a small table of signals; does not exit. Callers own engine
 * lifecycle.
 */
async function verifyTarget(engine: BrainEngine, expectedPages: number): Promise<void> {
  const stats = await engine.getStats();
  if (stats.page_count === expectedPages) {
    console.log(`  ok  pages: ${stats.page_count} (matches source)`);
  } else {
    console.warn(`  WARN pages: ${stats.page_count} (source had ${expectedPages})`);
  }

  try {
    const health = await engine.getHealth();
    const pct = (health.embed_coverage * 100).toFixed(0);
    if (health.embed_coverage >= 0.9) {
      console.log(`  ok  embeddings: ${pct}% coverage, ${health.missing_embeddings} missing`);
    } else {
      console.warn(`  WARN embeddings: ${pct}% coverage, ${health.missing_embeddings} missing. Run: gbrain embed --stale`);
    }
  } catch (e) {
    console.warn(`  WARN embeddings: could not measure (${e instanceof Error ? e.message : String(e)})`);
  }

  try {
    const version = await engine.getConfig('version');
    const { LATEST_VERSION } = await import('../core/migrate.ts');
    const schemaVersion = parseInt(version || '0', 10);
    if (schemaVersion >= LATEST_VERSION) {
      console.log(`  ok  schema: version ${schemaVersion}`);
    } else {
      console.warn(`  WARN schema: version ${schemaVersion} (latest: ${LATEST_VERSION}). Run: gbrain apply-migrations --yes`);
    }
  } catch {
    console.warn('  WARN schema: version could not be read');
  }

  console.log('  Full health check: gbrain doctor');
}
