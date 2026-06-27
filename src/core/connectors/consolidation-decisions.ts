/**
 * consolidation-decisions.ts — Memory Consolidation Engine (U6) decision log.
 *
 * A durable telemetry writer: one row per classification, keyed on the
 * candidate idempotency tuple `(source_id, source_record_id, version)` PLUS the
 * `classification`. Two purposes:
 *
 *   1. AUDIT — every consolidation judgment (ADD / UPDATE / NOOP / NEEDS_REVIEW)
 *      leaves a trail independent of the candidate row's own lifecycle (a NOOP
 *      row is `status='rejected'` + off-queue; a degrade-to-passthrough writes
 *      no classifier columns — the decision log still records what happened).
 *   2. CALIBRATION — the nullable `tier1_cosine` lets U2 + an operator study the
 *      Tier-1 cosine distribution to set the low-cosine ADD floor (KTD2), which
 *      ships ESCALATE-by-default until the data justifies a value.
 *
 * Idempotent: the table's `UNIQUE (source_id, source_record_id, version,
 * classification)` + this writer's `ON CONFLICT DO NOTHING` make a repeat
 * classification a safe no-op (exactly one row per (tuple, classification)).
 * Mirrors the `toRow` idempotency pattern in candidate.ts.
 *
 * This module is imported by consolidate.ts (U1/U2) and base.ts (U3); it carries
 * NO dependency on either, so it can land first (U6) without a forward cycle.
 *
 * NB: no PII. The log stores source ids, the classification, a confidence, a
 * resolved page path, a cosine, and the model — never query text or capture
 * bodies. The redaction choke point stays `toRow`'s `strip()` on the candidate.
 */

import type { BrainEngine } from '../engine.ts';

/** The four consolidation verdicts the classifier (U2) emits. */
export type ConsolidationClassification = 'ADD' | 'UPDATE' | 'NOOP' | 'NEEDS_REVIEW';

/** The valid verdicts, for callers/tests that need the runtime set. */
export const CONSOLIDATION_CLASSIFICATIONS: readonly ConsolidationClassification[] = [
  'ADD', 'UPDATE', 'NOOP', 'NEEDS_REVIEW',
] as const;

/** A single decision to record. The tuple keys are required; everything the
 *  classifier may not have (a path for non-UPDATE, a cosine when the LLM tier
 *  ran without a fast-path hit) is nullable. */
export interface ConsolidationDecisionInput {
  /** Source the candidate belongs to. */
  sourceId: string;
  /** Upstream record identity (the singular idempotency anchor). */
  sourceRecordId: string;
  /** Candidate version string (default '1'). */
  version?: string;
  /** The verdict. */
  classification: ConsolidationClassification;
  /** The classifier's real confidence 0..1 (nullable). */
  confidence?: number | null;
  /** The resolved page path for an UPDATE (nullable; null for ADD/NOOP/REVIEW). */
  targetPath?: string | null;
  /** The Tier-1 dedup cosine (nullable — present only when Tier-1 embedded+searched). */
  tier1Cosine?: number | null;
  /** The model that produced the decision (nullable). */
  model?: string | null;
}

/**
 * Record one consolidation decision. Returns `{ written }` — `true` when a new
 * row was inserted, `false` when an identical (tuple, classification) row
 * already existed (ON CONFLICT DO NOTHING). Safe to call repeatedly.
 */
export async function recordConsolidationDecision(
  engine: BrainEngine,
  input: ConsolidationDecisionInput,
): Promise<{ written: boolean }> {
  const version = input.version ?? '1';
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO consolidation_decisions (
       source_id, source_record_id, version,
       classification, confidence, target_path, tier1_cosine, model
     ) VALUES (
       $1, $2, $3,
       $4, $5, $6, $7, $8
     )
     ON CONFLICT (source_id, source_record_id, version, classification) DO NOTHING
     RETURNING id`,
    [
      input.sourceId,
      input.sourceRecordId,
      version,
      input.classification,
      input.confidence ?? null,
      input.targetPath ?? null,
      input.tier1Cosine ?? null,
      input.model ?? null,
    ],
  );
  return { written: rows.length > 0 };
}
