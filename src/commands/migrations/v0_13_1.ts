/**
 * v0.13.1 migration — grandfather `validate: false` onto existing pages.
 *
 * The Knowledge Runtime BrainWriter ships pre-commit citation / link /
 * back-link / triple-HR validators. A fresh brain passes them trivially.
 * An existing brain with years of accumulated pages does NOT — legitimate
 * pages without strict citation formatting exist all over the place.
 *
 * This migration walks every page and adds `validate: false` to frontmatter
 * where the field isn't already present. Pages with that flag bypass the
 * validators entirely, so strict-mode rollout doesn't break existing
 * content. `gbrain integrity --auto` clears the flag per-page as it writes
 * proper citations.
 *
 * Idempotency: pages that already have `validate: false` or `validate: true`
 * are skipped. Running twice is a no-op on the second pass.
 *
 * Reversibility: every page touched is logged to
 * ~/.gbrain/migrations/v0_13_1-rollback.jsonl with its pre-migration
 * frontmatter snapshot. Roll back by re-applying those snapshots via
 * `gbrain apply-migrations --rollback v0.13.1` (future CLI; not in scope).
 *
 * Work is traversed in chunks of 100 so the in-memory batch stays bounded.
 * Each page update uses a compare-and-set guard; there is no batch transaction.
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

import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';
import { loadConfig, toEngineConfig, gbrainPath } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { contentHash } from '../../core/utils.ts';
// Bug 3 — ledger writes moved to the runner (apply-migrations.ts).

// Lazy: GBRAIN_HOME may be set after module load.
const getRollbackDir = () => gbrainPath('migrations');
const getRollbackFile = () => join(getRollbackDir(), 'v0_13_1-rollback.jsonl');
const BATCH_SIZE = 100;

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
}

// ---------------------------------------------------------------------------
// Phase A — connect (no config write)
// ---------------------------------------------------------------------------

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

function eligiblePredicates(schema: PageSchema): string[] {
  const predicates: string[] = [];
  if (schema.hasDeletedAt) predicates.push('deleted_at IS NULL');
  if (schema.hasSourceId) {
    predicates.push("NOT (source_id = 'capture-events' AND slug LIKE 'capture/%')");
  }
  return predicates;
}

async function phaseBSnapshot(engine: BrainEngine): Promise<{
  result: OrchestratorPhaseResult;
  refs: PageRef[];
  schema: PageSchema | null;
}> {
  try {
    const schema = await detectPageSchema(engine);
    const predicates = eligiblePredicates(schema);
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

// ---------------------------------------------------------------------------
// Phase C — grandfather: add validate:false where absent
// ---------------------------------------------------------------------------

interface GrandfatherResult {
  touched: number;
  skipped: number;
  failed: number;
  failures: string[];
}

async function phaseCGrandfather(
  engine: BrainEngine,
  refs: PageRef[],
  schema: PageSchema,
  opts: OrchestratorOpts,
): Promise<{ result: OrchestratorPhaseResult; detail: GrandfatherResult }> {
  ensureRollbackDir();
  const gf: GrandfatherResult = { touched: 0, skipped: 0, failed: 0, failures: [] };

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
          `SELECT id, type, title, compiled_truth, timeline, frontmatter, content_hash
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

        // Rollback log BEFORE mutation, so a crash mid-write still lets us
        // revert. Append-only, one line per page, newline-terminated.
        appendRollbackEntry({
          source_id: ref.sourceId,
          slug: ref.slug,
          pre_frontmatter: page.frontmatter ?? {},
        });

        const nextFrontmatter = { ...(page.frontmatter ?? {}), validate: false };
        const nextContentHash = contentHash({
          type: page.type,
          title: page.title,
          compiled_truth: page.compiled_truth,
          timeline: page.timeline,
          frontmatter: nextFrontmatter,
        });

        const updateParams: unknown[] = [
          JSON.stringify(nextFrontmatter),
          nextContentHash,
          page.id,
          ref.slug,
        ];
        const updatePredicates = ['id = $3', 'slug = $4'];
        if (schema.hasSourceId) {
          updateParams.push(ref.sourceId);
          updatePredicates.push(`source_id = $${updateParams.length}`);
        }
        for (const [column, value] of [
          ['type', page.type],
          ['title', page.title],
          ['compiled_truth', page.compiled_truth],
          ['timeline', page.timeline],
        ] as const) {
          updateParams.push(value);
          updatePredicates.push(`${column} = $${updateParams.length}`);
        }
        updateParams.push(JSON.stringify(page.frontmatter ?? {}));
        updatePredicates.push(`frontmatter = $${updateParams.length}::jsonb`);
        updateParams.push(page.content_hash);
        updatePredicates.push(`content_hash IS NOT DISTINCT FROM $${updateParams.length}`);
        updatePredicates.push(...eligiblePredicates(schema));

        const updated = await engine.executeRaw<{ id: number }>(
          `UPDATE pages
              SET frontmatter = $1::jsonb,
                  content_hash = $2,
                  updated_at = now()
            WHERE ${updatePredicates.join(' AND ')}
            RETURNING id`,
          updateParams,
        );
        if (updated.length !== 1) {
          throw new Error('page changed while grandfathering; compare-and-set rejected the update');
        }
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
  const detailStr = `touched=${gf.touched} skipped=${gf.skipped} failed=${gf.failed}`;
  return {
    result: { name: 'grandfather', status, detail: detailStr },
    detail: gf,
  };
}

// ---------------------------------------------------------------------------
// Phase D — verify
// ---------------------------------------------------------------------------

async function phaseDVerify(engine: BrainEngine, knownSchema?: PageSchema): Promise<OrchestratorPhaseResult> {
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
): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];
  let filesRewritten = 0;

  const { result: snapRes, refs, schema } = await phaseBSnapshot(engine);
  phases.push(snapRes);
  if (snapRes.status !== 'complete' || !schema) {
    return { version: '0.13.1', status: 'failed', phases };
  }

  const { result: gfRes, detail: gfDetail } = await phaseCGrandfather(engine, refs, schema, opts);
  phases.push(gfRes);
  filesRewritten = gfDetail.touched;

  if (!opts.dryRun) {
    phases.push(await phaseDVerify(engine, schema));
  }

  const anyFailed = phases.some(p => p.status === 'failed');
  return {
    version: '0.13.1',
    status: anyFailed ? 'partial' : 'complete',
    phases,
    files_rewritten: filesRewritten,
  };
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const { result: connectRes, engine } = await phaseAConnect(opts);
  if (connectRes.status !== 'complete' || !engine) {
    return {
      version: '0.13.1',
      status: connectRes.status === 'skipped' ? 'partial' : 'failed',
      phases: [connectRes],
    };
  }

  try {
    const result = await migrateConnectedEngine(engine, opts);
    return { ...result, phases: [connectRes, ...result.phases] };
  } finally {
    try { await engine.disconnect(); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureRollbackDir(): void {
  const dir = getRollbackDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function appendRollbackEntry(entry: { source_id: string; slug: string; pre_frontmatter: Record<string, unknown> }): void {
  const line = JSON.stringify({
    migration: 'v0.13.1',
    timestamp: new Date().toISOString(),
    ...entry,
  }) + '\n';
  appendFileSync(getRollbackFile(), line, 'utf-8');
}

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
      '--auto` clears the flag per-page once citations are repaired. Rollback ' +
      'log at ~/.gbrain/migrations/v0_13_1-rollback.jsonl.',
  },
  orchestrator,
};

/** Exported for focused multi-source regression tests only. */
export const __testing = {
  migrateConnectedEngine,
  verifyEligiblePopulation: phaseDVerify,
};
