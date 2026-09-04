/**
 * v0.13.1 migration — grandfather `validate: false` onto existing pages.
 *
 * The Knowledge Runtime BrainWriter ships pre-commit citation / link /
 * back-link / triple-HR validators. A fresh brain passes them trivially.
 * An existing brain with years of accumulated pages does NOT — legitimate
 * pages without strict citation formatting exist all over the place.
 *
 * This migration walks pages created before the v0.13.1 rollout and adds
 * `validate: false` to frontmatter where the field isn't already present.
 * Pages with that flag bypass the validators entirely, so strict-mode rollout
 * doesn't break existing content. `gbrain integrity --auto` clears the flag
 * per-page once it writes proper citations. Post-rollout pages are never
 * grandfathered by a later repair run.
 *
 * Idempotency: pages that already have `validate: false` or `validate: true`
 * are skipped. Running twice is a no-op on the second pass.
 *
 * Reversibility: every page touched is snapshotted in the durable
 * `migration_page_snapshots` table before its update. The snapshot and update
 * are one PostgreSQL statement, so either both commit or neither does. Roll
 * back by restoring the source-qualified snapshot and recomputing its content
 * hash (`gbrain apply-migrations --rollback v0.13.1` remains future CLI work).
 *
 * Work is traversed in chunks of 100 so the in-memory batch stays bounded.
 * The snapshot query selects only pre-rollout pages that actually need the
 * field, and each update uses an exact database-native compare-and-set guard.
 *
 * Snapshot-identity rule: reads every `(source_id, slug)` pair upfront before
 * iterating. Slug alone is not an identity in a multi-source brain. The old
 * slug-only walk read an arbitrary source row and wrote it to `default`, which
 * fabricated cross-source duplicates. Raw `capture-events/capture/*` evidence
 * is excluded because BrainWriter validation applies to durable markdown, not
 * the high-volume recovery corpus.
 *
 * Safety: does NOT call saveConfig. Prior learning [gbrain-init-default-pglite-flip]:
 * bare `gbrain init` defaults to PGLite and overwrites Postgres config.
 * This migration uses the standalone engine-factory flow with the existing
 * config; it never writes config.
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';

import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { gbrainPath, loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { BrainEngine } from '../../core/engine.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts).

const BATCH_SIZE = 100;
const MIGRATION_ID = 'v0.13.1';
const RESTORE_MIGRATION_ID = 'v0.40.9-over-grandfather-restore';
// v0.13.1 shipped on 2026-04-20. Only pages that predate that rollout are
// legacy content eligible for the validator exemption. A current-version
// repair must never exempt pages authored under the post-rollout contract.
const LEGACY_PAGE_CUTOFF = '2026-04-21T00:00:00.000Z';

interface PageRef {
  sourceId: string;
  slug: string;
}

interface PageSchema {
  hasSourceId: boolean;
  hasDeletedAt: boolean;
}

interface PageMigrationRow {
  id: number;
  type: string;
  title: string;
  compiled_truth: string;
  timeline: string;
  frontmatter: Record<string, unknown>;
  content_hash: string | null;
  frontmatter_text: string;
  next_frontmatter_text: string;
}

interface LegacyRollbackEntry {
  rawLine: string;
  sourceId: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Phase A — connect (no config write)
// ---------------------------------------------------------------------------

async function prepareConnectedEngine(engine: BrainEngine): Promise<void> {
  // Application-level migrations can run before the post-upgrade schema step.
  // Apply the numbered schema chain first so v116's protected snapshot table
  // exists on brains upgrading directly from an older release.
  await engine.initSchema();
}

async function phaseAConnect(opts: OrchestratorOpts): Promise<{ result: OrchestratorPhaseResult; engine: BrainEngine | null }> {
  if (opts.dryRun) {
    return { result: { name: 'connect', status: 'skipped', detail: 'dry-run' }, engine: null };
  }
  try {
    const config = loadConfig();
    if (!config) {
      return {
        result: { name: 'connect', status: 'skipped', detail: 'no brain configured (run gbrain init first)' },
        engine: null,
      };
    }
    const engine = await createEngine(toEngineConfig(config));
    await engine.connect(toEngineConfig(config));
    await prepareConnectedEngine(engine);
    return { result: { name: 'connect', status: 'complete' }, engine };
  } catch (e) {
    return {
      result: { name: 'connect', status: 'failed', detail: e instanceof Error ? e.message : String(e) },
      engine: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Phase B — snapshot slugs upfront
// ---------------------------------------------------------------------------

async function detectPageSchema(engine: BrainEngine): Promise<PageSchema> {
  const rows = await engine.executeRaw<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'pages'
        AND column_name IN ('source_id', 'deleted_at')`,
  );
  const columns = new Set(rows.map((row) => row.column_name));
  return {
    hasSourceId: columns.has('source_id'),
    hasDeletedAt: columns.has('deleted_at'),
  };
}

function activeNonRawPredicates(schema: PageSchema, alias = ''): string[] {
  const prefix = alias ? `${alias}.` : '';
  const predicates: string[] = [];
  if (schema.hasDeletedAt) predicates.push(`${prefix}deleted_at IS NULL`);
  if (schema.hasSourceId) {
    predicates.push(`NOT (${prefix}source_id = 'capture-events' AND ${prefix}slug LIKE 'capture/%')`);
  }
  return predicates;
}

function eligiblePredicates(schema: PageSchema, alias = ''): string[] {
  const prefix = alias ? `${alias}.` : '';
  return [
    ...activeNonRawPredicates(schema, alias),
    `${prefix}created_at < '${LEGACY_PAGE_CUTOFF}'::timestamptz`,
  ];
}

function postRolloutPredicates(schema: PageSchema, alias = ''): string[] {
  const prefix = alias ? `${alias}.` : '';
  return [
    ...activeNonRawPredicates(schema, alias),
    `${prefix}created_at >= '${LEGACY_PAGE_CUTOFF}'::timestamptz`,
  ];
}

async function phaseBSnapshot(engine: BrainEngine): Promise<{
  result: OrchestratorPhaseResult;
  refs: PageRef[];
  schema: PageSchema | null;
}> {
  try {
    const schema = await detectPageSchema(engine);
    const predicates = [...eligiblePredicates(schema), "NOT (frontmatter ? 'validate')"];
    const where = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT ${schema.hasSourceId ? 'source_id' : "'default' AS source_id"}, slug
         FROM pages
        ${where}
        ORDER BY source_id, slug`,
    );
    const refs = rows.map((row) => ({ sourceId: row.source_id, slug: row.slug }));
    return {
      result: { name: 'snapshot', status: 'complete', detail: `${refs.length} page references` },
      refs,
      schema,
    };
  } catch (e) {
    return {
      result: { name: 'snapshot', status: 'failed', detail: e instanceof Error ? e.message : String(e) },
      refs: [],
      schema: null,
    };
  }
}

async function requireDurableSnapshotTable(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<{ present: number }>(
    `SELECT 1 AS present
       FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name = 'migration_page_snapshots'`,
  );
  if (rows.length !== 1) {
    throw new Error('schema migration v116 must create migration_page_snapshots before v0.13.1 runs');
  }
}

/** Remove insignificant JSON whitespace without parsing numbers through JavaScript. */
function compactJsonTextLosslessly(raw: string): string {
  let compact = '';
  let inString = false;
  let escaped = false;
  for (const char of raw) {
    if (inString) {
      compact += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      compact += char;
    } else if (!/\s/.test(char)) {
      compact += char;
    }
  }
  return compact;
}

/** Match contentHash's field order while preserving database-native JSON numbers exactly. */
function contentHashFromDatabaseJson(page: PageMigrationRow, exactFrontmatterText: string): string {
  const exactPayload =
    `{"title":${JSON.stringify(page.title)}` +
    `,"type":${JSON.stringify(page.type)}` +
    `,"compiled_truth":${JSON.stringify(page.compiled_truth)}` +
    `,"timeline":${JSON.stringify(page.timeline || '')}` +
    `,"frontmatter":${compactJsonTextLosslessly(exactFrontmatterText)}}`;
  return createHash('sha256').update(exactPayload).digest('hex');
}

/** Snapshot identity includes both logical content and the stored hash state. */
function snapshotStateHash(page: PageMigrationRow, exactFrontmatterText: string): string {
  const logicalContentHash = contentHashFromDatabaseJson(page, exactFrontmatterText);
  const storedHashState = page.content_hash === null
    ? 'stored-content-hash:null'
    : `stored-content-hash:value:${page.content_hash}`;
  return createHash('sha256')
    .update(`${logicalContentHash}\0${storedHashState}`)
    .digest('hex');
}

// ---------------------------------------------------------------------------
// Phase C — grandfather: add validate:false where absent
// ---------------------------------------------------------------------------

interface GrandfatherResult {
  touched: number;
  skipped: number;
  failed: number;
  failures: string[];
}

async function applyGrandfatheredPage(
  engine: BrainEngine,
  ref: PageRef,
  page: PageMigrationRow,
  schema: PageSchema,
  preStateHash: string,
  nextContentHash: string,
): Promise<void> {
  const targetPredicates = [
    'p.id = $5',
    'p.slug = $3',
    'p.frontmatter::text = $6',
    'p.content_hash IS NOT DISTINCT FROM $7',
    'p.type = $8',
    'p.title = $9',
    'p.compiled_truth = $10',
    'p.timeline = $11',
    "NOT (p.frontmatter ? 'validate')",
  ];
  if (schema.hasSourceId) targetPredicates.push('p.source_id = $2');
  targetPredicates.push(...eligiblePredicates(schema, 'p'));

  const result = await engine.executeRaw<{ applied: number }>(
    `WITH target AS (
       SELECT p.id,
              $2::text AS snapshot_source_id,
              p.slug,
              p.frontmatter,
              p.content_hash
         FROM pages p
        WHERE ${targetPredicates.join(' AND ')}
        FOR UPDATE
     ),
     existing_snapshot AS (
       SELECT s.source_id, s.slug, s.pre_state_hash
         FROM migration_page_snapshots s
         JOIN target t
           ON s.source_id = t.snapshot_source_id
          AND s.slug = t.slug
        WHERE s.migration_id = $1
          AND s.pre_state_hash = $12
          AND s.pre_frontmatter = t.frontmatter
          AND s.pre_content_hash IS NOT DISTINCT FROM t.content_hash
     ),
     inserted_snapshot AS (
       INSERT INTO migration_page_snapshots
         (migration_id, source_id, slug, pre_state_hash, pre_frontmatter,
          pre_content_hash, post_content_hash, snapshot_format)
       SELECT $1, t.snapshot_source_id, t.slug, $12, t.frontmatter,
              t.content_hash, $4, 'database_exact'
         FROM target t
       ON CONFLICT (migration_id, source_id, slug, pre_state_hash) DO NOTHING
       RETURNING source_id, slug, pre_state_hash
     ),
     authorized AS (
       SELECT source_id, slug, pre_state_hash FROM existing_snapshot
       UNION ALL
       SELECT source_id, slug, pre_state_hash FROM inserted_snapshot
     ),
     updated AS (
       UPDATE pages p
          SET frontmatter = p.frontmatter || '{"validate": false}'::jsonb,
              content_hash = $4,
              updated_at = now()
         FROM target t
        WHERE p.id = t.id
          AND EXISTS (
            SELECT 1
              FROM authorized a
             WHERE a.source_id = t.snapshot_source_id
               AND a.slug = t.slug
               AND a.pre_state_hash = $12
          )
       RETURNING p.id
     )
     SELECT (SELECT COUNT(*)::int FROM updated) AS applied`,
    [
      MIGRATION_ID,
      ref.sourceId,
      ref.slug,
      nextContentHash,
      page.id,
      page.frontmatter_text,
      page.content_hash,
      page.type,
      page.title,
      page.compiled_truth,
      page.timeline,
      preStateHash,
    ],
  );
  const applied = Number(result[0]?.applied ?? 0);
  if (applied !== 1) {
    throw new Error('page changed while grandfathering; compare-and-set rejected the update');
  }
}

async function phaseCGrandfather(
  engine: BrainEngine,
  refs: PageRef[],
  schema: PageSchema,
  opts: OrchestratorOpts,
): Promise<{ result: OrchestratorPhaseResult; detail: GrandfatherResult }> {
  const gf: GrandfatherResult = { touched: 0, skipped: 0, failed: 0, failures: [] };
  if (!opts.dryRun) {
    try {
      await requireDurableSnapshotTable(engine);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      return {
        result: { name: 'grandfather', status: 'failed', detail: `snapshot table unavailable: ${detail}` },
        detail: { ...gf, failed: 1, failures: [detail] },
      };
    }
  }

  for (let i = 0; i < refs.length; i += BATCH_SIZE) {
    const batch = refs.slice(i, i + BATCH_SIZE);
    for (const ref of batch) {
      try {
        const selectParams: unknown[] = [ref.slug];
        const selectPredicates = ['slug = $1'];
        if (schema.hasSourceId) {
          selectParams.push(ref.sourceId);
          selectPredicates.push(`source_id = $${selectParams.length}`);
        }
        selectPredicates.push(...eligiblePredicates(schema));
        const pages = await engine.executeRaw<PageMigrationRow>(
          `SELECT id, type, title, compiled_truth, timeline, frontmatter,
                  frontmatter::text AS frontmatter_text,
                  (frontmatter || '{"validate": false}'::jsonb)::text AS next_frontmatter_text,
                  content_hash
             FROM pages
            WHERE ${selectPredicates.join(' AND ')}
            LIMIT 1`,
          selectParams,
        );
        const page = pages[0];
        if (!page) { gf.skipped++; continue; }

        // Idempotency: skip if frontmatter already has a `validate` key
        // (whether true, false, or any other value). We don't flip existing
        // explicit settings.
        if (page.frontmatter && Object.prototype.hasOwnProperty.call(page.frontmatter, 'validate')) {
          gf.skipped++;
          continue;
        }

        if (opts.dryRun) {
          gf.touched++;
          continue;
        }

        const preStateHash = snapshotStateHash(page, page.frontmatter_text);
        const nextContentHash = contentHashFromDatabaseJson(page, page.next_frontmatter_text);

        await applyGrandfatheredPage(engine, ref, page, schema, preStateHash, nextContentHash);
        gf.touched++;
      } catch (e) {
        gf.failed++;
        const msg = e instanceof Error ? e.message : String(e);
        gf.failures.push(`${ref.sourceId}:${ref.slug}: ${msg.slice(0, 100)}`);
      }
    }
  }

  const status: OrchestratorPhaseResult['status'] =
    gf.failed > 0 ? 'failed' : 'complete';
  const detailStr =
    `touched=${gf.touched} skipped=${gf.skipped} failed=${gf.failed}` +
    (gf.failures[0] ? ` first_error=${gf.failures[0]}` : '');
  return {
    result: { name: 'grandfather', status, detail: detailStr },
    detail: gf,
  };
}

// ---------------------------------------------------------------------------
// Phase D — import surviving legacy rollback evidence
// ---------------------------------------------------------------------------

function readLegacyRollbackEntries(): LegacyRollbackEntry[] | null {
  const legacyPath = gbrainPath('migrations', 'v0_13_1-rollback.jsonl');
  if (!existsSync(legacyPath)) return null;

  const entries: LegacyRollbackEntry[] = [];
  const lines = readFileSync(legacyPath, 'utf8').split(/\r?\n/).filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    const migration = entry.migration;
    const sourceId = migration === 'v0.13.0' ? (entry.source_id ?? 'default') : entry.source_id;
    const slug = entry.slug;
    const frontmatter = entry.pre_frontmatter;
    const recordedAt = entry.timestamp;
    if (
      (migration !== MIGRATION_ID && migration !== 'v0.13.0') ||
      typeof sourceId !== 'string' || sourceId.length === 0 ||
      typeof slug !== 'string' || slug.length === 0 ||
      typeof recordedAt !== 'string' || Number.isNaN(Date.parse(recordedAt)) ||
      typeof frontmatter !== 'object' || frontmatter === null || Array.isArray(frontmatter)
    ) {
      throw new Error(`invalid legacy rollback entry at line ${index + 1}`);
    }
    entries.push({ rawLine: line, sourceId, slug });
  }
  return entries;
}

async function phaseDImportLegacySnapshots(
  engine: BrainEngine,
  entries: LegacyRollbackEntry[] | null,
): Promise<OrchestratorPhaseResult> {
  if (entries === null) {
    return { name: 'legacy-rollback-import', status: 'skipped', detail: 'no legacy rollback ledger present' };
  }

  try {
    let imported = 0;
    let alreadyPresent = 0;
    for (const entry of entries) {
      const inserted = await engine.executeRaw<{ source_id: string }>(
        `INSERT INTO migration_page_snapshots
           (migration_id, source_id, slug, pre_state_hash, pre_frontmatter,
            pre_content_hash, post_content_hash, snapshot_format)
         VALUES ($1, $2, $3, $4, ($5::jsonb)->'pre_frontmatter', NULL, NULL, 'legacy_jsonl')
         ON CONFLICT (migration_id, source_id, slug, pre_state_hash) DO NOTHING
         RETURNING source_id`,
        [
          MIGRATION_ID,
          entry.sourceId,
          entry.slug,
          createHash('sha256').update(entry.rawLine).digest('hex'),
          entry.rawLine,
        ],
      );
      if (inserted.length === 1) imported++;
      else alreadyPresent++;
    }
    return {
      name: 'legacy-rollback-import',
      status: 'complete',
      detail: `imported=${imported} already_present=${alreadyPresent}`,
    };
  } catch (e) {
    return {
      name: 'legacy-rollback-import',
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function applyOverGrandfatherRestore(
  engine: BrainEngine,
  entry: LegacyRollbackEntry,
  page: PageMigrationRow,
  schema: PageSchema,
  preStateHash: string,
  nextContentHash: string,
): Promise<void> {
  const targetPredicates = [
    'p.id = $5',
    'p.slug = $3',
    'p.frontmatter::text = $6',
    'p.content_hash IS NOT DISTINCT FROM $7',
    'p.type = $8',
    'p.title = $9',
    'p.compiled_truth = $10',
    'p.timeline = $11',
    `p.frontmatter = (($13::jsonb)->'pre_frontmatter') || '{"validate": false}'::jsonb`,
    `p.created_at <= (($13::jsonb)->>'timestamp')::timestamptz`,
    ...postRolloutPredicates(schema, 'p'),
  ];
  if (schema.hasSourceId) targetPredicates.push('p.source_id = $2');

  const result = await engine.executeRaw<{ applied: number }>(
    `WITH target AS (
       SELECT p.id,
              $2::text AS snapshot_source_id,
              p.slug,
              p.frontmatter,
              p.content_hash
         FROM pages p
        WHERE ${targetPredicates.join(' AND ')}
        FOR UPDATE
     ),
     existing_snapshot AS (
       SELECT s.source_id, s.slug, s.pre_state_hash
         FROM migration_page_snapshots s
         JOIN target t
           ON s.source_id = t.snapshot_source_id
          AND s.slug = t.slug
        WHERE s.migration_id = $1
          AND s.pre_state_hash = $12
          AND s.pre_frontmatter = t.frontmatter
          AND s.pre_content_hash IS NOT DISTINCT FROM t.content_hash
     ),
     inserted_snapshot AS (
       INSERT INTO migration_page_snapshots
         (migration_id, source_id, slug, pre_state_hash, pre_frontmatter,
          pre_content_hash, post_content_hash, snapshot_format)
       SELECT $1, t.snapshot_source_id, t.slug, $12, t.frontmatter,
              t.content_hash, $4, 'database_exact'
         FROM target t
       ON CONFLICT (migration_id, source_id, slug, pre_state_hash) DO NOTHING
       RETURNING source_id, slug, pre_state_hash
     ),
     authorized AS (
       SELECT source_id, slug, pre_state_hash FROM existing_snapshot
       UNION ALL
       SELECT source_id, slug, pre_state_hash FROM inserted_snapshot
     ),
     updated AS (
       UPDATE pages p
          SET frontmatter = p.frontmatter - 'validate',
              content_hash = $4,
              updated_at = now()
         FROM target t
        WHERE p.id = t.id
          AND EXISTS (
            SELECT 1
              FROM authorized a
             WHERE a.source_id = t.snapshot_source_id
               AND a.slug = t.slug
               AND a.pre_state_hash = $12
          )
       RETURNING p.id
     )
     SELECT (SELECT COUNT(*)::int FROM updated) AS applied`,
    [
      RESTORE_MIGRATION_ID,
      entry.sourceId,
      entry.slug,
      nextContentHash,
      page.id,
      page.frontmatter_text,
      page.content_hash,
      page.type,
      page.title,
      page.compiled_truth,
      page.timeline,
      preStateHash,
      entry.rawLine,
    ],
  );
  if (Number(result[0]?.applied ?? 0) !== 1) {
    throw new Error('page changed while restoring validation; compare-and-set rejected the update');
  }
}

async function phaseERestoreOverGrandfathered(
  engine: BrainEngine,
  entries: LegacyRollbackEntry[] | null,
  schema: PageSchema,
): Promise<{ result: OrchestratorPhaseResult; restored: number }> {
  if (entries === null) {
    return {
      result: {
        name: 'over-grandfather-restore',
        status: 'skipped',
        detail: 'no legacy rollback ledger present',
      },
      restored: 0,
    };
  }

  let restored = 0;
  let skipped = 0;
  const failures: string[] = [];
  const entryGroups = new Map<string, LegacyRollbackEntry[]>();
  for (const entry of entries) {
    const key = JSON.stringify([entry.sourceId, entry.slug]);
    const group = entryGroups.get(key) ?? [];
    group.push(entry);
    entryGroups.set(key, group);
  }

  for (const group of entryGroups.values()) {
    const identity = group[0]!;
    try {
      let restoredFromEvidence = false;
      for (const entry of group) {
        const params: unknown[] = [entry.slug, entry.rawLine];
        const predicates = [
          'slug = $1',
          `frontmatter = (($2::jsonb)->'pre_frontmatter') || '{"validate": false}'::jsonb`,
          `created_at <= (($2::jsonb)->>'timestamp')::timestamptz`,
          ...postRolloutPredicates(schema),
        ];
        if (schema.hasSourceId) {
          params.push(entry.sourceId);
          predicates.push(`source_id = $${params.length}`);
        }
        const candidates = await engine.executeRaw<PageMigrationRow>(
          `SELECT id, type, title, compiled_truth, timeline, frontmatter,
                  frontmatter::text AS frontmatter_text,
                  (frontmatter - 'validate')::text AS next_frontmatter_text,
                  content_hash
             FROM pages
            WHERE ${predicates.join(' AND ')}
            LIMIT 1`,
          params,
        );
        const page = candidates[0];
        if (!page) continue;

        const preStateHash = snapshotStateHash(page, page.frontmatter_text);
        const nextContentHash = contentHashFromDatabaseJson(page, page.next_frontmatter_text);
        await applyOverGrandfatherRestore(
          engine,
          entry,
          page,
          schema,
          preStateHash,
          nextContentHash,
        );
        restored++;
        restoredFromEvidence = true;
        break;
      }
      if (!restoredFromEvidence) {
        const probeParams: unknown[] = [identity.slug];
        const probePredicates = ['slug = $1', ...postRolloutPredicates(schema)];
        if (schema.hasSourceId) {
          probeParams.push(identity.sourceId);
          probePredicates.push(`source_id = $${probeParams.length}`);
        }
        const probe = await engine.executeRaw<{ validate_value: string | null }>(
          `SELECT frontmatter->>'validate' AS validate_value
             FROM pages
            WHERE ${probePredicates.join(' AND ')}
            LIMIT 1`,
          probeParams,
        );
        if (probe[0]?.validate_value === 'false') {
          throw new Error('no legacy ledger entry matches the current validate:false frontmatter');
        }
        skipped++;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push(`${identity.sourceId}:${identity.slug}: ${message.slice(0, 100)}`);
    }
  }

  return {
    result: {
      name: 'over-grandfather-restore',
      status: failures.length > 0 ? 'failed' : 'complete',
      detail:
        `restored=${restored} skipped=${skipped} failed=${failures.length}` +
        (failures[0] ? ` first_error=${failures[0]}` : ''),
    },
    restored,
  };
}

// Phase F — verify the remaining pre-rollout population
async function phaseFVerify(engine: BrainEngine, knownSchema?: PageSchema): Promise<OrchestratorPhaseResult> {
  try {
    const schema = knownSchema ?? await detectPageSchema(engine);
    const predicates = [...eligiblePredicates(schema), "NOT (frontmatter ? 'validate')"];
    const rows = await engine.executeRaw<{ count: string | number }>(
      `SELECT COUNT(*) AS count
         FROM pages
        WHERE ${predicates.join(' AND ')}`,
    );
    const count = rows[0]?.count ?? 0;
    const n = typeof count === 'string' ? parseInt(count, 10) : Number(count);
    return {
      name: 'verify',
      status: n === 0 ? 'complete' : 'failed',
      detail: `eligible pages without validate key: ${n}`,
    };
  } catch (e) {
    return {
      name: 'verify',
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

async function migrateConnectedEngine(
  engine: BrainEngine,
  opts: OrchestratorOpts,
  reportVersion = '0.13.1',
): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];
  let filesRewritten = 0;

  const { result: snapRes, refs, schema } = await phaseBSnapshot(engine);
  phases.push(snapRes);
  if (snapRes.status !== 'complete' || !schema) {
    return { version: reportVersion, status: 'failed', phases };
  }

  const { result: gfRes, detail: gfDetail } = await phaseCGrandfather(engine, refs, schema, opts);
  phases.push(gfRes);
  filesRewritten = gfDetail.touched;

  if (!opts.dryRun) {
    let legacyEntries: LegacyRollbackEntry[] | null = null;
    try {
      legacyEntries = readLegacyRollbackEntries();
      phases.push(await phaseDImportLegacySnapshots(engine, legacyEntries));
    } catch (e) {
      phases.push({
        name: 'legacy-rollback-import',
        status: 'failed',
        detail: e instanceof Error ? e.message : String(e),
      });
    }
    if (!phases.some((phase) => phase.name === 'legacy-rollback-import' && phase.status === 'failed')) {
      const restore = await phaseERestoreOverGrandfathered(engine, legacyEntries, schema);
      phases.push(restore.result);
      filesRewritten += restore.restored;
    }
    phases.push(await phaseFVerify(engine, schema));
  }

  const anyFailed = phases.some(p => p.status === 'failed');
  return {
    version: reportVersion,
    // This repair has no external/manual phase that can legitimately remain
    // pending. A failed database phase must therefore fail the command rather
    // than being recorded as a successful-but-partial migration.
    status: anyFailed ? 'failed' : 'complete',
    phases,
    files_rewritten: filesRewritten,
  };
}

async function orchestratorForVersion(opts: OrchestratorOpts, reportVersion: string): Promise<OrchestratorResult> {
  const { result: connectRes, engine } = await phaseAConnect(opts);
  if (connectRes.status !== 'complete' || !engine) {
    return {
      version: reportVersion,
      status: connectRes.status === 'skipped' ? 'partial' : 'failed',
      phases: [connectRes],
    };
  }

  try {
    const result = await migrateConnectedEngine(engine, opts, reportVersion);
    return { ...result, phases: [connectRes, ...result.phases] };
  } finally {
    try { await engine.disconnect(); } catch {}
  }
}

const orchestrator = (opts: OrchestratorOpts) => orchestratorForVersion(opts, '0.13.1');
const repairOrchestrator = (opts: OrchestratorOpts) => orchestratorForVersion(opts, '0.40.9');

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const v0_13_1: Migration = {
  version: '0.13.1',
  featurePitch: {
    headline: 'BrainWriter integrity + grandfather protection for existing pages.',
    description:
      'Adds `validate: false` to existing pages so the new Knowledge Runtime ' +
      'validators (citation / link / back-link / triple-HR) don’t reject legacy ' +
      'content. Pages keep passing writes through unchanged; `gbrain integrity ' +
      '--auto` clears the flag per-page once citations are repaired. Exact ' +
      'source-qualified rollback snapshots are stored durably in Postgres.',
  },
  orchestrator,
};

/** Reach the repaired path even where the historical v0.13.1 ledger is complete. */
export const v0_40_9: Migration = {
  version: '0.40.9',
  featurePitch: {
    headline: 'Durable rollback evidence for the v0.13.1 grandfather migration.',
    description:
      'Repairs still-unflagged legacy pages with database-exact JSON handling, ' +
      'stores new rollback evidence in Postgres, imports surviving v0.13.1 JSONL evidence, ' +
      'and exactly restores post-rollout pages incorrectly exempted by an older repair ' +
      'only when the page timestamp predates its rollback evidence.',
  },
  orchestrator: repairOrchestrator,
};

/** Exported for focused multi-source regression tests only. */
export const __testing = {
  migrateConnectedEngine,
  verifyEligiblePopulation: phaseFVerify,
  compactJsonTextLosslessly,
  contentHashFromDatabaseJson,
  prepareConnectedEngine,
};
