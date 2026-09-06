import type { BrainEngine } from '../engine.ts';
import {
  ContextMirrorReconciliationTimeoutError,
  ContextMirrorReconciliationUnsupportedEngineError,
  runSessionHeadReconciliationV2,
  type ReconciliationV2Result,
} from './context-mirror-state.ts';
import { toSessionSlug } from './distill.ts';

export interface BoundedContextMirrorReconciliationOptions {
  sourceId: string;
  batchSize: number;
  maxBatches: number;
  maxRuntimeMs: number;
  actor: string;
  reason: string;
}

export interface BoundedContextMirrorReconciliationReport {
  schemaVersion: 2;
  sourceId: string;
  status: ReconciliationV2Result['status'];
  batches: number;
  scanned: number;
  insertedMembership: number;
  membership: number;
  ambiguousIdentityPages: number;
  totalHeads: number;
  pendingEligible: number;
  cursorPageId: number;
  scanUpperPageId: number;
  leaseGeneration: number;
  resumeFingerprint: string;
  providerCalls: 0;
}

export interface BoundedContextMirrorReconciliationWireReport {
  schema_version: 2;
  source_id: string;
  status: ReconciliationV2Result['status'];
  batches: number;
  scanned: number;
  inserted_membership: number;
  membership: number;
  ambiguous_identity_pages: number;
  total_heads: number;
  pending_eligible: number;
  cursor_page_id: number;
  scan_upper_page_id: number;
  lease_generation: number;
  resume_fingerprint: string;
  provider_calls: 0;
}

export function toBoundedContextMirrorReconciliationWireReport(
  report: BoundedContextMirrorReconciliationReport,
): BoundedContextMirrorReconciliationWireReport {
  return {
    schema_version: report.schemaVersion,
    source_id: report.sourceId,
    status: report.status,
    batches: report.batches,
    scanned: report.scanned,
    inserted_membership: report.insertedMembership,
    membership: report.membership,
    ambiguous_identity_pages: report.ambiguousIdentityPages,
    total_heads: report.totalHeads,
    pending_eligible: report.pendingEligible,
    cursor_page_id: report.cursorPageId,
    scan_upper_page_id: report.scanUpperPageId,
    lease_generation: report.leaseGeneration,
    resume_fingerprint: report.resumeFingerprint,
    provider_calls: report.providerCalls,
  };
}

export type ContextMirrorReconciliationBatchRunner = typeof runSessionHeadReconciliationV2;

interface BoundedContextMirrorReconciliationDeps {
  runBatch?: ContextMirrorReconciliationBatchRunner;
  sessionSlug?: (sessionId: string) => string;
  now?: () => Date;
  nowMs?: () => number;
}

function boundedInteger(name: string, value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

/**
 * Shared bounded orchestration for the admin recovery operation and the
 * permanent no-provider tail command. The batch implementation reads metadata
 * only and records its own source-scoped audit rows atomically.
 */
export async function runBoundedContextMirrorReconciliation(
  engine: BrainEngine,
  opts: BoundedContextMirrorReconciliationOptions,
  deps: BoundedContextMirrorReconciliationDeps = {},
): Promise<BoundedContextMirrorReconciliationReport> {
  if (engine.kind !== 'postgres') {
    throw new ContextMirrorReconciliationUnsupportedEngineError(
      'bounded Context Mirror reconciliation requires Postgres',
    );
  }
  if (!opts.sourceId.trim()) throw new Error('sourceId is required');
  const batchSize = boundedInteger('batchSize', opts.batchSize, 1, 5_000);
  const maxBatches = boundedInteger('maxBatches', opts.maxBatches, 1, 20);
  const maxRuntimeMs = boundedInteger('maxRuntimeMs', opts.maxRuntimeMs, 2_000, 45_000);
  const now = deps.now ?? (() => new Date());
  const nowMs = deps.nowMs ?? Date.now;
  const runBatch = deps.runBatch ?? runSessionHeadReconciliationV2;
  const sessionSlug = deps.sessionSlug ?? toSessionSlug;
  const deadlineAtMs = nowMs() + maxRuntimeMs;
  let scanned = 0;
  let insertedMembership = 0;
  let batches = 0;
  let latest: ReconciliationV2Result | null = null;

  while (
    batches < maxBatches
    && deadlineAtMs - nowMs() >= (batches === 0 ? 1_000 : 2_000)
  ) {
    try {
      latest = await runBatch(engine, {
        sourceId: opts.sourceId,
        now: now(),
        idleHours: 6,
        sessionSlug,
        batchSize,
        deadlineAtMs,
        actor: opts.actor,
        reason: opts.reason,
      });
    } catch (error) {
      if (batches > 0 && error instanceof ContextMirrorReconciliationTimeoutError) break;
      throw error;
    }
    batches += 1;
    scanned += latest.scanned;
    insertedMembership += latest.insertedMembership;
    if (latest.status !== 'partial') break;
  }

  if (!latest) {
    throw new ContextMirrorReconciliationTimeoutError(
      'Context Mirror reconciliation runtime expired before the first batch',
    );
  }
  return {
    schemaVersion: 2,
    sourceId: opts.sourceId,
    status: latest.status,
    batches,
    scanned,
    insertedMembership,
    membership: latest.membership,
    ambiguousIdentityPages: latest.ambiguousIdentityPages,
    totalHeads: latest.totalHeads,
    pendingEligible: latest.pendingEligible,
    cursorPageId: latest.cursorPageId,
    scanUpperPageId: latest.scanUpperPageId,
    leaseGeneration: latest.leaseGeneration,
    resumeFingerprint: latest.resumeFingerprint,
    providerCalls: 0,
  };
}
