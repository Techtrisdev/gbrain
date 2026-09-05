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
      'list_context_mirror_actions',
      'retry_candidate_promotion',
      'rollback_context_generation',
      'run_context_mirror_bootstrap',
      'set_context_mirror_recovery_hold',
    ]) {
      const operation = operationsByName[name];
      expect(operation).toBeDefined();
      expect(operation.scope).toBe('admin');
      expect(operation.mutating).toBe(name !== 'list_context_mirror_actions');
      expect(operation.localOnly).not.toBe(true);
    }
  });

  test('lists bounded free recovery actions with a release fingerprint and no raw identity', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now())`,
    );
    await engine.executeRaw(
      `UPDATE context_mirror_recovery_holds
          SET updated_at = '2026-09-04T12:00:00.123456Z'
        WHERE source_id = 'default'`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id,version,phase,cursor_page_id,scan_upper_page_id,
         membership_count,ambiguous_count,head_count,last_complete_at,last_tail_at
       ) VALUES ('default',2,'tailing',0,0,0,0,0,now(),now())`,
    );
    const result = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      {
        runtime_proof_fingerprint: 'a'.repeat(64),
        replay_ledger_fingerprint: 'b'.repeat(64),
      },
    ) as Record<string, unknown>;
    expect(result).toMatchObject({
      schema_version: 1,
      source_id: 'default',
      action_count: 1,
      ready_to_release: true,
    });
    expect(result.readiness_fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.actions).toEqual([
      expect.objectContaining({
        action: 'release_recovery_hold',
        authority: 'source_admin',
        cost_class: 'free',
        target_count: 1,
        blockers: [],
      }),
    ]);
    expect(JSON.stringify(result)).not.toContain('session_id');
  });

  test('rejects action inventory requests for a different authenticated source', async () => {
    await expect(operationsByName.list_context_mirror_actions!.handler(
      adminContext('other-source'),
      {},
    )).rejects.toThrow('Context Mirror source not found');
  });

  test('releases the recovery hold only with fresh engine and external proof fingerprints', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now())`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id,version,phase,cursor_page_id,scan_upper_page_id,
         membership_count,ambiguous_count,head_count,last_complete_at,last_tail_at
       ) VALUES ('default',2,'tailing',0,0,0,0,0,now(),now())`,
    );
    const proofParams = {
      runtime_proof_fingerprint: 'c'.repeat(64),
      replay_ledger_fingerprint: 'd'.repeat(64),
    };
    const inventory = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), proofParams,
    ) as Record<string, unknown>;
    await expect(operationsByName.set_context_mirror_recovery_hold!.handler(
      adminContext(),
      {
        active: false,
        reason: 'free foundation verified',
        expected_readiness_fingerprint: 'e'.repeat(64),
        ...proofParams,
      },
    )).rejects.toMatchObject({ code: 'stale_precondition' });

    const released = await operationsByName.set_context_mirror_recovery_hold!.handler(
      adminContext(),
      {
        active: false,
        reason: 'free foundation verified',
        expected_readiness_fingerprint: inventory.readiness_fingerprint,
        ...proofParams,
      },
    ) as Record<string, unknown>;
    expect(released).toMatchObject({
      source_id: 'default',
      active: false,
      readiness_fingerprint: inventory.readiness_fingerprint,
    });
    const [audit] = await engine.executeRaw<{ operation: string; outcome: string }>(
      `SELECT operation,outcome FROM context_mirror_admin_audit
        WHERE source_id='default' ORDER BY id DESC LIMIT 1`,
    );
    expect(audit).toEqual({
      operation: 'set_context_mirror_recovery_hold',
      outcome: 'released',
    });
  });

  test('stale release cannot clear a newer recovery hold generation', async () => {
    const operation = operationsByName.set_context_mirror_recovery_hold!;
    await operation.handler(adminContext(), { active: true, reason: 'first repair' });
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id,version,phase,cursor_page_id,scan_upper_page_id,
         membership_count,ambiguous_count,head_count,last_complete_at,last_tail_at
       ) VALUES ('default',2,'tailing',0,0,0,0,0,now(),now())`,
    );
    const proofParams = {
      runtime_proof_fingerprint: '7'.repeat(64),
      replay_ledger_fingerprint: '8'.repeat(64),
    };
    const stale = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), proofParams,
    ) as Record<string, unknown>;
    await operation.handler(adminContext(), {
      active: false,
      reason: 'first release',
      expected_readiness_fingerprint: stale.readiness_fingerprint,
      ...proofParams,
    });
    await operation.handler(adminContext(), { active: true, reason: 'new repair' });
    await expect(operation.handler(adminContext(), {
      active: false,
      reason: 'stale release',
      expected_readiness_fingerprint: stale.readiness_fingerprint,
      ...proofParams,
    })).rejects.toMatchObject({ code: 'stale_precondition' });
    const [hold] = await engine.executeRaw<{ active: boolean }>(
      `SELECT active FROM context_mirror_recovery_holds WHERE source_id='default'`,
    );
    expect(hold?.active).toBe(true);
  });

  test('release refuses when no active recovery hold exists', async () => {
    await expect(operationsByName.set_context_mirror_recovery_hold!.handler(
      adminContext(),
      {
        active: false,
        reason: 'nothing to release',
        expected_readiness_fingerprint: 'a'.repeat(64),
        runtime_proof_fingerprint: 'b'.repeat(64),
        replay_ledger_fingerprint: 'c'.repeat(64),
      },
    )).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  test('bootstrap reconciles active membership after a capture page is deleted', async () => {
    await engine.putPage(
      'capture/deleted-session/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body', timeline: '',
        frontmatter: { session_id: 'deleted-session', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial inventory',
    });
    await engine.deletePage('capture/deleted-session/prompt-1', { sourceId: 'default' });
    const proofParams = {
      runtime_proof_fingerprint: 'd'.repeat(64),
      replay_ledger_fingerprint: 'e'.repeat(64),
    };
    const before = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), proofParams,
    ) as { actions: Array<{ action: string; target_count: number }> };
    expect(before.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 1,
    }));
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'deleted capture reconcile',
    });
    const after = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), proofParams,
    ) as { actions: Array<{ action: string }> };
    expect(after.actions.some((action) => action.action === 'run_context_mirror_bootstrap')).toBe(false);
    const [heads] = await engine.executeRaw<{
      shadow_heads: number | string;
      state: string;
      disposition: string;
    }>(
      `SELECT
         (SELECT count(*) FROM context_mirror_reconciliation_heads
           WHERE source_id = 'default') AS shadow_heads,
         state, disposition
       FROM context_mirror_session_heads
       WHERE source_id = 'default' AND session_id = 'deleted-session'`,
    );
    expect(Number(heads?.shadow_heads)).toBe(1);
    expect(heads).toMatchObject({ state: 'quarantined', disposition: 'v2_membership_missing' });
  });

  test('bootstrap recomputes a surviving head after one capture turn is deleted', async () => {
    for (const turn of [1, 2]) {
      await engine.putPage(
        `capture/partial-deletion/prompt-${turn}`,
        {
          type: 'note', title: 'capture', compiled_truth: `private body ${turn}`, timeline: '',
          frontmatter: { session_id: 'partial-deletion', kind: 'prompt', turn },
        } as never,
        { sourceId: 'default' },
      );
    }
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial inventory',
    });
    await engine.deletePage('capture/partial-deletion/prompt-2', { sourceId: 'default' });
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'partial deletion reconcile',
    });
    const [heads] = await engine.executeRaw<{
      shadow_turns: number | string;
      live_turns: number | string;
      live_state: string;
    }>(
      `SELECT
         (SELECT turn_count FROM context_mirror_reconciliation_heads
           WHERE source_id='default' AND session_id='partial-deletion') AS shadow_turns,
         turn_count AS live_turns, state AS live_state
       FROM context_mirror_session_heads
       WHERE source_id='default' AND session_id='partial-deletion'`,
    );
    expect(Number(heads?.shadow_turns)).toBe(1);
    expect(Number(heads?.live_turns)).toBe(1);
    expect(heads?.live_state).toBe('pending');
  });

  test('bootstrap invalidates an in-flight claim when capture membership changes', async () => {
    for (const turn of [1, 2]) {
      await engine.putPage(
        `capture/claimed-partial-deletion/prompt-${turn}`,
        {
          type: 'note', title: 'capture', compiled_truth: `private body ${turn}`, timeline: '',
          frontmatter: { session_id: 'claimed-partial-deletion', kind: 'prompt', turn },
        } as never,
        { sourceId: 'default' },
      );
    }
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial claimed inventory',
    });
    await engine.executeRaw(
      `UPDATE context_mirror_session_heads
          SET state='claimed', claim_id='claim-before-membership-change',
              lease_expires_at=now() + interval '5 minutes'
        WHERE source_id='default' AND session_id='claimed-partial-deletion'`,
    );
    await engine.deletePage('capture/claimed-partial-deletion/prompt-2', { sourceId: 'default' });

    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000,
      reason: 'invalidate changed claimed inventory',
    });

    const [head] = await engine.executeRaw<{
      turn_count: number | string;
      state: string;
      claim_id: string | null;
      lease_expires_at: string | null;
      current_generation: number | string;
    }>(
      `SELECT turn_count, state, claim_id, lease_expires_at, current_generation
         FROM context_mirror_session_heads
        WHERE source_id='default' AND session_id='claimed-partial-deletion'`,
    );
    expect(Number(head?.turn_count)).toBe(1);
    expect(head?.state).toBe('pending');
    expect(head?.claim_id).toBeNull();
    expect(head?.lease_expires_at).toBeNull();
    expect(Number(head?.current_generation)).toBe(2);
  });

  test('bootstrap preserves an in-flight claim when capture membership is unchanged', async () => {
    await engine.putPage(
      'capture/unchanged-claim/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body', timeline: '',
        frontmatter: { session_id: 'unchanged-claim', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial claim inventory',
    });
    await engine.executeRaw(
      `UPDATE context_mirror_session_heads
          SET state='claimed', claim_id='claim-that-must-survive',
              lease_expires_at=now() + interval '5 minutes'
        WHERE source_id='default' AND session_id='unchanged-claim'`,
    );

    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000,
      reason: 'no-op claimed inventory reconcile',
    });

    const [head] = await engine.executeRaw<{
      state: string;
      claim_id: string | null;
      current_generation: number | string;
    }>(
      `SELECT state, claim_id, current_generation
         FROM context_mirror_session_heads
        WHERE source_id='default' AND session_id='unchanged-claim'`,
    );
    expect(head?.state).toBe('claimed');
    expect(head?.claim_id).toBe('claim-that-must-survive');
    expect(Number(head?.current_generation)).toBe(1);
  });

  test('bootstrap action reports ambiguous captures even when membership counts match', async () => {
    await engine.putPage(
      'capture/ambiguous-session/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body', timeline: '',
        frontmatter: { session_id: -1, kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'inventory ambiguous capture',
    });
    const actions = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      {
        runtime_proof_fingerprint: 'd'.repeat(64),
        replay_ledger_fingerprint: 'e'.repeat(64),
      },
    ) as { actions: Array<{ action: string; target_count: number }> };
    expect(actions.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 1,
    }));
  });

  test('bootstrap action adds independent membership and ambiguity targets', async () => {
    await engine.putPage(
      'capture/deleted-target/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body', timeline: '',
        frontmatter: { session_id: 'deleted-target', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    await engine.putPage(
      'capture/ambiguous-target/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body', timeline: '',
        frontmatter: { session_id: -1, kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial mixed inventory',
    });
    await engine.deletePage('capture/deleted-target/prompt-1', { sourceId: 'default' });
    const actions = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      {
        runtime_proof_fingerprint: 'd'.repeat(64),
        replay_ledger_fingerprint: 'e'.repeat(64),
      },
    ) as { actions: Array<{ action: string; target_count: number }> };
    expect(actions.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 2,
    }));
  });

  test('refuses hold release while engine blockers remain', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now())`,
    );
    const proofParams = {
      runtime_proof_fingerprint: '1'.repeat(64),
      replay_ledger_fingerprint: '2'.repeat(64),
    };
    const inventory = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), proofParams,
    ) as Record<string, unknown>;
    expect(inventory.ready_to_release).toBe(false);
    await expect(operationsByName.set_context_mirror_recovery_hold!.handler(
      adminContext(),
      {
        active: false,
        reason: 'must remain held',
        expected_readiness_fingerprint: inventory.readiness_fingerprint,
        ...proofParams,
      },
    )).rejects.toMatchObject({ code: 'precondition_failed' });
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
