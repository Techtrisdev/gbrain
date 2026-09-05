import { createHash } from 'node:crypto';

import type { BrainEngine } from '../engine.ts';
import { VERSION, BUILD_SHA, HOST_BUILD_SHA } from '../../version.ts';
import {
  parseJsonObject,
  readContextMirrorRecoveryHold,
  reviewCapacitySnapshot,
} from './context-mirror-state.ts';

export type ContextMirrorPipelineState =
  | 'healthy'
  | 'idle'
  | 'unsupported'
  | 'degraded'
  | 'broken'
  | 'unknown';

export interface ContextMirrorStatusV1 {
  schema_version: 1;
  generated_at: string;
  source_id: string;
  build: { version: string; sha: string; host_sha: string };
  overall: {
    state: ContextMirrorPipelineState;
    reason_codes: string[];
    next_action: string | null;
  };
  configuration: {
    connector_enabled: boolean;
    distill_before_poll: boolean;
    consolidation_enabled: boolean;
  };
  external_proof: {
    runtime_coverage: 'unknown';
    outbox_delivery: 'unknown';
    retrieval_consumers: 'unknown';
    reason: 'not_recorded_in_gbrain_v1';
  };
  recovery_hold: {
    active: boolean;
    generation: number;
    held_at: string | null;
    released_at: string | null;
    updated_at: string | null;
    reason_code: string | null;
  };
  capture: {
    active_records: number;
    newest_at: string | null;
    distilled_pages: number;
    chunked_distilled_pages: number;
  };
  eligibility: {
    session_heads: number;
    ever_eligible: number;
    retryable_now: number;
    states: Record<'pending' | 'claimed' | 'result_persisted' | 'complete' | 'quarantined' | 'ambiguous', number>;
    cohort_first_at: string | null;
    cohort_latest_at: string | null;
    oldest_eligible_at: string | null;
    oldest_retryable_at: string | null;
    retryable_over_24h: number;
  };
  distillation: {
    last_attempt: null | {
      status: string;
      stop_reason: string | null;
      started_at: string;
      finished_at: string | null;
      selected: number;
      completed: number;
      failed: number;
      deferred: number;
    };
    last_success_at: string | null;
    provider: {
      circuit_state: 'closed' | 'open' | 'half_open';
      circuit_reason_code: string | null;
      next_probe_at: string | null;
      consecutive_failures: number;
      calls: Record<'prepared' | 'inflight' | 'result_persisted' | 'failed' | 'ambiguous_provider_outcome', number>;
      last_call_at: string | null;
      last_error_class: string | null;
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_tokens: number;
        cache_creation_tokens: number;
        estimated_cost_usd: null;
        cost_state: 'unknown_not_durably_recorded';
      };
    };
  };
  generations: {
    total: number;
    current_complete: number;
    current_building: number;
    superseded: number;
    quarantined: number;
    unverified_legacy: number;
    manifest_gap: number;
    last_completed_at: string | null;
  };
  consolidation: {
    partitions: Record<'pending' | 'claimed' | 'decided' | 'degraded' | 'failed' | 'superseded' | 'unverified_legacy', number>;
    oldest_retryable_at: string | null;
    retryable_over_24h: number;
    last_decided_at: string | null;
    decision_missing: number;
    legacy_import: {
      completed: boolean | null;
      cursor_updated_at: string | null;
      checkpoint_updated_at: string | null;
    };
  };
  decisions: {
    classifications: Record<'ADD' | 'UPDATE' | 'NOOP' | 'NEEDS_REVIEW', number>;
    last_at: string | null;
  };
  review: {
    human: { count: number; bytes: number; limit: number; oldest_at: string | null; max_age_hours: number; age_exceeded: boolean };
    staging: { count: number; bytes: number; count_limit: number; bytes_limit: number; oldest_at: string | null; max_age_hours: number; age_exceeded: boolean };
    fresh_quota: number;
    reservations: { slots: number; bytes: number; historical_slots: number };
    historical: { human: number; staging: number };
    service_window: {
      days: 14;
      observed_days: number;
      fresh_arrivals: number;
      completed_reviews: number;
      fresh_arrival_per_day: number | null;
      review_completion_per_day: number | null;
      margin_state: 'idle' | 'sufficient' | 'insufficient' | 'insufficient_history';
    };
  };
  promotion: {
    candidate_states: Record<'pending' | 'needs_review' | 'awaiting_review_capacity' | 'accepted' | 'rejected', number>;
    dispatch_frozen: boolean;
    promotion_states: Record<
      'accepted_dispatching' | 'dispatch_failed' | 'pr_opened' | 'merged_reindexing' |
      'indexing_failed' | 'indexed' | 'unresolved_legacy',
      number
    >;
    attempts: { total: number; last_at: string | null };
    transition_missing: number;
    oldest_accepted_unindexed_at: string | null;
    last_indexed_at: string | null;
    post_approval_indexing_latency_seconds: number | null;
    proof_state: 'recorded' | 'unknown_no_indexed_transition';
  };
  progress: {
    last_downstream_at: string | null;
    bootstrap_complete: boolean | null;
    bootstrap_checkpoint_at: string | null;
    reconciliation_version: number | null;
    reconciliation_phase: 'rebuilding' | 'tailing' | 'blocked' | null;
    membership_records: number;
    ambiguous_identity_pages: number;
    cursor_page_id: number | null;
    scan_upper_page_id: number | null;
    last_tail_at: string | null;
  };
}

export interface ContextMirrorRecoveryReadiness {
  ready: boolean;
  blockers: string[];
  fingerprint: string;
}

type JsonObject = Record<string, unknown>;

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function allowlistedCode(value: unknown, allowed: ReadonlySet<string>, fallback: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  return allowed.has(normalized) ? normalized : fallback;
}

const DISTILL_STOP_CODES = new Set([
  'completed', 'session_limit', 'call_limit', 'input_token_limit', 'output_token_limit',
  'cost_limit', 'runtime_limit', 'memory_limit', 'review_capacity', 'systemic_failure',
  'circuit_open', 'bootstrap_incomplete',
]);
const PROVIDER_ERROR_CODES = new Set([
  'config', 'budget', 'transient', 'validation', 'refusal', 'content_filter',
  'malformed_output', 'provider', 'authentication', 'billing', 'rate_limit', 'timeout',
]);

/** Collapse free-form provider text into a fixed, non-secret taxonomy. */
function circuitReasonCode(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const reason = value.toLowerCase();
  if (/credit|billing|payment|insufficient.fund/.test(reason)) return 'billing';
  if (/unauthor|forbidden|api.?key|credential|\b401\b|\b403\b/.test(reason)) return 'authentication';
  if (/rate.?limit|\b429\b/.test(reason)) return 'rate_limit';
  if (/budget|cost/.test(reason)) return 'budget';
  if (/timeout|network|temporar|\b5\d\d\b/.test(reason)) return 'transient_provider';
  if (/config|gateway unavailable|model/.test(reason)) return 'configuration';
  return 'systemic_provider_error';
}

function latestIso(values: Array<string | null>): string | null {
  const valid = values
    .filter((value): value is string => value != null)
    .map((value) => new Date(value))
    .filter((value) => Number.isFinite(value.getTime()));
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid.map((value) => value.getTime()))).toISOString();
}

function parseCheckpointCursor(value: unknown): { updated_at?: string } {
  const parsed = parseJsonObject(value);
  return typeof parsed.updated_at === 'string' ? { updated_at: parsed.updated_at } : {};
}

function configFor(sourceConfig: unknown): JsonObject {
  const root = parseJsonObject(sourceConfig);
  const connectors = parseJsonObject(root.connectors);
  return parseJsonObject(connectors.context_mirror);
}

function classifyOverall(input: {
  hasConfig: boolean;
  enabled: boolean;
  distillBeforePoll: boolean;
  consolidationEnabled: boolean;
  raw: number;
  bootstrapComplete: boolean | null;
  eligible: number;
  retryableOver24h: number;
  ambiguous: number;
  circuitOpen: boolean;
  failedRunWithBacklog: boolean;
  manifestGap: number;
  decisionMissing: number;
  partitionPending: number;
  partitionFailed: number;
  partitionOver24h: number;
  unverifiedLegacy: number;
  reviewAgeExceeded: boolean;
  reviewCapacityBlocked: boolean;
  reviewQueueOverLimit: boolean;
  reviewServiceMargin: ContextMirrorStatusV1['review']['service_window']['margin_state'];
  freshArrivals: number;
  recoveryHold: boolean;
  promotionIndexingFailed: number;
  promotionDispatchFailed: number;
  promotionTransitionMissing: number;
  promotionUnresolvedLegacy: number;
  promotionDispatchFrozenWithWork: boolean;
  queuesEmpty: boolean;
}): ContextMirrorStatusV1['overall'] {
  const broken: string[] = [];
  const degraded: string[] = [];
  if (input.ambiguous > 0) broken.push('ambiguous_provider_outcome');
  if (input.circuitOpen && input.eligible > 0) broken.push('provider_circuit_open');
  if (input.failedRunWithBacklog) broken.push('last_distill_failed_with_backlog');
  if (input.retryableOver24h > 0 || input.partitionOver24h > 0) broken.push('retryable_work_over_24h');
  if (input.partitionFailed > 0) broken.push('consolidation_partition_failed');
  if (input.manifestGap > 0) broken.push('generation_manifest_gap');
  if (input.decisionMissing > 0) broken.push('consolidation_decision_missing');
  if (input.promotionDispatchFailed > 0) broken.push('promotion_dispatch_failed');
  if (input.promotionIndexingFailed > 0) broken.push('promotion_indexing_failed');
  if (input.promotionTransitionMissing > 0) broken.push('promotion_transition_missing');
  if (broken.length > 0) {
    const next = broken.includes('ambiguous_provider_outcome')
      ? 'inspect_ambiguous_provider_outcomes'
      : broken.includes('provider_circuit_open')
        ? 'restore_provider_access_after_safety_gates'
        : broken.includes('generation_manifest_gap')
          ? 'repair_generation_manifest_before_retry'
          : broken.includes('promotion_dispatch_failed')
            ? 'reconcile_or_retry_failed_promotion_dispatch'
          : 'run_bounded_recovery_and_recheck_status';
    return { state: 'broken', reason_codes: broken, next_action: next };
  }

  if (input.recoveryHold) degraded.push('recovery_hold_active');
  if (input.raw > 0 && input.bootstrapComplete !== true) degraded.push('capture_inventory_incomplete');
  if (input.eligible > 0 && !input.distillBeforePoll) degraded.push('distillation_not_scheduled');
  if (input.partitionPending > 0 && !input.consolidationEnabled) degraded.push('consolidation_disabled_with_backlog');
  if (input.unverifiedLegacy > 0) degraded.push('unverified_legacy_evidence');
  if (input.reviewAgeExceeded) degraded.push('review_queue_age_exceeded');
  if (input.reviewCapacityBlocked) degraded.push('review_capacity_blocked');
  if (input.reviewQueueOverLimit) degraded.push('review_queue_over_limit');
  if (input.reviewServiceMargin === 'insufficient') degraded.push('review_service_margin_insufficient');
  if (input.reviewServiceMargin === 'insufficient_history' && input.freshArrivals > 0) {
    degraded.push('review_service_history_insufficient');
  }
  if (input.promotionUnresolvedLegacy > 0) degraded.push('unresolved_legacy_promotion');
  if (input.promotionDispatchFrozenWithWork) degraded.push('promotion_dispatch_frozen_with_work');
  if (!input.enabled && (input.raw > 0 || input.eligible > 0 || input.partitionPending > 0)) {
    degraded.push('connector_disabled_with_work');
  }
  if (degraded.length > 0) {
    const next = degraded.includes('recovery_hold_active')
      ? 'complete_recovery_then_release_hold'
      : degraded.includes('review_queue_age_exceeded') || degraded.includes('review_capacity_blocked')
        ? 'drain_or_resize_review_capacity_before_processing'
        : degraded.includes('unverified_legacy_evidence')
          ? 'reconcile_legacy_evidence_without_auto_promotion'
          : 'enable_bounded_pipeline_stage_after_safety_review';
    return { state: 'degraded', reason_codes: degraded, next_action: next };
  }

  if (!input.hasConfig && input.raw === 0) {
    return { state: 'unsupported', reason_codes: ['context_mirror_not_configured'], next_action: 'configure_or_explicitly_exclude_source' };
  }
  if (input.eligible === 0 && input.partitionPending === 0 && input.queuesEmpty) {
    return { state: 'idle', reason_codes: ['no_eligible_work'], next_action: null };
  }
  return { state: 'healthy', reason_codes: [], next_action: null };
}

/**
 * Exact, source-bound aggregate status. Every query has fixed output cardinality;
 * transcript bodies, transcript labels, error messages, secrets, and URLs are never
 * selected. Brain-side health combines this with the authoritative D-drive outbox and
 * real-consumer proofs, which are intentionally `unknown` here rather than inferred.
 */
export async function readContextMirrorStatusSnapshot(
  engine: BrainEngine,
  sourceId: string,
  now: Date = new Date(),
): Promise<ContextMirrorStatusV1 | null> {
  const sources = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (!sources[0]) return null;
  const config = configFor(sources[0].config);
  const hasConfig = Object.keys(config).length > 0;
  const connectorEnabled = config.enabled === true;
  const distillBeforePoll = config.distill_before_poll === true;
  const consolidationEnabled = config.consolidation_enabled === true;

  const captureRows = await engine.executeRaw<{
    active_records: number | string; newest_at: Date | string | null;
    distilled_pages: number | string; chunked_distilled_pages: number | string;
  }>(
    `SELECT
       count(*) FILTER (WHERE p.slug LIKE 'capture/%') AS active_records,
       max(p.updated_at) FILTER (WHERE p.slug LIKE 'capture/%') AS newest_at,
       count(*) FILTER (WHERE p.slug LIKE 'distilled/%') AS distilled_pages,
       count(*) FILTER (
         WHERE p.slug LIKE 'distilled/%'
           AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id)
       ) AS chunked_distilled_pages
     FROM pages p
     WHERE p.source_id = $1 AND p.deleted_at IS NULL`,
    [sourceId],
  );
  const capture = captureRows[0];

  const eligibilityRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT count(*) AS session_heads,
       count(*) FILTER (WHERE first_eligible_at IS NOT NULL) AS ever_eligible,
       count(*) FILTER (
         WHERE current_eligible_at IS NOT NULL AND state IN ('pending','claimed','result_persisted')
       ) AS retryable_now,
       count(*) FILTER (WHERE state = 'pending') AS pending,
       count(*) FILTER (WHERE state = 'claimed') AS claimed,
       count(*) FILTER (WHERE state = 'result_persisted') AS result_persisted,
       count(*) FILTER (WHERE state = 'complete') AS complete,
       count(*) FILTER (WHERE state = 'quarantined') AS quarantined,
       count(*) FILTER (WHERE state = 'ambiguous') AS ambiguous,
       min(cohort_at) FILTER (WHERE cohort_at IS NOT NULL) AS cohort_first_at,
       max(cohort_at) FILTER (WHERE cohort_at IS NOT NULL) AS cohort_latest_at,
       min(first_eligible_at) FILTER (
         WHERE first_eligible_at IS NOT NULL AND state IN ('pending','claimed','result_persisted')
       ) AS oldest_eligible_at,
       min(current_eligible_at) FILTER (
         WHERE current_eligible_at IS NOT NULL AND state IN ('pending','claimed','result_persisted')
       ) AS oldest_retryable_at,
       count(*) FILTER (
         WHERE current_eligible_at < $2::timestamptz - INTERVAL '24 hours'
           AND state IN ('pending','claimed','result_persisted')
       ) AS retryable_over_24h
     FROM context_mirror_session_heads WHERE source_id = $1`,
    [sourceId, now.toISOString()],
  );
  const eligibility = eligibilityRows[0] ?? {};

  const runRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT status, stop_reason, started_at, finished_at,
            selected_count, completed_count, failed_count, deferred_count
       FROM context_mirror_distill_runs
      WHERE source_id = $1 ORDER BY started_at DESC LIMIT 1`,
    [sourceId],
  );
  const successRows = await engine.executeRaw<{ last_success_at: Date | string | null }>(
    `SELECT max(finished_at) AS last_success_at
       FROM context_mirror_distill_runs WHERE source_id = $1 AND status = 'ok'`,
    [sourceId],
  );
  const lastRun = runRows[0];

  const circuitRows = await engine.executeRaw<{
    state: 'closed' | 'open' | 'half_open'; reason: string | null;
    next_probe_at: Date | string | null; consecutive_failures: number | string;
  }>(
    `SELECT state, reason, next_probe_at, consecutive_failures
       FROM context_mirror_circuits WHERE source_id = $1 AND provider = 'chat'`,
    [sourceId],
  );
  const circuit = circuitRows[0];

  const callRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT
       count(*) FILTER (WHERE state = 'prepared') AS prepared,
       count(*) FILTER (WHERE state = 'inflight') AS inflight,
       count(*) FILTER (WHERE state = 'result_persisted') AS result_persisted,
       count(*) FILTER (WHERE state = 'failed') AS failed,
       count(*) FILTER (WHERE state = 'ambiguous_provider_outcome') AS ambiguous_provider_outcome,
       max(prepared_at) AS last_call_at,
       (array_agg(error_class ORDER BY updated_at DESC) FILTER (WHERE error_class IS NOT NULL))[1] AS last_error_class,
       sum(CASE WHEN COALESCE(usage_json->>'input_tokens','') ~ '^\\d+$'
         THEN (usage_json->>'input_tokens')::bigint ELSE 0 END) AS input_tokens,
       sum(CASE WHEN COALESCE(usage_json->>'output_tokens','') ~ '^\\d+$'
         THEN (usage_json->>'output_tokens')::bigint ELSE 0 END) AS output_tokens,
       sum(CASE WHEN COALESCE(usage_json->>'cache_read_tokens','') ~ '^\\d+$'
         THEN (usage_json->>'cache_read_tokens')::bigint ELSE 0 END) AS cache_read_tokens,
       sum(CASE WHEN COALESCE(usage_json->>'cache_creation_tokens','') ~ '^\\d+$'
         THEN (usage_json->>'cache_creation_tokens')::bigint ELSE 0 END) AS cache_creation_tokens
     FROM context_mirror_provider_calls WHERE source_id = $1`,
    [sourceId],
  );
  const calls = callRows[0] ?? {};

  const generationRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT count(*) AS total,
       count(*) FILTER (WHERE is_current AND state = 'complete') AS current_complete,
       count(*) FILTER (WHERE is_current AND state = 'building') AS current_building,
       count(*) FILTER (WHERE state = 'superseded') AS superseded,
       count(*) FILTER (WHERE state = 'quarantined') AS quarantined,
       count(*) FILTER (WHERE state = 'unverified_legacy') AS unverified_legacy,
       count(*) FILTER (
         WHERE g.state = 'complete' AND (
           g.materialized_partitions <> g.expected_partitions
           OR g.expected_partitions <> (
             SELECT count(*)
               FROM context_mirror_partitions part
               JOIN pages p ON p.source_id = part.source_id
                           AND p.slug = part.distilled_slug
                           AND p.deleted_at IS NULL
              WHERE part.source_id = g.source_id
                AND part.session_id = g.session_id
                AND part.generation = g.generation
                AND EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id)
           )
         )
       ) AS manifest_gap,
       max(completed_at) AS last_completed_at
     FROM context_mirror_generations g WHERE source_id = $1`,
    [sourceId],
  );
  const generations = generationRows[0] ?? {};

  const partitionRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT
       count(*) FILTER (WHERE p.state = 'pending') AS pending,
       count(*) FILTER (WHERE p.state = 'claimed') AS claimed,
       count(*) FILTER (WHERE p.state = 'decided') AS decided,
       count(*) FILTER (WHERE p.state = 'degraded') AS degraded,
       count(*) FILTER (WHERE p.state = 'failed') AS failed,
       count(*) FILTER (WHERE p.state = 'superseded') AS superseded,
       count(*) FILTER (WHERE p.state = 'unverified_legacy') AS unverified_legacy,
       min(p.created_at) FILTER (WHERE p.state IN ('pending','failed')) AS oldest_retryable_at,
       count(*) FILTER (
         WHERE p.state IN ('pending','failed')
           AND p.created_at < $2::timestamptz - INTERVAL '24 hours'
       ) AS retryable_over_24h,
       max(p.decided_at) AS last_decided_at,
       count(*) FILTER (
         WHERE p.state = 'decided'
           AND (
             p.candidate_id IS NULL OR p.decision_classification IS NULL OR NOT EXISTS (
               SELECT 1
                 FROM connector_candidates c
                 JOIN consolidation_decisions d
                   ON d.source_id = c.source_id
                  AND d.source_record_id = c.source_record_id
                  AND d.version = c.version
                  AND d.classification = c.classification
                WHERE c.id = p.candidate_id AND c.source_id = p.source_id
             )
           )
       ) AS decision_missing
     FROM context_mirror_partitions p
     WHERE p.source_id = $1`,
    [sourceId, now.toISOString()],
  );
  const partitions = partitionRows[0] ?? {};

  const checkpointRows = await engine.executeRaw<{
    checkpoint_kind: string; cursor: unknown; completed: boolean; updated_at: Date | string;
  }>(
    `SELECT checkpoint_kind, cursor, completed, updated_at
       FROM context_mirror_checkpoints
      WHERE source_id = $1
        AND checkpoint_kind IN ('capture_session_scan_v1','distilled_legacy_import_v1')`,
    [sourceId],
  );
  const bootstrapCheckpoint = checkpointRows.find((row) => row.checkpoint_kind === 'capture_session_scan_v1');
  const legacyCheckpoint = checkpointRows.find((row) => row.checkpoint_kind === 'distilled_legacy_import_v1');
  const legacyCursor = parseCheckpointCursor(legacyCheckpoint?.cursor);
  const reconciliationRows = await engine.executeRaw<{
    version: number | string;
    phase: 'rebuilding' | 'tailing' | 'blocked';
    cursor_page_id: number | string;
    scan_upper_page_id: number | string;
    membership_count: number | string;
    ambiguous_count: number | string;
    last_tail_at: Date | string | null;
    updated_at: Date | string;
  }>(
    `SELECT version, phase, cursor_page_id, scan_upper_page_id,
            membership_count, ambiguous_count, last_tail_at, updated_at
       FROM context_mirror_reconciliation_state WHERE source_id = $1`,
    [sourceId],
  );
  const reconciliation = reconciliationRows[0];
  const reconciliationComplete = reconciliation
    ? reconciliation.phase === 'tailing'
      && numberValue(reconciliation.ambiguous_count) === 0
      && numberValue(reconciliation.cursor_page_id) >= numberValue(reconciliation.scan_upper_page_id)
    : null;
  const bootstrapComplete = reconciliationComplete ?? bootstrapCheckpoint?.completed ?? null;

  const decisionRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT
       count(*) FILTER (WHERE classification = 'ADD') AS add,
       count(*) FILTER (WHERE classification = 'UPDATE') AS update,
       count(*) FILTER (WHERE classification = 'NOOP') AS noop,
       count(*) FILTER (WHERE classification = 'NEEDS_REVIEW') AS needs_review,
       max(decided_at) AS last_at
     FROM consolidation_decisions d
     WHERE d.source_id = $1
       AND EXISTS (
         SELECT 1 FROM connector_candidates c
          WHERE c.source_id = d.source_id
            AND c.source_record_id = d.source_record_id
            AND c.version = d.version
            AND c.classification = d.classification
            AND c.provider = 'context_mirror'
       )`,
    [sourceId],
  );
  const decisions = decisionRows[0] ?? {};

  const candidateRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending') AS pending,
       count(*) FILTER (WHERE status = 'needs_review') AS needs_review,
       count(*) FILTER (WHERE status = 'awaiting_review_capacity') AS awaiting_review_capacity,
       count(*) FILTER (WHERE status = 'accepted') AS accepted,
       count(*) FILTER (WHERE status = 'rejected') AS rejected,
       count(*) FILTER (
         WHERE status = 'accepted'
           AND NOT EXISTS (
             SELECT 1 FROM connector_promotion_transitions t WHERE t.candidate_id = connector_candidates.id
           )
       ) AS promotion_transition_missing,
       count(*) FILTER (
         WHERE requires_human_review = false AND proposed_at >= $2::timestamptz - INTERVAL '14 days'
       ) AS fresh_arrivals,
       count(*) FILTER (
         WHERE acted_at >= $2::timestamptz - INTERVAL '14 days'
           AND status IN ('accepted','rejected')
       ) AS completed_reviews,
       min(proposed_at) AS first_candidate_at
     FROM connector_candidates
     WHERE source_id = $1 AND provider = 'context_mirror'`,
    [sourceId, now.toISOString()],
  );
  const candidates = candidateRows[0] ?? {};

  const promotionRows = await engine.executeRaw<Record<string, number | string | Date | null>>(
    `SELECT
       count(*) FILTER (WHERE t.state = 'accepted_dispatching') AS accepted_dispatching,
       count(*) FILTER (WHERE t.state = 'dispatch_failed') AS dispatch_failed,
       count(*) FILTER (WHERE t.state = 'pr_opened') AS pr_opened,
       count(*) FILTER (WHERE t.state = 'merged_reindexing') AS merged_reindexing,
       count(*) FILTER (WHERE t.state = 'indexing_failed') AS indexing_failed,
       count(*) FILTER (WHERE t.state = 'indexed') AS indexed,
       count(*) FILTER (WHERE t.state = 'unresolved_legacy') AS unresolved_legacy,
       COALESCE(sum(t.attempt_count), 0) AS attempts_total,
       max(t.last_attempt_at) AS last_attempt_at,
       min(t.accepted_at) FILTER (WHERE t.state <> 'indexed') AS oldest_accepted_unindexed_at,
       max(t.indexed_at) AS last_indexed_at,
       (array_agg(extract(epoch FROM (t.indexed_at - t.accepted_at)) ORDER BY t.indexed_at DESC)
         FILTER (WHERE t.indexed_at IS NOT NULL))[1] AS last_indexing_latency_seconds
     FROM connector_promotion_transitions t
     JOIN connector_candidates c ON c.id = t.candidate_id
     WHERE t.source_id = $1 AND c.provider = 'context_mirror'`,
    [sourceId],
  );
  const promotions = promotionRows[0] ?? {};
  const dispatchFrozen = !['false', '0'].includes(
    ((await engine.getConfig('connectors.promotion_dispatch_frozen')) ?? 'true').trim().toLowerCase(),
  );

  const review = await reviewCapacitySnapshot(engine, sourceId);
  const recovery = await readContextMirrorRecoveryHold(engine, sourceId);
  const firstCandidateAt = iso(candidates.first_candidate_at as Date | string | null);
  const observedDays = firstCandidateAt == null
    ? 0
    : Math.min(14, Math.max(0, (now.getTime() - new Date(firstCandidateAt).getTime()) / 86_400_000));
  const freshArrivals = numberValue(candidates.fresh_arrivals);
  const completedReviews = numberValue(candidates.completed_reviews);
  const freshRate = observedDays > 0 ? freshArrivals / observedDays : null;
  const serviceRate = observedDays > 0 ? completedReviews / observedDays : null;
  const queuesEmpty = review.humanPending === 0 && review.staged === 0 && review.reservedSlots === 0;
  const marginState: ContextMirrorStatusV1['review']['service_window']['margin_state'] =
    freshArrivals === 0 && queuesEmpty
      ? 'idle'
      : observedDays < 14
        ? 'insufficient_history'
        : serviceRate != null && freshRate != null && serviceRate >= freshRate * 1.2
          ? 'sufficient'
          : 'insufficient';

  const eligiblePending = numberValue(eligibility.retryable_now);
  const partitionPending = numberValue(partitions.pending) + numberValue(partitions.claimed);
  const reviewCapacityBlocked = eligiblePending > 0 &&
    (review.pendingLimit + review.stagingLimit <= review.humanPending + review.staged + review.reservedSlots);
  const reviewQueueOverLimit = review.humanPending > review.pendingLimit ||
    review.staged > review.stagingLimit || review.stagedBytes > review.stagingBytesLimit;
  const overall = classifyOverall({
    hasConfig,
    enabled: connectorEnabled,
    distillBeforePoll,
    consolidationEnabled,
    raw: numberValue(capture?.active_records),
    bootstrapComplete,
    eligible: eligiblePending,
    retryableOver24h: numberValue(eligibility.retryable_over_24h),
    ambiguous: numberValue(eligibility.ambiguous),
    circuitOpen: circuit?.state === 'open',
    failedRunWithBacklog: lastRun?.status === 'failed' && eligiblePending > 0,
    manifestGap: numberValue(generations.manifest_gap),
    decisionMissing: numberValue(partitions.decision_missing),
    partitionPending,
    partitionFailed: numberValue(partitions.failed),
    partitionOver24h: numberValue(partitions.retryable_over_24h),
    unverifiedLegacy: numberValue(generations.unverified_legacy),
    reviewAgeExceeded: review.humanAgeExceeded || review.stagingAgeExceeded,
    reviewCapacityBlocked,
    reviewQueueOverLimit,
    reviewServiceMargin: marginState,
    freshArrivals,
    recoveryHold: recovery.active,
    promotionIndexingFailed: numberValue(promotions.indexing_failed),
    promotionDispatchFailed: numberValue(promotions.dispatch_failed),
    promotionTransitionMissing: numberValue(candidates.promotion_transition_missing),
    promotionUnresolvedLegacy: numberValue(promotions.unresolved_legacy),
    promotionDispatchFrozenWithWork: dispatchFrozen && (
      numberValue(promotions.accepted_dispatching) + numberValue(promotions.dispatch_failed) > 0
    ),
    queuesEmpty,
  });

  const lastAttempt = lastRun
    ? {
        status: String(lastRun.status),
        stop_reason: allowlistedCode(lastRun.stop_reason, DISTILL_STOP_CODES, 'other'),
        started_at: iso(lastRun.started_at as Date | string)!,
        finished_at: iso(lastRun.finished_at as Date | string | null),
        selected: numberValue(lastRun.selected_count),
        completed: numberValue(lastRun.completed_count),
        failed: numberValue(lastRun.failed_count),
        deferred: numberValue(lastRun.deferred_count),
      }
    : null;
  const lastGenerationAt = iso(generations.last_completed_at as Date | string | null);
  const lastDecisionAt = iso(partitions.last_decided_at as Date | string | null);
  const lastCandidateDecisionAt = iso(decisions.last_at as Date | string | null);
  const indexedProgressAt = iso(promotions.last_indexed_at as Date | string | null);

  return {
    schema_version: 1,
    generated_at: now.toISOString(),
    source_id: sourceId,
    build: { version: VERSION, sha: BUILD_SHA, host_sha: HOST_BUILD_SHA },
    overall,
    configuration: {
      connector_enabled: connectorEnabled,
      distill_before_poll: distillBeforePoll,
      consolidation_enabled: consolidationEnabled,
    },
    external_proof: {
      runtime_coverage: 'unknown',
      outbox_delivery: 'unknown',
      retrieval_consumers: 'unknown',
      reason: 'not_recorded_in_gbrain_v1',
    },
    recovery_hold: {
      active: recovery.active,
      generation: recovery.generation,
      held_at: recovery.heldAt?.toISOString() ?? null,
      released_at: recovery.releasedAt?.toISOString() ?? null,
      updated_at: recovery.updatedAt?.toISOString() ?? null,
      reason_code: recovery.active ? 'operator_recovery_hold' : null,
    },
    capture: {
      active_records: numberValue(capture?.active_records),
      newest_at: iso(capture?.newest_at),
      distilled_pages: numberValue(capture?.distilled_pages),
      chunked_distilled_pages: numberValue(capture?.chunked_distilled_pages),
    },
    eligibility: {
      session_heads: numberValue(eligibility.session_heads),
      ever_eligible: numberValue(eligibility.ever_eligible),
      retryable_now: numberValue(eligibility.retryable_now),
      states: {
        pending: numberValue(eligibility.pending),
        claimed: numberValue(eligibility.claimed),
        result_persisted: numberValue(eligibility.result_persisted),
        complete: numberValue(eligibility.complete),
        quarantined: numberValue(eligibility.quarantined),
        ambiguous: numberValue(eligibility.ambiguous),
      },
      cohort_first_at: iso(eligibility.cohort_first_at as Date | string | null),
      cohort_latest_at: iso(eligibility.cohort_latest_at as Date | string | null),
      oldest_eligible_at: iso(eligibility.oldest_eligible_at as Date | string | null),
      oldest_retryable_at: iso(eligibility.oldest_retryable_at as Date | string | null),
      retryable_over_24h: numberValue(eligibility.retryable_over_24h),
    },
    distillation: {
      last_attempt: lastAttempt,
      last_success_at: iso(successRows[0]?.last_success_at),
      provider: {
        circuit_state: circuit?.state ?? 'closed',
        circuit_reason_code: circuitReasonCode(circuit?.reason),
        next_probe_at: iso(circuit?.next_probe_at),
        consecutive_failures: numberValue(circuit?.consecutive_failures),
        calls: {
          prepared: numberValue(calls.prepared),
          inflight: numberValue(calls.inflight),
          result_persisted: numberValue(calls.result_persisted),
          failed: numberValue(calls.failed),
          ambiguous_provider_outcome: numberValue(calls.ambiguous_provider_outcome),
        },
        last_call_at: iso(calls.last_call_at as Date | string | null),
        last_error_class: allowlistedCode(calls.last_error_class, PROVIDER_ERROR_CODES, 'other'),
        usage: {
          input_tokens: numberValue(calls.input_tokens),
          output_tokens: numberValue(calls.output_tokens),
          cache_read_tokens: numberValue(calls.cache_read_tokens),
          cache_creation_tokens: numberValue(calls.cache_creation_tokens),
          estimated_cost_usd: null,
          cost_state: 'unknown_not_durably_recorded',
        },
      },
    },
    generations: {
      total: numberValue(generations.total),
      current_complete: numberValue(generations.current_complete),
      current_building: numberValue(generations.current_building),
      superseded: numberValue(generations.superseded),
      quarantined: numberValue(generations.quarantined),
      unverified_legacy: numberValue(generations.unverified_legacy),
      manifest_gap: numberValue(generations.manifest_gap),
      last_completed_at: lastGenerationAt,
    },
    consolidation: {
      partitions: {
        pending: numberValue(partitions.pending),
        claimed: numberValue(partitions.claimed),
        decided: numberValue(partitions.decided),
        degraded: numberValue(partitions.degraded),
        failed: numberValue(partitions.failed),
        superseded: numberValue(partitions.superseded),
        unverified_legacy: numberValue(partitions.unverified_legacy),
      },
      oldest_retryable_at: iso(partitions.oldest_retryable_at as Date | string | null),
      retryable_over_24h: numberValue(partitions.retryable_over_24h),
      last_decided_at: lastDecisionAt,
      decision_missing: numberValue(partitions.decision_missing),
      legacy_import: {
        completed: legacyCheckpoint?.completed ?? null,
        cursor_updated_at: iso(legacyCursor.updated_at),
        checkpoint_updated_at: iso(legacyCheckpoint?.updated_at),
      },
    },
    decisions: {
      classifications: {
        ADD: numberValue(decisions.add),
        UPDATE: numberValue(decisions.update),
        NOOP: numberValue(decisions.noop),
        NEEDS_REVIEW: numberValue(decisions.needs_review),
      },
      last_at: lastCandidateDecisionAt,
    },
    review: {
      human: {
        count: review.humanPending,
        bytes: review.humanBytes,
        limit: review.pendingLimit,
        oldest_at: review.humanOldestAt?.toISOString() ?? null,
        max_age_hours: review.humanMaxAgeHours,
        age_exceeded: review.humanAgeExceeded,
      },
      staging: {
        count: review.staged,
        bytes: review.stagedBytes,
        count_limit: review.stagingLimit,
        bytes_limit: review.stagingBytesLimit,
        oldest_at: review.stagedOldestAt?.toISOString() ?? null,
        max_age_hours: review.stagingMaxAgeHours,
        age_exceeded: review.stagingAgeExceeded,
      },
      fresh_quota: review.freshQuota,
      reservations: {
        slots: review.reservedSlots,
        bytes: review.reservedBytes,
        historical_slots: review.historicalReservedSlots,
      },
      historical: { human: review.historicalHuman, staging: review.historicalStaged },
      service_window: {
        days: 14,
        observed_days: Number(observedDays.toFixed(3)),
        fresh_arrivals: freshArrivals,
        completed_reviews: completedReviews,
        fresh_arrival_per_day: freshRate == null ? null : Number(freshRate.toFixed(6)),
        review_completion_per_day: serviceRate == null ? null : Number(serviceRate.toFixed(6)),
        margin_state: marginState,
      },
    },
    promotion: {
      candidate_states: {
        pending: numberValue(candidates.pending),
        needs_review: numberValue(candidates.needs_review),
        awaiting_review_capacity: numberValue(candidates.awaiting_review_capacity),
        accepted: numberValue(candidates.accepted),
        rejected: numberValue(candidates.rejected),
      },
      dispatch_frozen: dispatchFrozen,
      promotion_states: {
        accepted_dispatching: numberValue(promotions.accepted_dispatching),
        dispatch_failed: numberValue(promotions.dispatch_failed),
        pr_opened: numberValue(promotions.pr_opened),
        merged_reindexing: numberValue(promotions.merged_reindexing),
        indexing_failed: numberValue(promotions.indexing_failed),
        indexed: numberValue(promotions.indexed),
        unresolved_legacy: numberValue(promotions.unresolved_legacy),
      },
      attempts: {
        total: numberValue(promotions.attempts_total),
        last_at: iso(promotions.last_attempt_at as Date | string | null),
      },
      transition_missing: numberValue(candidates.promotion_transition_missing),
      oldest_accepted_unindexed_at: iso(promotions.oldest_accepted_unindexed_at as Date | string | null),
      last_indexed_at: indexedProgressAt,
      post_approval_indexing_latency_seconds: promotions.last_indexing_latency_seconds == null
        ? null
        : numberValue(promotions.last_indexing_latency_seconds),
      proof_state: indexedProgressAt == null ? 'unknown_no_indexed_transition' : 'recorded',
    },
    progress: {
      last_downstream_at: latestIso([lastGenerationAt, lastDecisionAt, lastCandidateDecisionAt, indexedProgressAt]),
      bootstrap_complete: bootstrapComplete,
      bootstrap_checkpoint_at: iso(reconciliation?.updated_at ?? bootstrapCheckpoint?.updated_at),
      reconciliation_version: reconciliation ? numberValue(reconciliation.version) : null,
      reconciliation_phase: reconciliation?.phase ?? null,
      membership_records: numberValue(reconciliation?.membership_count),
      ambiguous_identity_pages: numberValue(reconciliation?.ambiguous_count),
      cursor_page_id: reconciliation ? numberValue(reconciliation.cursor_page_id) : null,
      scan_upper_page_id: reconciliation ? numberValue(reconciliation.scan_upper_page_id) : null,
      last_tail_at: iso(reconciliation?.last_tail_at),
    },
  };
}

function readinessFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(value), 'utf8')
    .digest('hex');
}

/** Stable, body-free compare-and-set input for recovery-hold release. */
export function buildContextMirrorRecoveryReadiness(
  status: ContextMirrorStatusV1,
  runtimeProofFingerprint: string | null,
  replayLedgerFingerprint: string | null,
): ContextMirrorRecoveryReadiness {
  const blockers: string[] = [];
  if (status.progress.bootstrap_complete !== true) blockers.push('capture_inventory_incomplete');
  if (status.progress.reconciliation_phase !== 'tailing') blockers.push('capture_inventory_not_tailing');
  if (
    status.progress.cursor_page_id !== status.progress.scan_upper_page_id
    || status.progress.membership_records !== status.capture.active_records
  ) blockers.push('capture_membership_mismatch');
  if (status.progress.ambiguous_identity_pages > 0) blockers.push('capture_identity_ambiguous');
  if (status.distillation.provider.calls.ambiguous_provider_outcome > 0) blockers.push('ambiguous_provider_outcome');
  if (status.generations.manifest_gap > 0) blockers.push('generation_manifest_gap');
  if (status.promotion.transition_missing > 0) blockers.push('promotion_transition_missing');
  const promotionNonterminal =
    status.promotion.promotion_states.accepted_dispatching
    + status.promotion.promotion_states.dispatch_failed
    + status.promotion.promotion_states.pr_opened
    + status.promotion.promotion_states.merged_reindexing
    + status.promotion.promotion_states.indexing_failed
    + status.promotion.promotion_states.unresolved_legacy;
  if (promotionNonterminal > 0) blockers.push('promotion_not_terminal');
  if (!runtimeProofFingerprint) blockers.push('runtime_proof_missing');
  if (!replayLedgerFingerprint) blockers.push('replay_ledger_proof_missing');
  blockers.sort();
  const fingerprint = readinessFingerprint({
    schema_version: 1,
    source_id: status.source_id,
    build: status.build,
    recovery_hold: {
      active: status.recovery_hold.active,
      generation: status.recovery_hold.generation,
    },
    capture: {
      active_records: status.capture.active_records,
      membership_records: status.progress.membership_records,
      cursor_page_id: status.progress.cursor_page_id,
      scan_upper_page_id: status.progress.scan_upper_page_id,
      ambiguous_identity_pages: status.progress.ambiguous_identity_pages,
      bootstrap_complete: status.progress.bootstrap_complete,
      reconciliation_phase: status.progress.reconciliation_phase,
    },
    provider_ambiguous: status.distillation.provider.calls.ambiguous_provider_outcome,
    generation_manifest_gap: status.generations.manifest_gap,
    promotion_nonterminal: promotionNonterminal,
    promotion_transition_missing: status.promotion.transition_missing,
    runtime_proof_fingerprint: runtimeProofFingerprint,
    replay_ledger_fingerprint: replayLedgerFingerprint,
    blockers,
  });
  return { ready: blockers.length === 0, blockers, fingerprint };
}

/**
 * Bound every aggregate statement and keep the many stage reads on one
 * consistent snapshot. A timeout is an MCP failure, which the Brain-side
 * health evaluator treats as broken; it can never be mistaken for green.
 */
export async function getContextMirrorStatus(
  engine: BrainEngine,
  sourceId: string,
  now: Date = new Date(),
): Promise<ContextMirrorStatusV1 | null> {
  return engine.transaction(async (tx) => {
    if (engine.kind === 'postgres') {
      await tx.executeRaw("SET LOCAL statement_timeout = '5000'");
      await tx.executeRaw("SET LOCAL lock_timeout = '1000'");
    }
    return readContextMirrorStatusSnapshot(tx, sourceId, now);
  });
}
