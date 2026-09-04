import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { hasScope, resolveRequiredScope } from '../src/core/scope.ts';
import { registerPromotionHook, toRow } from '../src/core/connectors/candidate.ts';
import { ensurePromotionTransition } from '../src/core/connectors/promotion-state.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  registerPromotionHook(null);
  await engine.disconnect();
});

beforeEach(async () => {
  registerPromotionHook(null);
  await resetPgliteState(engine);
});

function adminContext(sourceId = 'default'): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: true,
    sourceId,
    auth: {
      token: 'redacted-test-token',
      clientId: 'admin-client',
      scopes: ['admin'],
      sourceId,
      allowedSources: [sourceId],
    },
  };
}

describe('Context Mirror admin MCP controls', () => {
  test('are remote-visible admin mutations and never ordinary read/write tools', () => {
    for (const name of [
      'retry_candidate_promotion',
      'rollback_context_generation',
      'run_context_mirror_bootstrap',
      'set_context_mirror_recovery_hold',
    ]) {
      const operation = operationsByName[name];
      expect(operation).toBeDefined();
      expect(operation.scope).toBe('admin');
      expect(operation.mutating).toBe(true);
      expect(operation.localOnly).not.toBe(true);
    }
  });

  test('HTTP scope resolution rejects read/write tokens and accepts admin', () => {
    const operation = operationsByName.set_context_mirror_recovery_hold!;
    const required = resolveRequiredScope(operation);
    expect(required).toBe('admin');
    expect(hasScope(['read'], required)).toBe(false);
    expect(hasScope(['write'], required)).toBe(false);
    expect(hasScope(['admin'], required)).toBe(true);
  });

  test('fails closed when authenticated and routed sources disagree', async () => {
    const context = adminContext('default');
    context.sourceId = 'other-source';
    await expect(operationsByName.set_context_mirror_recovery_hold!.handler(
      context,
      { active: true, reason: 'source mismatch' },
    )).rejects.toMatchObject({ code: 'permission_denied' });
  });

  test('runs a bounded counts-only v2 bootstrap in the authenticated source', async () => {
    await engine.putPage(
      'capture/admin-session/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private transcript body', timeline: '',
        frontmatter: { session_id: 'admin-session', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    const operation = operationsByName.run_context_mirror_bootstrap!;
    const result = await operation.handler(adminContext(), {
      batch_size: 10,
      max_batches: 2,
      max_runtime_ms: 5_000,
      reason: 'bounded metadata recovery',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      schema_version: 2,
      source_id: 'default',
      status: 'complete',
      scanned: 1,
      membership: 1,
      total_heads: 1,
      provider_calls: 0,
    });
    expect(JSON.stringify(result)).not.toContain('private transcript body');
    expect(JSON.stringify(result)).not.toContain('admin-session');
  });

  test('rejects unbounded bootstrap limits before touching state', async () => {
    await expect(operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 50_001,
      max_batches: 2,
      max_runtime_ms: 5_000,
      reason: 'invalid oversized request',
    })).rejects.toMatchObject({ code: 'invalid_params' });
    const state = await engine.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM context_mirror_reconciliation_state`,
    );
    expect(Number(state[0]?.count ?? 0)).toBe(0);
  });

  test('returns a resumable partial result when the request batch cap is reached', async () => {
    for (const [index, sessionId] of ['bounded-a', 'bounded-b'].entries()) {
      await engine.putPage(
        `capture/${sessionId}/prompt-1`,
        {
          type: 'note', title: 'capture', compiled_truth: `body-${index}`, timeline: '',
          frontmatter: { session_id: sessionId, kind: 'prompt', turn: 1 },
        } as never,
        { sourceId: 'default' },
      );
    }
    const result = await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 1,
      max_batches: 1,
      max_runtime_ms: 5_000,
      reason: 'bounded partial request',
    }) as Record<string, unknown>;
    expect(result).toMatchObject({
      status: 'partial',
      batches: 1,
      scanned: 1,
      membership: 1,
      provider_calls: 0,
    });
    expect(result.resume_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    const [projection] = await engine.executeRaw<{
      shadow_heads: number | string;
      live_heads: number | string;
    }>(
      `SELECT
         (SELECT count(*) FROM context_mirror_reconciliation_heads WHERE source_id = 'default') AS shadow_heads,
         (SELECT count(*) FROM context_mirror_session_heads WHERE source_id = 'default') AS live_heads`,
    );
    expect(Number(projection?.shadow_heads)).toBe(1);
    expect(Number(projection?.live_heads)).toBe(0);
  });

  test('sets and idempotently re-reads an attributed source recovery hold', async () => {
    const operation = operationsByName.set_context_mirror_recovery_hold!;
    const first = await operation.handler(
      adminContext(),
      { active: true, reason: 'bounded repair' },
    ) as Record<string, unknown>;
    const second = await operation.handler(
      adminContext(),
      { active: true, reason: 'bounded repair' },
    ) as Record<string, unknown>;
    expect(first).toMatchObject({
      source_id: 'default',
      active: true,
      reason: 'bounded repair',
      acted_by: 'mcp:admin-client',
    });
    expect(second.updated_at).toBe(first.updated_at);
  });

  test('retries only an accepted candidate in the authenticated source and records the operator reason', async () => {
    const { row } = await toRow(engine, {
      source_id: 'default',
      source_record_id: 'admin-retry',
      provider: 'context_mirror',
      proposed_markdown: '# Admin retry',
      status: 'accepted',
      target_kind: 'new_page',
      target_path: 'playbooks/admin-retry.md',
      context_generation: 2,
    });
    await ensurePromotionTransition(engine, row);
    await engine.executeRaw(
      `UPDATE connector_promotion_transitions
          SET state='dispatch_failed', failure_code='dispatch_hook_failed', next_action='reconcile_dispatch'
        WHERE candidate_id=$1`,
      [row.id],
    );

    const result = await operationsByName.retry_candidate_promotion!.handler(
      adminContext(),
      { candidate_id: row.id, reason: 'operator confirmed no prior dispatch' },
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      source_id: 'default',
      candidate_id: row.id,
      candidate_status: 'accepted',
      dispatch_invoked: false,
      dispatch_pending: true,
      dispatch_error: 'dispatch_hook_unavailable',
    });
    const [event] = await engine.executeRaw<{ actor: string; reason: string }>(
      `SELECT actor,reason FROM connector_promotion_events
        WHERE candidate_id=$1 AND event_type='retry' ORDER BY id DESC LIMIT 1`,
      [row.id],
    );
    expect(event).toEqual({
      actor: 'mcp:admin-client',
      reason: 'operator confirmed no prior dispatch',
    });
  });

  test('rolls back one verified generation transactionally and repeats as an idempotent proof read', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_session_heads (
         source_id,session_id,session_slug,capture_slug_prefix,newest_capture_at,
         turn_count,current_generation,state
       ) VALUES ('default','repair-session','repair-session','capture/repair-session/',now(),2,2,'complete')`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_generations (
         source_id,session_id,generation,input_hash,transform_version,model,
         state,is_current,requires_human_review,completed_at
       ) VALUES
         ('default','repair-session',1,'old','v1','test','superseded',false,false,now()),
         ('default','repair-session',2,'new','v2','test','complete',true,true,now())`,
    );
    const params = {
      session_id: 'repair-session',
      generation: 2,
      rollback_generation: 1,
      reason: 'transcript evidence rejected generation two',
    };
    const operation = operationsByName.rollback_context_generation!;
    const first = await operation.handler(adminContext(), params) as Record<string, unknown>;
    const second = await operation.handler(adminContext(), params) as Record<string, unknown>;
    expect(first).toMatchObject({
      status: 'rolled_back',
      source_id: 'default',
      actor: 'mcp:admin-client',
      verification: {
        current_generation: 1,
        rolled_back_generation_state: 'superseded',
        restored_generation_state: 'complete',
      },
    });
    expect(second).toMatchObject({
      status: 'already_rolled_back',
      rolled_back_at: first.rolled_back_at,
    });
  });
});
