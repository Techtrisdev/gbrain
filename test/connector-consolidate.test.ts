/**
 * Tests for the Memory Consolidation Engine — U6 (migration + config +
 * decision-log telemetry). Covers:
 *
 *   1. Migration v97 — relaxes the connector_candidates.target_kind CHECK to
 *      admit 'update_page' on a POPULATED db by dropping the CATALOG-RESOLVED
 *      constraint name (never a hardcoded literal), + adds three nullable
 *      columns without breaking existing rows. An 'update_page' INSERT is
 *      rejected BEFORE and accepted AFTER the migration.
 *   2. Migration v98 — the consolidation_decisions decision-log table.
 *   3. Config readers (consolidation-config.ts) — per-connector enable gate
 *      (default false; kill-switch + per-source `enabled` still short-circuit),
 *      model resolution (configured else Sonnet), Tier-1 threshold overrides.
 *   4. The decision-log writer (consolidation-decisions.ts) — one idempotent
 *      row per (tuple, classification).
 *
 * PGLite is hermetic and always runs (and — being Postgres-in-WASM — exercises
 * the same catalog DROP/ADD the prod migration ships). The Postgres half runs
 * only when DATABASE_URL is set, covering the prod NOT VALID/VALIDATE branch.
 *
 * Canonical PGLite block (R3 + R4 compliant): one engine per file, beforeEach
 * resets data, afterAll disconnects.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';
import {
  consolidationEnabled,
  consolidationModel,
  consolidationNoopCosine,
  consolidationAddCosineFloor,
  CONSOLIDATION_NOOP_COSINE_DEFAULT,
  CONSOLIDATION_MODEL_FALLBACK,
} from '../src/core/connectors/consolidation-config.ts';
import {
  recordConsolidationDecision,
  CONSOLIDATION_CLASSIFICATIONS,
} from '../src/core/connectors/consolidation-decisions.ts';

let pglite: PGLiteEngine;
let pg: PostgresEngine | null = null;

beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();

  if (process.env.DATABASE_URL) {
    pg = new PostgresEngine();
    await pg.connect({ database_url: process.env.DATABASE_URL });
    await pg.initSchema();
  }
}, 60_000);

afterAll(async () => {
  await pglite.disconnect();
  if (pg) await pg.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(pglite);
});

// ── helpers ──────────────────────────────────────────────────────────────────

/** The engine-correct v97 migration SQL, straight from the shipped registry. */
function v97SqlFor(engine: BrainEngine): string {
  const v97 = MIGRATIONS.find((m) => m.version === 97);
  if (!v97?.sqlFor) throw new Error('v97 migration / sqlFor missing');
  const sql = v97.sqlFor[engine.kind];
  if (!sql) throw new Error(`v97 has no ${engine.kind} branch`);
  return sql;
}

/** Drop EVERY check constraint touching target_kind (catalog-resolved). */
const DROP_TARGET_KIND_CHECKS = `
  DO $$
  DECLARE r record;
  BEGIN
    FOR r IN
      SELECT con.conname
        FROM pg_constraint con
        JOIN pg_attribute att
          ON att.attrelid = con.conrelid
         AND att.attnum   = ANY (con.conkey)
       WHERE con.conrelid = 'connector_candidates'::regclass
         AND con.contype  = 'c'
         AND att.attname  = 'target_kind'
    LOOP
      EXECUTE format('ALTER TABLE connector_candidates DROP CONSTRAINT %I', r.conname);
    END LOOP;
  END $$;
`;

async function insertTargetKind(
  engine: BrainEngine,
  recordId: string,
  kind: string,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO connector_candidates (source_id, source_record_id, version, target_kind)
       VALUES ('default', $1, '1', $2)`,
    [recordId, kind],
  );
}

async function insertRejected(engine: BrainEngine, recordId: string, kind: string): Promise<boolean> {
  try {
    await insertTargetKind(engine, recordId, kind);
    return false;
  } catch {
    return true;
  }
}

/**
 * Prove the migration relaxes the CHECK on a POPULATED table by dropping the
 * catalog-resolved (arbitrarily-named) legacy constraint — NOT a hardcoded
 * name — and that the populated row + the new columns survive.
 */
async function assertRelaxOnPopulatedDb(engine: BrainEngine): Promise<void> {
  const tag = `${engine.kind}-`;
  try {
    // 1. Simulate a PRE-v97 DB: drop the shipped 3-value check, add an
    //    arbitrarily-NAMED legacy 2-value check. The arbitrary name is the
    //    point — if the migration hardcoded a constraint name, it would miss
    //    this one and the relax would silently no-op.
    await engine.runMigration(0, `${DROP_TARGET_KIND_CHECKS}
      ALTER TABLE connector_candidates
        ADD CONSTRAINT cc_legacy_target_kind_arbitrary_name
        CHECK (target_kind IS NULL OR target_kind IN ('existing_page','inbox'));
    `);

    // 2. Populate the table so the relax runs against non-empty data.
    await insertTargetKind(engine, `${tag}populated`, 'inbox');

    // 3. 'update_page' is REJECTED before the migration (legacy 2-value check).
    expect(await insertRejected(engine, `${tag}before`, 'update_page')).toBe(true);

    // 4. Run the shipped v97 migration (engine-correct branch).
    await engine.runMigration(97, v97SqlFor(engine));

    // 5. 'update_page' is ACCEPTED after the migration.
    await insertTargetKind(engine, `${tag}after`, 'update_page');

    // 6. The pre-existing row survived; the three new columns exist + are NULL.
    const rows = await engine.executeRaw<{
      target_kind: string;
      base_compiled_hash: string | null;
      timeline_entry: string | null;
      classification: string | null;
    }>(
      `SELECT target_kind, base_compiled_hash, timeline_entry, classification
         FROM connector_candidates WHERE source_record_id = $1`,
      [`${tag}populated`],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].target_kind).toBe('inbox');
    expect(rows[0].base_compiled_hash).toBeNull();
    expect(rows[0].timeline_entry).toBeNull();
    expect(rows[0].classification).toBeNull();

    // 7. A bogus target_kind is still REJECTED (the relaxed check still enforces).
    expect(await insertRejected(engine, `${tag}bogus`, 'nonsense_kind')).toBe(true);
  } finally {
    // Restore the canonical 3-value named check + clean up rows so this
    // schema-mutating test can't pollute the shared engine for later tests.
    await engine.runMigration(97, v97SqlFor(engine));
    await engine.executeRaw(
      `DELETE FROM connector_candidates WHERE source_record_id LIKE $1`,
      [`${tag}%`],
    );
  }
}

// ── 1. Migration v97 — CHECK relax + nullable columns ─────────────────────────

describe('migration v97 — connector_candidates consolidation columns', () => {
  test('fresh schema already accepts update_page (schema files carry the 3-value CHECK)', async () => {
    await insertTargetKind(pglite, 'fresh-update', 'update_page');
    const [row] = await pglite.executeRaw<{ target_kind: string }>(
      `SELECT target_kind FROM connector_candidates WHERE source_record_id = 'fresh-update'`,
    );
    expect(row.target_kind).toBe('update_page');
  });

  test('the three new columns exist on connector_candidates', async () => {
    const cols = await pglite.executeRaw<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable
         FROM information_schema.columns
        WHERE table_name = 'connector_candidates'
          AND column_name IN ('base_compiled_hash','timeline_entry','classification')
        ORDER BY column_name`,
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'base_compiled_hash', 'classification', 'timeline_entry',
    ]);
    // all nullable — additive, must not break existing rows
    expect(cols.every((c) => c.is_nullable === 'YES')).toBe(true);
  });

  test('relaxes the CHECK on a POPULATED db by dropping the catalog-resolved name (pglite)', async () => {
    await assertRelaxOnPopulatedDb(pglite);
  });

  test('v97 ships both a postgres and a pglite sqlFor branch (dual-engine split)', () => {
    const v97 = MIGRATIONS.find((m) => m.version === 97);
    expect(v97?.sqlFor?.postgres).toBeTruthy();
    expect(v97?.sqlFor?.pglite).toBeTruthy();
    // The postgres branch uses the lock-friendly NOT VALID / VALIDATE split.
    expect(v97!.sqlFor!.postgres).toContain('NOT VALID');
    expect(v97!.sqlFor!.postgres).toContain('VALIDATE CONSTRAINT');
    // Neither branch hardcodes a DROP CONSTRAINT literal name — both resolve
    // from the catalog (conrelid::regclass + conkey on target_kind).
    expect(v97!.sqlFor!.postgres).toContain("'connector_candidates'::regclass");
    expect(v97!.sqlFor!.pglite).toContain("'connector_candidates'::regclass");
    expect(v97!.sqlFor!.postgres).not.toMatch(/DROP CONSTRAINT IF EXISTS connector_candidates_target_kind_check/);
  });

  // Postgres parity — covers the prod NOT VALID/VALIDATE branch. Skipped without DB.
  test('relaxes the CHECK on a POPULATED db (postgres)', async () => {
    if (!pg) {
      // Skipped-without-DB: no DATABASE_URL in this environment.
      return;
    }
    // Ensure a clean default source + no stray rows from other E2E tests.
    await pg.executeRaw(
      `INSERT INTO sources (id, name, config)
         VALUES ('default','default','{"federated":true}'::jsonb)
         ON CONFLICT (id) DO NOTHING`,
    );
    await pg.executeRaw(`DELETE FROM connector_candidates WHERE source_record_id LIKE 'postgres-%'`);
    await assertRelaxOnPopulatedDb(pg);
  });
});

// ── 2. Migration v98 — decision-log table ─────────────────────────────────────

describe('migration v98 — consolidation_decisions table', () => {
  test('the consolidation_decisions table + tuple-unique constraint exist', async () => {
    const [tbl] = await pglite.executeRaw<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_name = 'consolidation_decisions'`,
    );
    expect(tbl?.table_name).toBe('consolidation_decisions');

    const cons = await pglite.executeRaw<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
        WHERE table_name = 'consolidation_decisions'
          AND constraint_type = 'UNIQUE'`,
    );
    expect(cons.map((c) => c.constraint_name)).toContain('consolidation_decisions_tuple_unique');
  });
});

// ── 3. Config readers ─────────────────────────────────────────────────────────

describe('consolidationEnabled — per-connector gate', () => {
  const granolaOn = {
    connectors: {
      granola: { enabled: true, consolidation_enabled: true },
      slack: { enabled: true }, // a webhook connector, consolidation NOT enabled
    },
  };

  test('default OFF — connector enabled but no consolidation flag', () => {
    expect(consolidationEnabled('granola', { connectors: { granola: { enabled: true } } }, {})).toBe(false);
  });

  test('enabling consolidation on granola turns it on for granola only', () => {
    expect(consolidationEnabled('granola', granolaOn, {})).toBe(true);
    // slack (a webhook connector) stays off — no consolidation_enabled flag.
    expect(consolidationEnabled('slack', granolaOn, {})).toBe(false);
  });

  test('tolerates a JSON-string config (PGLite driver shape)', () => {
    expect(consolidationEnabled('granola', JSON.stringify(granolaOn), {})).toBe(true);
  });

  test('per-source connector enabled=false short-circuits (consolidation never runs on a disabled connector)', () => {
    const cfg = { connectors: { granola: { enabled: false, consolidation_enabled: true } } };
    expect(consolidationEnabled('granola', cfg, {})).toBe(false);
  });

  test('env kill-switch short-circuits even when fully enabled', () => {
    expect(consolidationEnabled('granola', granolaOn, { GBRAIN_CONNECTORS_KILLSWITCH: '1' })).toBe(false);
    // '0' / 'false' / '' do NOT trip the kill-switch.
    expect(consolidationEnabled('granola', granolaOn, { GBRAIN_CONNECTORS_KILLSWITCH: '0' })).toBe(true);
  });

  test('per-source kill flag short-circuits', () => {
    const cfg = {
      connectors_killswitch: true,
      connectors: { granola: { enabled: true, consolidation_enabled: true } },
    };
    expect(consolidationEnabled('granola', cfg, {})).toBe(false);
  });

  test('missing / malformed config → false (default-off)', () => {
    expect(consolidationEnabled('granola', null, {})).toBe(false);
    expect(consolidationEnabled('granola', 'not json', {})).toBe(false);
    expect(consolidationEnabled('granola', { connectors: {} }, {})).toBe(false);
  });
});

describe('consolidationModel — reasoning-tier resolution', () => {
  test('falls back to Sonnet when nothing is configured', async () => {
    expect(await consolidationModel(pglite)).toBe(CONSOLIDATION_MODEL_FALLBACK);
    expect(CONSOLIDATION_MODEL_FALLBACK).toBe('anthropic:claude-sonnet-4-6');
  });

  test('the configured connectors.consolidation_model key wins', async () => {
    await pglite.setConfig('connectors.consolidation_model', 'anthropic:claude-opus-4-7');
    expect(await consolidationModel(pglite)).toBe('anthropic:claude-opus-4-7');
  });

  test('a bare model id gets an anthropic: prefix so the gateway can route it', async () => {
    await pglite.setConfig('connectors.consolidation_model', 'claude-3-custom');
    expect(await consolidationModel(pglite)).toBe('anthropic:claude-3-custom');
  });
});

describe('Tier-1 threshold readers', () => {
  test('consolidationNoopCosine defaults to 0.95 and overrides from config', async () => {
    expect(await consolidationNoopCosine(pglite)).toBe(CONSOLIDATION_NOOP_COSINE_DEFAULT);
    expect(CONSOLIDATION_NOOP_COSINE_DEFAULT).toBe(0.95);

    await pglite.setConfig('connectors.consolidation_noop_cosine', '0.88');
    expect(await consolidationNoopCosine(pglite)).toBe(0.88);

    // out-of-[0,1] / non-numeric → ignored, default restored
    await pglite.setConfig('connectors.consolidation_noop_cosine', '2.5');
    expect(await consolidationNoopCosine(pglite)).toBe(0.95);
    await pglite.setConfig('connectors.consolidation_noop_cosine', 'abc');
    expect(await consolidationNoopCosine(pglite)).toBe(0.95);
  });

  test('consolidationAddCosineFloor is calibration-gated (default null = escalate)', async () => {
    expect(await consolidationAddCosineFloor(pglite)).toBeNull();
    await pglite.setConfig('connectors.consolidation_add_cosine_floor', '0.2');
    expect(await consolidationAddCosineFloor(pglite)).toBe(0.2);
    // invalid → stays null (do not trust a bad value into a premature ADD)
    await pglite.setConfig('connectors.consolidation_add_cosine_floor', '1.5');
    expect(await consolidationAddCosineFloor(pglite)).toBeNull();
  });
});

// ── 4. Decision-log writer ────────────────────────────────────────────────────

describe('recordConsolidationDecision — decision-log writer', () => {
  test('exposes the four canonical classifications', () => {
    expect([...CONSOLIDATION_CLASSIFICATIONS].sort()).toEqual(
      ['ADD', 'NEEDS_REVIEW', 'NOOP', 'UPDATE'],
    );
  });

  test('writes exactly one row keyed on the tuple, idempotent on repeat', async () => {
    const decision = {
      sourceId: 'default',
      sourceRecordId: 'rec-1',
      version: '1',
      classification: 'UPDATE' as const,
      confidence: 0.82,
      targetPath: 'people/alice-example.md',
      tier1Cosine: 0.41,
      model: 'anthropic:claude-sonnet-4-6',
    };

    expect((await recordConsolidationDecision(pglite, decision)).written).toBe(true);
    // repeat (same tuple + classification) → ON CONFLICT DO NOTHING
    expect((await recordConsolidationDecision(pglite, decision)).written).toBe(false);

    const rows = await pglite.executeRaw<{
      classification: string;
      confidence: number;
      target_path: string;
      tier1_cosine: number;
      model: string;
    }>(
      `SELECT classification, confidence, target_path, tier1_cosine, model
         FROM consolidation_decisions
        WHERE source_id = 'default' AND source_record_id = 'rec-1' AND version = '1'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].classification).toBe('UPDATE');
    expect(rows[0].target_path).toBe('people/alice-example.md');
    expect(Math.abs(rows[0].confidence - 0.82)).toBeLessThan(1e-6);
    expect(Math.abs(rows[0].tier1_cosine - 0.41)).toBeLessThan(1e-6);
  });

  test('a different classification for the same tuple is a distinct audit row', async () => {
    const base = { sourceId: 'default', sourceRecordId: 'rec-2', version: '1' };
    expect((await recordConsolidationDecision(pglite, { ...base, classification: 'NOOP' })).written).toBe(true);
    expect((await recordConsolidationDecision(pglite, { ...base, classification: 'ADD' })).written).toBe(true);
    const [{ n }] = await pglite.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM consolidation_decisions
        WHERE source_id = 'default' AND source_record_id = 'rec-2'`,
    );
    expect(Number(n)).toBe(2);
  });

  test('nullable fields persist as NULL when omitted; version defaults to 1', async () => {
    const r = await recordConsolidationDecision(pglite, {
      sourceId: 'default',
      sourceRecordId: 'rec-3',
      classification: 'NEEDS_REVIEW',
    });
    expect(r.written).toBe(true);
    const [row] = await pglite.executeRaw<{
      version: string;
      confidence: number | null;
      target_path: string | null;
      tier1_cosine: number | null;
      model: string | null;
    }>(
      `SELECT version, confidence, target_path, tier1_cosine, model
         FROM consolidation_decisions WHERE source_record_id = 'rec-3'`,
    );
    expect(row.version).toBe('1');
    expect(row.confidence).toBeNull();
    expect(row.target_path).toBeNull();
    expect(row.tier1_cosine).toBeNull();
    expect(row.model).toBeNull();
  });
});
