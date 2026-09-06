import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  OperationError,
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import type { ContextMirrorStatusV1 } from '../src/core/connectors/context-mirror-status.ts';
import { toRow } from '../src/core/connectors/candidate.ts';
import {
  applyPromotionCallbackTransition,
  ensurePromotionTransition,
} from '../src/core/connectors/promotion-state.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function context(sourceId = 'default', allowedSources: string[] = [sourceId]): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: console,
    dryRun: false,
    remote: true,
    sourceId,
    auth: {
      token: 'redacted-test-token',
      clientId: 'status-reader',
      scopes: ['read'],
      sourceId,
      allowedSources,
    },
  };
}

async function configureSource(sourceId: string, extra: Record<string, unknown> = {}): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET config = $2::jsonb WHERE id = $1`,
    [sourceId, JSON.stringify({
      connectors: {
        context_mirror: {
          enabled: true,
          distill_before_poll: true,
          consolidation_enabled: true,
          ...extra,
        },
      },
    })],
  );
}

async function status(ctx: OperationContext, sourceId: string): Promise<ContextMirrorStatusV1> {
  return await operationsByName.context_mirror_status.handler(ctx, { source_id: sourceId }) as ContextMirrorStatusV1;
}

describe('context_mirror_status read contract', () => {
  test('is an HTTP-visible, non-mutating read operation with an explicit source', () => {
    const op = operationsByName.context_mirror_status;
    expect(op).toBeDefined();
    expect(op.scope).toBe('read');
    expect(op.mutating).toBe(false);
    expect(op.localOnly).not.toBe(true);
    expect(op.params.source_id).toMatchObject({ type: 'string', required: true });
  });

  test('returns exact 501-row aggregates without list_pages and leaks no stored content or free-form errors', async () => {
    await configureSource('default');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('other-source','other-source',$1::jsonb)`,
      [JSON.stringify({ connectors: { context_mirror: { enabled: true } } })],
    );
    await engine.executeRaw(
      `INSERT INTO pages (
         source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, updated_at
       )
       SELECT 'default',
              'capture/session-' || lpad(i::text, 3, '0') || '/turn-1',
              'note', 'private title',
              'RAW_PROMPT_SECRET_SENTINEL_' || i::text,
              'RAW_REPLY_SECRET_SENTINEL',
              jsonb_build_object('session_id','PRIVATE_SESSION_SENTINEL_' || i::text),
              'default-hash-' || i::text,
              now()
         FROM generate_series(1,501) AS i`,
    );
    await engine.executeRaw(
      `INSERT INTO pages (
         source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, updated_at
       )
       SELECT 'other-source',
              'capture/foreign-' || i::text || '/turn-1',
              'note', 'foreign', 'FOREIGN_BODY_SENTINEL', '', '{}'::jsonb,
              'other-hash-' || i::text, now()
         FROM generate_series(1,17) AS i`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_checkpoints (source_id, checkpoint_kind, cursor, completed)
       VALUES ('default','capture_session_scan_v1','{}'::jsonb,true)`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_circuits (
         source_id, provider, state, reason, error_fingerprint, consecutive_failures
       ) VALUES (
         'default','chat','open','API key RAW_CIRCUIT_SECRET_SENTINEL','opaque',1
       )`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id, active, reason, held_at
       ) VALUES ('default',true,'RAW_HOLD_SECRET_SENTINEL',now())`,
    );

    const result = await status(context('default', ['default', 'other-source']), 'default');

    expect(result.schema_version).toBe(1);
    expect(result.source_id).toBe('default');
    expect(result.capture.active_records).toBe(501);
    expect(result.external_proof).toEqual({
      runtime_coverage: 'unknown',
      outbox_delivery: 'unknown',
      retrieval_consumers: 'unknown',
      reason: 'not_recorded_in_gbrain_v1',
    });
    expect(result.recovery_hold.reason_code).toBe('operator_recovery_hold');
    expect(result.distillation.provider.circuit_reason_code).toBe('authentication');
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      'RAW_PROMPT_SECRET_SENTINEL',
      'RAW_REPLY_SECRET_SENTINEL',
      'PRIVATE_SESSION_SENTINEL',
      'FOREIGN_BODY_SENTINEL',
      'RAW_CIRCUIT_SECRET_SENTINEL',
      'RAW_HOLD_SECRET_SENTINEL',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('distinguishes healthy idle from a broken, aged, provider-blocked backlog', async () => {
    await configureSource('default');
    await engine.executeRaw(
      `INSERT INTO context_mirror_checkpoints (source_id, checkpoint_kind, cursor, completed)
       VALUES ('default','capture_session_scan_v1','{}'::jsonb,true)`,
    );
    const idle = await status(context(), 'default');
    expect(idle.overall).toEqual({ state: 'idle', reason_codes: ['no_eligible_work'], next_action: null });
    expect(idle.review.service_window.margin_state).toBe('idle');

    await engine.executeRaw(
      `INSERT INTO context_mirror_session_heads (
         source_id, session_id, session_slug, capture_slug_prefix, newest_capture_at,
         turn_count, first_eligible_at, cohort_at, current_eligible_at, current_cohort_at, state
       ) VALUES (
         'default','PRIVATE_SESSION_SECRET','private-session','capture/private-session/',
         now() - INTERVAL '3 days',2,now() - INTERVAL '2 days',now() - INTERVAL '2 days',
         now() - INTERVAL '2 days',now() - INTERVAL '2 days','pending'
       )`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_distill_runs (
         run_id, source_id, status, stop_reason, selected_count, failed_count, started_at, finished_at
       ) VALUES (
         'run-secret','default','failed','systemic_failure',1,1,now() - INTERVAL '1 hour',now() - INTERVAL '1 hour'
       )`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_provider_calls (
         correlation_id, run_id, source_id, session_id, generation, state,
         request_fingerprint, error_class, error_message
       ) VALUES (
         'correlation-secret','run-secret','default','PRIVATE_SESSION_SECRET',1,'failed',
         'fingerprint-secret','RAW_ERROR_CLASS_SECRET','RAW_PROVIDER_MESSAGE_SECRET'
       )`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_circuits (
         source_id, provider, state, reason, error_fingerprint,
         consecutive_failures, opened_at, next_probe_at
       ) VALUES (
         'default','chat','open','insufficient credits RAW_PROVIDER_SECRET','fingerprint',
         1,now(),now() + INTERVAL '1 hour'
       )`,
    );

    const broken = await status(context(), 'default');
    expect(broken.overall.state).toBe('broken');
    expect(broken.overall.reason_codes).toContain('provider_circuit_open');
    expect(broken.overall.reason_codes).toContain('retryable_work_over_24h');
    expect(broken.eligibility.retryable_over_24h).toBe(1);
    expect(broken.distillation.provider.last_error_class).toBe('other');
    expect(broken.distillation.provider.circuit_reason_code).toBe('billing');
    const serialized = JSON.stringify(broken);
    expect(serialized).not.toContain('PRIVATE_SESSION_SECRET');
    expect(serialized).not.toContain('RAW_ERROR_CLASS_SECRET');
    expect(serialized).not.toContain('RAW_PROVIDER_MESSAGE_SECRET');
    expect(serialized).not.toContain('RAW_PROVIDER_SECRET');
  });

  test('reports a completed v2 inventory as broken when its no-provider tail is stale', async () => {
    await configureSource('default');
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id,version,phase,cursor_page_id,scan_upper_page_id,
         membership_count,ambiguous_count,head_count,last_complete_at,last_tail_at
       ) VALUES ('default',2,'tailing',0,0,0,0,0,now(),now() - interval '16 minutes')`,
    );

    const stale = await status(context(), 'default');
    expect(stale.overall).toEqual({
      state: 'broken',
      reason_codes: ['capture_tail_stale'],
      next_action: 'run_context_mirror_bootstrap',
    });

    await engine.executeRaw(
      `UPDATE context_mirror_reconciliation_state SET last_tail_at = now() WHERE source_id = 'default'`,
    );
    const fresh = await status(context(), 'default');
    expect(fresh.overall).toEqual({ state: 'idle', reason_codes: ['no_eligible_work'], next_action: null });
  });

  test('requires one allowed source and never returns an unlabeled federated aggregate', async () => {
    await configureSource('default');
    await engine.executeRaw(
      `INSERT INTO sources (id, name, config)
       VALUES ('other-source','other-source',$1::jsonb)`,
      [JSON.stringify({ connectors: { context_mirror: { enabled: true } } })],
    );
    await engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash)
       SELECT 'other-source','capture/other/' || i::text,'note','x','x','','{}'::jsonb,'h-' || i::text
         FROM generate_series(1,17) AS i`,
    );

    const federatedCredential = context('default', ['default', 'other-source']);
    const other = await status(federatedCredential, 'other-source');
    expect(other.source_id).toBe('other-source');
    expect(other.capture.active_records).toBe(17);

    await expect(status(context('default', ['default']), 'other-source')).rejects.toBeInstanceOf(OperationError);

    const missing = await dispatchToolCall(engine, 'context_mirror_status', {}, {
      remote: true,
      sourceId: 'default',
      auth: context().auth,
    });
    expect(missing.isError).toBe(true);
    expect(JSON.parse(missing.content[0].text)).toMatchObject({ error: 'invalid_params' });

    const forced = await dispatchToolCall(engine, 'context_mirror_status', { source_id: 'other-source' }, {
      remote: true,
      sourceId: 'default',
      auth: context('default', ['default']).auth,
    });
    expect(forced.isError).toBe(true);
    expect(JSON.parse(forced.content[0].text)).toMatchObject({ error: 'permission_denied' });
  });

  test('reports the durable promotion ledger instead of inferring PR or index success', async () => {
    await configureSource('default');
    await engine.executeRaw(
      `INSERT INTO context_mirror_checkpoints (source_id, checkpoint_kind, cursor, completed)
       VALUES ('default','capture_session_scan_v1','{}'::jsonb,true)`,
    );
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'status-promotion',
      provider: 'context_mirror',
      proposed_markdown: '# Promotion status evidence',
      status: 'accepted',
      context_generation: 3,
    });
    const missing = await status(context(), 'default');
    expect(missing.promotion.transition_missing).toBe(1);
    expect(missing.overall.reason_codes).toContain('promotion_transition_missing');
    const transition = await ensurePromotionTransition(engine, row);

    const waiting = await status(context(), 'default');
    expect(waiting.promotion.dispatch_frozen).toBe(true);
    expect(waiting.promotion.promotion_states.accepted_dispatching).toBe(1);
    expect(waiting.promotion.last_indexed_at).toBeNull();
    expect(waiting.promotion.proof_state).toBe('unknown_no_indexed_transition');
    expect(waiting.overall.reason_codes).toContain('promotion_dispatch_frozen_with_work');

    await applyPromotionCallbackTransition(engine, transition.correlation_id, 'indexed', {
      mergeSha: 'c'.repeat(40),
      workflowRunId: '123',
    });
    const indexed = await status(context(), 'default');
    expect(indexed.promotion.promotion_states.indexed).toBe(1);
    expect(indexed.promotion.last_indexed_at).not.toBeNull();
    expect(indexed.promotion.post_approval_indexing_latency_seconds).toBeGreaterThanOrEqual(0);
    expect(indexed.promotion.proof_state).toBe('recorded');
  });

  test('a failed promotion dispatch is broken even when every capture queue is empty', async () => {
    await configureSource('default');
    await engine.setConfig('connectors.promotion_dispatch_frozen', 'false');
    await engine.executeRaw(
      `INSERT INTO context_mirror_checkpoints (source_id, checkpoint_kind, cursor, completed)
       VALUES ('default','capture_session_scan_v1','{}'::jsonb,true)`,
    );
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'failed-dispatch-status',
      provider: 'context_mirror',
      proposed_markdown: '# Failed dispatch',
      status: 'accepted',
      context_generation: 2,
    });
    await ensurePromotionTransition(engine, row);
    await engine.executeRaw(
      `UPDATE connector_promotion_transitions
          SET state = 'dispatch_failed', failure_code = 'dispatch_outcome_unknown',
              next_action = 'reconcile_dispatch'
        WHERE candidate_id = $1`,
      [row.id],
    );

    const result = await status(context(), 'default');
    expect(result.overall).toEqual({
      state: 'broken',
      reason_codes: ['promotion_dispatch_failed'],
      next_action: 'reconcile_or_retry_failed_promotion_dispatch',
    });
  });

  test('review service margin is fail-closed after 14 days and accepts the exact 1.2 boundary', async () => {
    await configureSource('default');
    await engine.executeRaw(
      `INSERT INTO context_mirror_checkpoints (source_id, checkpoint_kind, cursor, completed)
       VALUES ('default','capture_session_scan_v1','{}'::jsonb,true)`,
    );
    const anchor = await toRow(engine, {
      source_id: 'default', source_record_id: 'service-anchor', provider: 'context_mirror',
      proposed_markdown: 'historical anchor', requires_human_review: true, status: 'rejected',
    });
    await engine.executeRaw(
      `UPDATE connector_candidates SET proposed_at = now() - INTERVAL '15 days',
              acted_at = now() - INTERVAL '15 days'
        WHERE id = $1`,
      [anchor.row.id],
    );
    for (let index = 0; index < 2; index++) {
      await toRow(engine, {
        source_id: 'default', source_record_id: `fresh-pending-${index}`, provider: 'context_mirror',
        proposed_markdown: 'fresh pending work', requires_human_review: false, status: 'pending',
      });
    }
    const insufficient = await status(context(), 'default');
    expect(insufficient.review.service_window.margin_state).toBe('insufficient');
    expect(insufficient.overall.state).toBe('degraded');
    expect(insufficient.overall.reason_codes).toContain('review_service_margin_insufficient');

    await engine.executeRaw(
      `UPDATE connector_candidates SET status = 'rejected', acted_at = now()
        WHERE source_id = 'default' AND source_record_id LIKE 'fresh-pending-%'`,
    );
    for (let index = 0; index < 3; index++) {
      const fresh = await toRow(engine, {
        source_id: 'default', source_record_id: `fresh-complete-${index}`, provider: 'context_mirror',
        proposed_markdown: 'fresh completed work', requires_human_review: false, status: 'rejected',
      });
      await engine.executeRaw(`UPDATE connector_candidates SET acted_at = now() WHERE id = $1`, [fresh.row.id]);
    }
    const historical = await toRow(engine, {
      source_id: 'default', source_record_id: 'historical-complete', provider: 'context_mirror',
      proposed_markdown: 'historical completed work', requires_human_review: true, status: 'rejected',
    });
    await engine.executeRaw(`UPDATE connector_candidates SET acted_at = now() WHERE id = $1`, [historical.row.id]);

    const boundary = await status(context(), 'default');
    expect(boundary.review.service_window.fresh_arrivals).toBe(5);
    expect(boundary.review.service_window.completed_reviews).toBe(6);
    expect(boundary.review.service_window.margin_state).toBe('sufficient');
    expect(boundary.overall.reason_codes).not.toContain('review_service_margin_insufficient');
  });
});
