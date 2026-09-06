import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  operationsByName,
  type OperationContext,
} from '../src/core/operations.ts';
import { hasScope, resolveRequiredScope } from '../src/core/scope.ts';
import { registerPromotionHook, toRow } from '../src/core/connectors/candidate.ts';
import { ensurePromotionTransition } from '../src/core/connectors/promotion-state.ts';
import { runSessionHeadReconciliationV2 } from '../src/core/connectors/context-mirror-state.ts';
import { toSessionSlug } from '../src/core/connectors/distill.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { createHmac } from 'node:crypto';

let engine: PGLiteEngine;
let operationEngine: BrainEngine;
const PROOF_SECRET = 'context-mirror-proof-test-secret-at-least-32-bytes';
const GBRAIN_BUILD_SHA = 'b'.repeat(40);
const HOST_BUILD_SHA = 'c'.repeat(40);
const ORIGINAL_PROOF_SECRET = process.env.PROMOTION_HMAC_SECRET;
const ORIGINAL_GBRAIN_BUILD_SHA = process.env.GBRAIN_BUILD_SHA;
const ORIGINAL_HOST_BUILD_SHA = process.env.GBRAIN_HOST_BUILD_SHA;

function proofSignature(attestation: string): string {
  return createHmac('sha256', PROOF_SECRET)
    .update('context-mirror-proof/v1\n', 'utf8')
    .update(attestation, 'utf8')
    .digest('hex');
}

function signedProof(
  kind: 'runtime_inventory' | 'replay_ledger',
  fingerprint: string,
  sourceId = 'default',
  recoveryHoldGeneration = 0,
  observedAt = new Date(),
) {
  const attestation = JSON.stringify({
    evidence_fingerprint: fingerprint,
    gbrain_build_sha: GBRAIN_BUILD_SHA,
    host_build_sha: HOST_BUILD_SHA,
    observed_at: observedAt.toISOString(),
    proof_kind: kind,
    recovery_hold_generation: recoveryHoldGeneration,
    result: 'ok',
    schema_version: 1,
    source_id: sourceId,
  });
  return {
    attestation,
    signature: proofSignature(attestation),
  };
}

function externalProofParams(
  runtimeFingerprint = 'a'.repeat(64),
  replayFingerprint = 'b'.repeat(64),
  recoveryHoldGeneration = 0,
  observedAt = new Date(),
) {
  const runtime = signedProof(
    'runtime_inventory', runtimeFingerprint, 'default', recoveryHoldGeneration, observedAt,
  );
  const replay = signedProof(
    'replay_ledger', replayFingerprint, 'default', recoveryHoldGeneration, observedAt,
  );
  return {
    runtime_proof_attestation: runtime.attestation,
    runtime_proof_signature: runtime.signature,
    replay_ledger_attestation: replay.attestation,
    replay_ledger_signature: replay.signature,
  };
}

beforeAll(async () => {
  process.env.PROMOTION_HMAC_SECRET = PROOF_SECRET;
  process.env.GBRAIN_BUILD_SHA = GBRAIN_BUILD_SHA;
  process.env.GBRAIN_HOST_BUILD_SHA = HOST_BUILD_SHA;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  operationEngine = new Proxy(engine as BrainEngine, {
    get(target, property, receiver) {
      if (property === 'kind') return 'postgres';
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}, 60_000);

afterAll(async () => {
  if (ORIGINAL_PROOF_SECRET === undefined) delete process.env.PROMOTION_HMAC_SECRET;
  else process.env.PROMOTION_HMAC_SECRET = ORIGINAL_PROOF_SECRET;
  if (ORIGINAL_GBRAIN_BUILD_SHA === undefined) delete process.env.GBRAIN_BUILD_SHA;
  else process.env.GBRAIN_BUILD_SHA = ORIGINAL_GBRAIN_BUILD_SHA;
  if (ORIGINAL_HOST_BUILD_SHA === undefined) delete process.env.GBRAIN_HOST_BUILD_SHA;
  else process.env.GBRAIN_HOST_BUILD_SHA = ORIGINAL_HOST_BUILD_SHA;
  registerPromotionHook(null);
  await engine.disconnect();
});

beforeEach(async () => {
  registerPromotionHook(null);
  await resetPgliteState(engine);
});

function adminContext(sourceId = 'default', contextEngine: BrainEngine = operationEngine): OperationContext {
  return {
    engine: contextEngine,
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
      externalProofParams(),
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

  test('keeps readiness stable across fresh tail ticks while blocking stale or missing tails', async () => {
    const proofs = externalProofParams();
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now())`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id,version,phase,cursor_page_id,scan_upper_page_id,
         membership_count,ambiguous_count,head_count,last_complete_at,last_tail_at
       ) VALUES ('default',2,'tailing',0,0,0,0,0,now(),now() - interval '16 minutes')`,
    );

    const stale = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      proofs,
    ) as {
      ready_to_release: boolean;
      readiness_fingerprint: string;
      actions: Array<{
        action: string;
        blockers: string[];
        target_count: number;
        success_proof: string;
      }>;
    };
    expect(stale.ready_to_release).toBe(false);
    expect(stale.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap',
      blockers: expect.arrayContaining(['capture_tail_stale']),
      target_count: 1,
      success_proof: 'bootstrap_complete_membership_conserved_and_tail_fresh',
    }));
    expect(stale.actions).toContainEqual(expect.objectContaining({
      action: 'release_recovery_hold',
      blockers: expect.arrayContaining(['capture_tail_stale']),
    }));

    await engine.executeRaw(
      `UPDATE context_mirror_reconciliation_state
          SET last_tail_at = now()
        WHERE source_id = 'default'`,
    );
    const fresh = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      proofs,
    ) as { ready_to_release: boolean; readiness_fingerprint: string };
    expect(fresh.ready_to_release).toBe(true);
    expect(fresh.readiness_fingerprint).not.toBe(stale.readiness_fingerprint);

    await engine.executeRaw(
      `UPDATE context_mirror_reconciliation_state
          SET last_tail_at = now() - interval '1 minute'
        WHERE source_id = 'default'`,
    );
    const stillFresh = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      proofs,
    ) as { ready_to_release: boolean; readiness_fingerprint: string };
    expect(stillFresh.ready_to_release).toBe(true);
    expect(stillFresh.readiness_fingerprint).toBe(fresh.readiness_fingerprint);

    await engine.executeRaw(
      `UPDATE context_mirror_reconciliation_state
          SET last_tail_at = NULL
        WHERE source_id = 'default'`,
    );
    const missing = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      proofs,
    ) as { ready_to_release: boolean; actions: Array<{ action: string; blockers: string[] }> };
    expect(missing.ready_to_release).toBe(false);
    expect(missing.actions).toContainEqual(expect.objectContaining({
      action: 'release_recovery_hold',
      blockers: expect.arrayContaining(['capture_tail_stale']),
    }));
  });

  test('refuses release while capture, paid distillation, or promotion dispatch is enabled', async () => {
    await engine.executeRaw(
      `UPDATE sources
          SET config = $2::jsonb
        WHERE id = $1`,
      ['default', JSON.stringify({
        connectors: {
          context_mirror: {
            enabled: true,
            distill_before_poll: true,
            consolidation_enabled: true,
          },
        },
      })],
    );
    await engine.setConfig('connectors.promotion_dispatch_frozen', 'false');
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

    const result = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      externalProofParams(),
    ) as {
      ready_to_release: boolean;
      actions: Array<{ action: string; blockers: string[] }>;
    };
    expect(result.ready_to_release).toBe(false);
    expect(result.actions).toContainEqual(expect.objectContaining({
      action: 'release_recovery_hold',
      blockers: expect.arrayContaining([
        'connector_enabled_during_recovery',
        'paid_distillation_enabled_during_recovery',
        'promotion_dispatch_not_frozen',
      ]),
    }));
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
    const proofParams = externalProofParams('c'.repeat(64), 'd'.repeat(64));
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

  test('rejects forged, stale, and wrong-generation recovery proofs', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now() - interval '1 minute')`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id,version,phase,cursor_page_id,scan_upper_page_id,
         membership_count,ambiguous_count,head_count,last_complete_at,last_tail_at
       ) VALUES ('default',2,'tailing',0,0,0,0,0,now(),now())`,
    );

    const forged = externalProofParams();
    forged.runtime_proof_signature = '0'.repeat(64);
    await expect(operationsByName.list_context_mirror_actions!.handler(
      adminContext(), forged,
    )).rejects.toMatchObject({ code: 'precondition_failed' });

    const stale = externalProofParams(
      'a'.repeat(64), 'b'.repeat(64), 0, new Date(Date.now() - 16 * 60_000),
    );
    await expect(operationsByName.list_context_mirror_actions!.handler(
      adminContext(), stale,
    )).rejects.toMatchObject({ code: 'precondition_failed' });

    const wrongGeneration = externalProofParams('a'.repeat(64), 'b'.repeat(64), 7);
    await expect(operationsByName.list_context_mirror_actions!.handler(
      adminContext(), wrongGeneration,
    )).rejects.toMatchObject({ code: 'precondition_failed' });
  });

  test('rejects a correctly signed proof from a different build', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now() - interval '1 minute')`,
    );
    const proof = signedProof('runtime_inventory', 'a'.repeat(64));
    const parsed = JSON.parse(proof.attestation) as Record<string, unknown>;
    parsed.gbrain_build_sha = 'd'.repeat(40);
    const wrongBuildArtifact = JSON.stringify(parsed);
    await expect(operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      {
        runtime_proof_attestation: wrongBuildArtifact,
        runtime_proof_signature: proofSignature(wrongBuildArtifact),
      },
    )).rejects.toMatchObject({ code: 'precondition_failed' });
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
    const proofParams = externalProofParams('7'.repeat(64), '8'.repeat(64), 1);
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
    })).rejects.toMatchObject({ code: 'precondition_failed' });
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
        ...externalProofParams('b'.repeat(64), 'c'.repeat(64)),
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
    const before = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), {},
    ) as { actions: Array<{ action: string; target_count: number }> };
    expect(before.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 1,
    }));
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'deleted capture reconcile',
    });
    const after = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), {},
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

  test('bootstrap preserves a non-reconciliation quarantine when membership is unchanged', async () => {
    await engine.putPage(
      'capture/rejected-session/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body', timeline: '',
        frontmatter: { session_id: 'rejected-session', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial rejected inventory',
    });
    await engine.executeRaw(
      `UPDATE context_mirror_session_heads
          SET state='quarantined', disposition='session_rejected'
        WHERE source_id='default' AND session_id='rejected-session'`,
    );

    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000,
      reason: 'no-op rejected inventory reconcile',
    });

    const [head] = await engine.executeRaw<{
      state: string;
      disposition: string;
      current_generation: number | string;
    }>(
      `SELECT state, disposition, current_generation FROM context_mirror_session_heads
        WHERE source_id='default' AND session_id='rejected-session'`,
    );
    expect(head).toEqual({
      state: 'quarantined',
      disposition: 'session_rejected',
      current_generation: 1,
    });
  });

  test('bootstrap advances a pending head generation when captured membership changes', async () => {
    for (const turn of [1, 2]) {
      await engine.putPage(
        `capture/pending-generation/prompt-${turn}`,
        {
          type: 'note', title: 'capture', compiled_truth: `private body ${turn}`, timeline: '',
          frontmatter: { session_id: 'pending-generation', kind: 'prompt', turn },
        } as never,
        { sourceId: 'default' },
      );
    }
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial pending generation',
    });
    await engine.executeRaw(
      `INSERT INTO context_mirror_generations (
         source_id,session_id,generation,input_hash,transform_version,model,state,is_current
       ) VALUES ('default','pending-generation',1,'old-input','v2','test','building',true)`,
    );
    await engine.deletePage('capture/pending-generation/prompt-2', { sourceId: 'default' });

    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000,
      reason: 'changed pending generation inventory',
    });

    const [head] = await engine.executeRaw<{ state: string; current_generation: number | string }>(
      `SELECT state, current_generation FROM context_mirror_session_heads
        WHERE source_id='default' AND session_id='pending-generation'`,
    );
    expect(head?.state).toBe('pending');
    expect(Number(head?.current_generation)).toBe(2);
  });

  test('bootstrap detects an aggregate-neutral capture replacement by exact page identity', async () => {
    const capturedAt = '2026-09-04T12:00:00.000Z';
    await engine.putPage(
      'capture/exact-membership/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body one', timeline: '',
        frontmatter: { session_id: 'exact-membership', kind: 'prompt', turn: 1, captured_at: capturedAt },
      } as never,
      { sourceId: 'default' },
    );
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial exact identity',
    });
    const [before] = await engine.executeRaw<{ capture_membership_ids: unknown }>(
      `SELECT capture_membership_ids FROM context_mirror_session_heads
        WHERE source_id='default' AND session_id='exact-membership'`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_generations (
         source_id,session_id,generation,input_hash,transform_version,model,state,is_current
       ) VALUES ('default','exact-membership',1,'old-input','v2','test','building',true)`,
    );
    await engine.deletePage('capture/exact-membership/prompt-1', { sourceId: 'default' });
    await engine.putPage(
      'capture/exact-membership/reply-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body two', timeline: '',
        frontmatter: { session_id: 'exact-membership', kind: 'reply', turn: 1, captured_at: capturedAt },
      } as never,
      { sourceId: 'default' },
    );

    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000,
      reason: 'replace exact capture identity',
    });

    const [after] = await engine.executeRaw<{
      capture_membership_ids: unknown;
      current_generation: number | string;
      turn_count: number | string;
    }>(
      `SELECT capture_membership_ids,current_generation,turn_count
         FROM context_mirror_session_heads
        WHERE source_id='default' AND session_id='exact-membership'`,
    );
    expect(after?.capture_membership_ids).not.toEqual(before?.capture_membership_ids);
    expect(Number(after?.turn_count)).toBe(1);
    expect(Number(after?.current_generation)).toBe(2);
  });

  test('action inventory detects equal-count capture membership replacement', async () => {
    await engine.putPage(
      'capture/replaced-a/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body a', timeline: '',
        frontmatter: { session_id: 'replaced-a', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial replace inventory',
    });
    await engine.deletePage('capture/replaced-a/prompt-1', { sourceId: 'default' });
    await engine.putPage(
      'capture/replaced-b/prompt-1',
      {
        type: 'note', title: 'capture', compiled_truth: 'private body b', timeline: '',
        frontmatter: { session_id: 'replaced-b', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: 'default' },
    );

    const result = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), {},
    ) as { actions: Array<{ action: string; target_count: number }> };
    expect(result.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 2,
    }));
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
      {},
    ) as { actions: Array<{ action: string; target_count: number }> };
    expect(actions.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 1,
    }));
  });

  test('bootstrap action reports a bounded target for combined membership and ambiguity repair', async () => {
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
    await engine.softDeletePage('capture/deleted-target/prompt-1', { sourceId: 'default' });
    const actions = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(),
      {},
    ) as { actions: Array<{ action: string; target_count: number }> };
    expect(actions.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 1,
    }));
  });

  test('refuses hold release while engine blockers remain', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now())`,
    );
    const proofParams = externalProofParams('1'.repeat(64), '2'.repeat(64));
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

  test('refuses hold release while capture ownership conflicts remain quarantined', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now())`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id,version,phase,cursor_page_id,scan_upper_page_id,
         membership_count,ambiguous_count,head_count,last_complete_at,last_tail_at
       ) VALUES ('default',2,'tailing',0,0,0,0,1,now(),now())`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_reconciliation_heads (
         source_id,session_id,session_slug,capture_slug_prefix,newest_capture_at,
         turn_count,state,disposition
       ) VALUES (
         'default','opaque-session','opaque-session','capture/opaque-session/',now(),
         1,'quarantined','locator_ownership_conflict'
       )`,
    );

    const inventory = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), externalProofParams('3'.repeat(64), '4'.repeat(64)),
    ) as {
      ready_to_release: boolean;
      actions: Array<{ action: string; blockers: string[] }>;
    };
    const statusResult = await operationsByName.context_mirror_status.handler(
      adminContext(), { source_id: 'default' },
    ) as { progress: { locator_ownership_conflicts: number } };

    expect(inventory.ready_to_release).toBe(false);
    expect(statusResult.progress.locator_ownership_conflicts).toBe(1);
    expect(inventory.actions).toContainEqual(expect.objectContaining({
      action: 'release_recovery_hold',
      blockers: expect.arrayContaining(['capture_locator_ownership_conflict']),
    }));
    expect(inventory.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap',
      target_count: 1,
    }));
  });

  test('detects an equal-count restore and delete until live head IDs are rebuilt', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_recovery_holds (
         source_id,active,reason,acted_by,held_at
       ) VALUES ('default',true,'repair','test',now())`,
    );
    for (const turn of [1, 2]) {
      await engine.putPage(
        `capture/projection-session/prompt-${turn}`,
        {
          type: 'note', title: 'capture', compiled_truth: `private body ${turn}`, timeline: '',
          frontmatter: { session_id: 'projection-session', kind: 'prompt', turn },
        } as never,
        { sourceId: 'default' },
      );
    }
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'initial projection',
    });
    await engine.softDeletePage('capture/projection-session/prompt-2', { sourceId: 'default' });
    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'record deletion',
    });
    await engine.restorePage('capture/projection-session/prompt-2', { sourceId: 'default' });
    await engine.softDeletePage('capture/projection-session/prompt-1', { sourceId: 'default' });

    const proofParams = externalProofParams('5'.repeat(64), '6'.repeat(64));
    const before = await operationsByName.list_context_mirror_actions!.handler(
      adminContext(), proofParams,
    ) as {
      ready_to_release: boolean;
      actions: Array<{ action: string; target_count: number }>;
    };
    const beforeStatus = await operationsByName.context_mirror_status.handler(
      adminContext(), { source_id: 'default' },
    ) as {
      capture: { active_records: number };
      progress: {
        membership_records: number;
        unreconciled_active_records: number;
        cursor_page_id: number;
        scan_upper_page_id: number;
        head_projection_mismatch_records: number;
      };
    };
    expect(before.ready_to_release).toBe(false);
    expect(beforeStatus.capture.active_records).toBe(beforeStatus.progress.membership_records);
    expect(beforeStatus.progress.unreconciled_active_records).toBe(0);
    expect(beforeStatus.progress.cursor_page_id).toBe(beforeStatus.progress.scan_upper_page_id);
    expect(beforeStatus.progress.head_projection_mismatch_records).toBe(2);
    expect(before.actions).toContainEqual(expect.objectContaining({
      action: 'run_context_mirror_bootstrap', target_count: 2,
    }));
    expect(JSON.stringify(before)).not.toContain('projection-session');
    expect(JSON.stringify(beforeStatus)).not.toContain('private body');

    await operationsByName.run_context_mirror_bootstrap!.handler(adminContext(), {
      batch_size: 10, max_batches: 2, max_runtime_ms: 5_000, reason: 'rebuild exact projection',
    });
    const afterStatus = await operationsByName.context_mirror_status.handler(
      adminContext(), { source_id: 'default' },
    ) as { progress: { head_projection_mismatch_records: number } };
    expect(afterStatus.progress.head_projection_mismatch_records).toBe(0);
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

  test('an expired reconciliation deadline mutates no recovery state', async () => {
    await expect(runSessionHeadReconciliationV2(operationEngine, {
      sourceId: 'default',
      now: new Date(),
      idleHours: 6,
      sessionSlug: toSessionSlug,
      batchSize: 10,
      deadlineAtMs: Date.now() - 1,
      actor: 'test',
      reason: 'expired before mutation',
    })).rejects.toMatchObject({ code: 'CONTEXT_MIRROR_OPERATION_TIMEOUT' });
    const [counts] = await engine.executeRaw<{ state_count: number | string; audit_count: number | string }>(
      `SELECT
         (SELECT count(*) FROM context_mirror_reconciliation_state) AS state_count,
         (SELECT count(*) FROM context_mirror_admin_audit) AS audit_count`,
    );
    expect(Number(counts?.state_count)).toBe(0);
    expect(Number(counts?.audit_count)).toBe(0);
  });

  test('a deadline waits for transaction settlement and never reports a committed write as failed', async () => {
    let transactionCalls = 0;
    let finalTransactionSettled = false;
    const delayedCommitEngine = new Proxy(operationEngine, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
            transactionCalls += 1;
            const result = await target.transaction(fn);
            if (transactionCalls === 3) {
              await new Promise((resolve) => setTimeout(resolve, 1_300));
              finalTransactionSettled = true;
            }
            return result;
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const startedAt = Date.now();
    const result = await runSessionHeadReconciliationV2(delayedCommitEngine, {
      sourceId: 'default',
      now: new Date(),
      idleHours: 6,
      sessionSlug: toSessionSlug,
      batchSize: 10,
      deadlineAtMs: Date.now() + 1_100,
      actor: 'test',
      reason: 'await transaction settlement',
    });
    expect(result.status).toBe('complete');
    expect(finalTransactionSettled).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_250);
  });

  test('rejects bounded bootstrap on the non-interruptible embedded engine before mutation', async () => {
    const startedAt = Date.now();
    await expect(operationsByName.run_context_mirror_bootstrap!.handler(
      adminContext('default', engine),
      {
        batch_size: 10,
        max_batches: 1,
        max_runtime_ms: 1_000,
        reason: 'embedded engines must fail closed',
      },
    )).rejects.toMatchObject({ code: 'unsupported_engine' });
    expect(Date.now() - startedAt).toBeLessThan(700);
    const [counts] = await engine.executeRaw<{ state_count: number | string; audit_count: number | string }>(
      `SELECT
         (SELECT count(*) FROM context_mirror_reconciliation_state) AS state_count,
         (SELECT count(*) FROM context_mirror_admin_audit) AS audit_count`,
    );
    expect(Number(counts?.state_count)).toBe(0);
    expect(Number(counts?.audit_count)).toBe(0);
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
