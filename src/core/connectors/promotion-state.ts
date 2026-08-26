import type { BrainEngine } from '../engine.ts';
import type { ConnectorCandidateRow } from './candidate.ts';
import { compiledTruthHash, resolveConsolidationSearchSource } from './consolidate.ts';

export const PROMOTION_DISPATCH_FREEZE_KEY = 'connectors.promotion_dispatch_frozen';

export type PromotionLifecycleState =
  | 'accepted_dispatching'
  | 'dispatch_failed'
  | 'pr_opened'
  | 'merged_reindexing'
  | 'indexing_failed'
  | 'indexed'
  | 'unresolved_legacy';

export type PromotionDurableStage = 'accepted' | 'pr_opened' | 'merged_reindexing' | 'indexed';
export type PromotionNextAction =
  | 'dispatch'
  | 'reconcile_dispatch'
  | 'await_pr_opened'
  | 'await_merge'
  | 'retry_indexing'
  | 'review_stale_update'
  | 'resolve_legacy'
  | 'none';

export interface PromotionTransitionRow {
  candidate_id: number | string;
  source_id: string;
  correlation_id: string;
  identity_version: number | string;
  state: PromotionLifecycleState;
  last_durable_stage: PromotionDurableStage;
  failure_code: string | null;
  next_action: PromotionNextAction;
  attempt_count: number | string;
  last_attempt_at: Date | string | null;
  callback_received_at: Date | string | null;
  accepted_at: Date | string;
  pr_opened_at: Date | string | null;
  merged_at: Date | string | null;
  indexed_at: Date | string | null;
  pr_url: string | null;
  branch: string | null;
  merge_sha: string | null;
  workflow_run_id: string | null;
}

export interface PromotionCallbackMetadata {
  prUrl?: string | null;
  branch?: string | null;
  mergeSha?: string | null;
  workflowRunId?: string | null;
  failureCode?: string | null;
}

export interface PromotionTransitionResult {
  candidateId: number;
  correlationId: string;
  state: PromotionLifecycleState;
  outcome: 'applied' | 'stale';
}

export class PromotionRetryError extends Error {
  constructor(public readonly code: 'not_retryable' | 'stale_update_target' | 'transition_missing') {
    super(code);
    this.name = 'PromotionRetryError';
  }
}

export function promotionCorrelationId(
  candidate: Pick<ConnectorCandidateRow, 'id' | 'context_generation'>,
): string {
  const id = Number(candidate.id);
  const generation = Number(candidate.context_generation ?? 0);
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('promotion correlation requires safe candidate and generation integers');
  }
  return `cm-promo-v2-c${id}-g${generation}`;
}

export async function promotionDispatchFrozen(engine: BrainEngine): Promise<boolean> {
  try {
    const value = await engine.getConfig(PROMOTION_DISPATCH_FREEZE_KEY);
    if (value == null) return true;
    return !['false', '0'].includes(value.trim().toLowerCase());
  } catch {
    return true;
  }
}

export async function ensurePromotionTransition(
  engine: BrainEngine,
  candidate: Pick<ConnectorCandidateRow, 'id' | 'source_id' | 'context_generation' | 'acted_at' | 'proposed_at'>,
): Promise<PromotionTransitionRow> {
  const correlationId = promotionCorrelationId(candidate as Pick<ConnectorCandidateRow, 'id' | 'context_generation'>);
  const acceptedAt = candidate.acted_at ?? candidate.proposed_at;
  const rows = await engine.executeRaw<PromotionTransitionRow>(
    `WITH inserted AS (
       INSERT INTO connector_promotion_transitions (
         candidate_id, source_id, correlation_id, state, last_durable_stage,
         next_action, accepted_at
       ) VALUES ($1,$2,$3,'accepted_dispatching','accepted','dispatch',$4)
       ON CONFLICT (candidate_id) DO NOTHING
       RETURNING *
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT * FROM connector_promotion_transitions
      WHERE candidate_id = $1 AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`,
    [candidate.id, candidate.source_id, correlationId, acceptedAt],
  );
  const row = rows[0];
  if (!row || row.source_id !== candidate.source_id || row.correlation_id !== correlationId) {
    throw new Error('promotion transition identity conflict');
  }
  return row;
}

export async function readPromotionTransitionByCandidate(
  engine: BrainEngine,
  candidateId: number,
): Promise<PromotionTransitionRow | null> {
  const rows = await engine.executeRaw<PromotionTransitionRow>(
    `SELECT * FROM connector_promotion_transitions WHERE candidate_id = $1`,
    [candidateId],
  );
  return rows[0] ?? null;
}

export async function readPromotionTransitionByCorrelation(
  engine: BrainEngine,
  correlationId: string,
): Promise<PromotionTransitionRow | null> {
  const rows = await engine.executeRaw<PromotionTransitionRow>(
    `SELECT * FROM connector_promotion_transitions WHERE correlation_id = $1`,
    [correlationId],
  );
  return rows[0] ?? null;
}

function fixedDispatchError(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('frozen')) return 'dispatch_frozen';
  if (message.includes('credential') || message.includes('token') || message.includes('private key') || message.includes('secret')) return 'dispatch_auth';
  if (/status=(401|403)/.test(message)) return 'dispatch_permission';
  if (/status=4\d\d/.test(message)) return 'dispatch_request_rejected';
  if (/status=5\d\d/.test(message)) return 'dispatch_remote_failure';
  if (/timeout|network|fetch|socket|connection/.test(message)) return 'dispatch_outcome_unknown';
  return 'dispatch_failed';
}

export async function recordPromotionDispatchBlocked(
  engine: BrainEngine,
  candidateId: number,
  reasonCode: 'dispatch_frozen' | 'dispatch_hook_unavailable' | 'dispatch_hook_failed' | 'stale_update_target',
): Promise<void> {
  await engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<PromotionTransitionRow>(
      `SELECT * FROM connector_promotion_transitions WHERE candidate_id = $1 FOR UPDATE`,
      [candidateId],
    );
    const row = rows[0];
    if (!row || row.state === 'indexed') return;
    if (reasonCode === 'dispatch_hook_failed' && row.state !== 'accepted_dispatching') return;
    const nextAction: PromotionNextAction = reasonCode === 'stale_update_target'
      ? 'review_stale_update'
      : reasonCode === 'dispatch_frozen' ? 'reconcile_dispatch' : 'dispatch';
    await tx.executeRaw(
      `UPDATE connector_promotion_transitions
          SET state = 'dispatch_failed', failure_code = $2, next_action = $3, updated_at = now()
        WHERE candidate_id = $1`,
      [candidateId, reasonCode, nextAction],
    );
    await tx.executeRaw(
      `INSERT INTO connector_promotion_events (
         candidate_id, correlation_id, event_type, from_state, requested_state,
         resulting_state, outcome, reason_code
       ) VALUES ($1,$2,'dispatch',$3,'dispatch_failed','dispatch_failed','rejected',$4)`,
      [candidateId, row.correlation_id, row.state, reasonCode],
    );
  });
}

export async function beginPromotionDispatchAttempt(
  engine: BrainEngine,
  candidateId: number,
  actor: string,
): Promise<{ attemptNo: number; correlationId: string }> {
  return engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<PromotionTransitionRow>(
      `SELECT * FROM connector_promotion_transitions WHERE candidate_id = $1 FOR UPDATE`,
      [candidateId],
    );
    const row = rows[0];
    if (!row) throw new PromotionRetryError('transition_missing');
    if (row.state !== 'accepted_dispatching') throw new PromotionRetryError('not_retryable');
    const attemptNo = Number(row.attempt_count) + 1;
    await tx.executeRaw(
      `UPDATE connector_promotion_transitions
          SET attempt_count = $2, last_attempt_at = now(), failure_code = NULL,
              next_action = 'await_pr_opened', updated_at = now()
        WHERE candidate_id = $1 AND state = 'accepted_dispatching'`,
      [candidateId, attemptNo],
    );
    await tx.executeRaw(
      `INSERT INTO connector_promotion_attempts (
         candidate_id, correlation_id, attempt_no, outcome, actor
       ) VALUES ($1,$2,$3,'prepared',$4)`,
      [candidateId, row.correlation_id, attemptNo, actor.slice(0, 120)],
    );
    return { attemptNo, correlationId: row.correlation_id };
  });
}

export async function finishPromotionDispatchAttempt(
  engine: BrainEngine,
  candidateId: number,
  attemptNo: number,
  error?: unknown,
): Promise<void> {
  const errorCode = error == null ? null : fixedDispatchError(error);
  await engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<PromotionTransitionRow>(
      `SELECT * FROM connector_promotion_transitions WHERE candidate_id = $1 FOR UPDATE`,
      [candidateId],
    );
    const row = rows[0];
    if (!row) throw new PromotionRetryError('transition_missing');
    await tx.executeRaw(
      `UPDATE connector_promotion_attempts
          SET outcome = $3, error_code = $4, finished_at = now()
        WHERE candidate_id = $1 AND attempt_no = $2 AND outcome = 'prepared'`,
      [candidateId, attemptNo, errorCode == null ? 'succeeded' : 'failed', errorCode],
    );
    const failureCanApply = errorCode != null && row.state !== 'indexed';
    const resultingState: PromotionLifecycleState = failureCanApply ? 'dispatch_failed' : row.state;
    if (failureCanApply) {
      await tx.executeRaw(
        `UPDATE connector_promotion_transitions
            SET state = 'dispatch_failed', failure_code = $2,
                next_action = $3, updated_at = now()
          WHERE candidate_id = $1`,
        [candidateId, errorCode, errorCode === 'dispatch_outcome_unknown' ? 'reconcile_dispatch' : 'dispatch'],
      );
      await tx.executeRaw(
        `UPDATE connector_candidates SET promotion_status = 'failed' WHERE id = $1`,
        [candidateId],
      );
    }
    await tx.executeRaw(
      `INSERT INTO connector_promotion_events (
         candidate_id, correlation_id, event_type, from_state, requested_state,
         resulting_state, outcome, reason_code
       ) VALUES ($1,$2,'dispatch',$3,$4,$5,$6,$7)`,
      [candidateId, row.correlation_id, row.state,
        errorCode == null ? 'accepted_dispatching' : 'dispatch_failed', resultingState,
        errorCode != null && !failureCanApply ? 'stale' : 'applied', errorCode],
    );
  });
}

const ALLOWED_CALLBACK_TRANSITIONS: Record<PromotionLifecycleState, ReadonlySet<PromotionLifecycleState>> = {
  accepted_dispatching: new Set(['accepted_dispatching', 'dispatch_failed', 'pr_opened', 'merged_reindexing', 'indexed']),
  dispatch_failed: new Set(['dispatch_failed', 'pr_opened', 'merged_reindexing', 'indexed']),
  pr_opened: new Set(['pr_opened', 'merged_reindexing', 'indexing_failed', 'indexed']),
  merged_reindexing: new Set(['merged_reindexing', 'indexing_failed', 'indexed']),
  indexing_failed: new Set(['indexing_failed', 'merged_reindexing', 'indexed']),
  indexed: new Set(['indexed']),
  unresolved_legacy: new Set(['unresolved_legacy']),
};

function stageFor(state: PromotionLifecycleState): PromotionDurableStage {
  if (state === 'indexed') return 'indexed';
  if (state === 'merged_reindexing' || state === 'indexing_failed') return 'merged_reindexing';
  if (state === 'pr_opened') return 'pr_opened';
  return 'accepted';
}

function actionFor(state: PromotionLifecycleState): PromotionNextAction {
  if (state === 'accepted_dispatching') return 'await_pr_opened';
  if (state === 'dispatch_failed') return 'dispatch';
  if (state === 'pr_opened') return 'await_merge';
  if (state === 'merged_reindexing') return 'retry_indexing';
  if (state === 'indexing_failed') return 'retry_indexing';
  if (state === 'unresolved_legacy') return 'resolve_legacy';
  return 'none';
}

function compatibilityStatus(state: PromotionLifecycleState): string | null {
  if (state === 'pr_opened' || state === 'merged_reindexing') return 'pr_opened';
  if (state === 'indexed') return 'indexed';
  if (state === 'dispatch_failed' || state === 'indexing_failed') return 'failed';
  return null;
}

export async function applyPromotionCallbackTransition(
  engine: BrainEngine,
  correlationId: string,
  requestedState: PromotionLifecycleState,
  metadata: PromotionCallbackMetadata = {},
): Promise<PromotionTransitionResult | null> {
  return engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<PromotionTransitionRow>(
      `SELECT * FROM connector_promotion_transitions WHERE correlation_id = $1 FOR UPDATE`,
      [correlationId],
    );
    const row = rows[0];
    if (!row) return null;
    const candidateId = Number(row.candidate_id);
    const allowed = ALLOWED_CALLBACK_TRANSITIONS[row.state].has(requestedState);
    if (!allowed) {
      await tx.executeRaw(
        `UPDATE connector_promotion_transitions
            SET callback_received_at = now(), updated_at = now()
          WHERE candidate_id = $1`,
        [candidateId],
      );
      await tx.executeRaw(
        `INSERT INTO connector_promotion_events (
           candidate_id, correlation_id, event_type, from_state, requested_state,
           resulting_state, outcome, reason_code
         ) VALUES ($1,$2,'callback',$3,$4,$3,'stale','out_of_order_callback')`,
        [candidateId, correlationId, row.state, requestedState],
      );
      return { candidateId, correlationId, state: row.state, outcome: 'stale' };
    }

    const failureCode = requestedState === 'dispatch_failed' || requestedState === 'indexing_failed'
      ? metadata.failureCode ?? (requestedState === 'dispatch_failed' ? 'brain_reported_dispatch_failure' : 'brain_reported_indexing_failure')
      : null;
    await tx.executeRaw(
      `UPDATE connector_promotion_transitions
          SET state = $2,
              last_durable_stage = $3,
              failure_code = $4,
              next_action = $5,
              callback_received_at = now(),
              pr_opened_at = CASE WHEN $2 IN ('pr_opened','merged_reindexing','indexing_failed','indexed')
                                  THEN COALESCE(pr_opened_at, now()) ELSE pr_opened_at END,
              merged_at = CASE WHEN $2 IN ('merged_reindexing','indexing_failed','indexed')
                               THEN COALESCE(merged_at, now()) ELSE merged_at END,
              indexed_at = CASE WHEN $2 = 'indexed' THEN COALESCE(indexed_at, now()) ELSE indexed_at END,
              pr_url = COALESCE($6, pr_url),
              branch = COALESCE($7, branch),
              merge_sha = COALESCE($8, merge_sha),
              workflow_run_id = COALESCE($9, workflow_run_id),
              updated_at = now()
        WHERE candidate_id = $1`,
      [candidateId, requestedState, stageFor(requestedState), failureCode, actionFor(requestedState),
        metadata.prUrl ?? null, metadata.branch ?? null, metadata.mergeSha ?? null, metadata.workflowRunId ?? null],
    );
    const compat = compatibilityStatus(requestedState);
    if (compat != null) {
      await tx.executeRaw(
        `UPDATE connector_candidates
            SET promotion_status = $2,
                promotion_pr_url = COALESCE($3, promotion_pr_url),
                promotion_branch = COALESCE($4, promotion_branch),
                promoted_at = CASE WHEN $2 IN ('pr_opened','indexed') THEN COALESCE(promoted_at, now()) ELSE promoted_at END
          WHERE id = $1`,
        [candidateId, compat, metadata.prUrl ?? null, metadata.branch ?? null],
      );
    }
    await tx.executeRaw(
      `INSERT INTO connector_promotion_events (
         candidate_id, correlation_id, event_type, from_state, requested_state,
         resulting_state, outcome, reason_code
       ) VALUES ($1,$2,'callback',$3,$4,$4,'applied',$5)`,
      [candidateId, correlationId, row.state, requestedState, failureCode],
    );
    return { candidateId, correlationId, state: requestedState, outcome: 'applied' };
  });
}

export async function assertPromotionRetryFresh(
  engine: BrainEngine,
  candidate: Pick<ConnectorCandidateRow, 'id' | 'target_kind' | 'target_path' | 'base_compiled_hash'>,
): Promise<void> {
  if (candidate.target_kind !== 'update_page') return;
  const targetPath = candidate.target_path ?? '';
  const expectedHash = candidate.base_compiled_hash ?? '';
  const slug = targetPath.endsWith('.md') ? targetPath.slice(0, -3) : targetPath;
  const sourceId = await resolveConsolidationSearchSource(engine);
  const page = slug ? await engine.getPage(slug, { sourceId }) : null;
  if (!page || compiledTruthHash(page.compiled_truth) !== expectedHash) {
    await recordPromotionDispatchBlocked(engine, Number(candidate.id), 'stale_update_target');
    throw new PromotionRetryError('stale_update_target');
  }
}

export async function preparePromotionRetry(
  engine: BrainEngine,
  candidateId: number,
): Promise<PromotionTransitionRow> {
  return engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<PromotionTransitionRow>(
      `SELECT * FROM connector_promotion_transitions WHERE candidate_id = $1 FOR UPDATE`,
      [candidateId],
    );
    const row = rows[0];
    if (!row) throw new PromotionRetryError('transition_missing');
    if (row.state !== 'dispatch_failed' || row.next_action === 'review_stale_update') {
      throw new PromotionRetryError('not_retryable');
    }
    await tx.executeRaw(
      `UPDATE connector_promotion_transitions
          SET state = 'accepted_dispatching', failure_code = NULL, next_action = 'dispatch', updated_at = now()
        WHERE candidate_id = $1 AND state = 'dispatch_failed'`,
      [candidateId],
    );
    await tx.executeRaw(
      `INSERT INTO connector_promotion_events (
         candidate_id, correlation_id, event_type, from_state, requested_state,
         resulting_state, outcome
       ) VALUES ($1,$2,'retry','dispatch_failed','accepted_dispatching','accepted_dispatching','applied')`,
      [candidateId, row.correlation_id],
    );
    return { ...row, state: 'accepted_dispatching', failure_code: null, next_action: 'dispatch' };
  });
}
