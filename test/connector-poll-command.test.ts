/**
 * gbrain connector poll — target resolution. The command is a thin I/O shell
 * over resolveConnectorPollTargets, which routes to either an explicit
 * (source, provider) pair or the autopilot's enabled-connector selection
 * (selectEnabledConnectorSources). This covers that routing + the usage guard.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  connectorPollSummary,
  parseContextMirrorTailArgs,
  parseGenerationRollbackArgs,
  parseTargetedConsolidationArgs,
  pollConnectorTargets,
  resolveConnectorPollTargets,
} from '../src/commands/connector.ts';
import {
  ContextMirrorReconciliationTimeoutError,
} from '../src/core/connectors/context-mirror-state.ts';
import {
  runBoundedContextMirrorReconciliation,
  toBoundedContextMirrorReconciliationWireReport,
} from '../src/core/connectors/context-mirror-reconcile.ts';

describe('Context Mirror no-provider tail command', () => {
  test('requires an explicit source, reason, and bounded work envelope', () => {
    expect(parseContextMirrorTailArgs([
      '--source', 'capture-events',
      '--batch-size', '1000',
      '--max-batches', '2',
      '--max-runtime-ms', '30000',
      '--reason', 'scheduled no-provider tail',
      '--json',
    ])).toEqual({
      sourceId: 'capture-events',
      batchSize: 1_000,
      maxBatches: 2,
      maxRuntimeMs: 30_000,
      reason: 'scheduled no-provider tail',
      json: true,
    });

    expect(() => parseContextMirrorTailArgs([])).toThrow(/required/);
    expect(() => parseContextMirrorTailArgs([
      '--source', 'capture-events', '--batch-size', '0', '--max-batches', '1',
      '--max-runtime-ms', '30000', '--reason', 'scheduled tail',
    ])).toThrow(/batch-size/);
    expect(() => parseContextMirrorTailArgs([
      '--source', 'capture-events', '--batch-size', '1', '--max-batches', '21',
      '--max-runtime-ms', '30000', '--reason', 'scheduled tail',
    ])).toThrow(/max-batches/);
    expect(() => parseContextMirrorTailArgs([
      '--source', 'capture-events', '--batch-size', '1', '--max-batches', '1',
      '--max-runtime-ms', '45001', '--reason', 'scheduled tail',
    ])).toThrow(/max-runtime-ms/);
    expect(() => parseContextMirrorTailArgs([
      '--source', 'capture-events', '--batch-size', '1', '--max-batches', '1',
      '--max-runtime-ms', '30000', '--reason', 'scheduled tail', '--unknown', 'x',
    ])).toThrow(/unknown/);
  });

  test('aggregates bounded batches and can never report provider use', async () => {
    const statuses = ['partial', 'complete'] as const;
    let calls = 0;
    const report = await runBoundedContextMirrorReconciliation(
      { kind: 'postgres' } as Parameters<typeof runBoundedContextMirrorReconciliation>[0],
      {
        sourceId: 'capture-events',
        batchSize: 1_000,
        maxBatches: 2,
        maxRuntimeMs: 30_000,
        actor: 'railway-context-mirror-tail',
        reason: 'scheduled no-provider tail',
      },
      {
        now: () => new Date('2026-09-05T12:00:00Z'),
        nowMs: () => 1_000,
        runBatch: async () => {
          const status = statuses[calls++]!;
          return {
            status,
            schemaVersion: 2,
            scanned: 10,
            insertedMembership: 8,
            membership: 100 + calls,
            ambiguousIdentityPages: 0,
            totalHeads: 20,
            pendingEligible: 5,
            cursorPageId: 100 + calls,
            scanUpperPageId: 102,
            leaseGeneration: calls,
            resumeFingerprint: String(calls).repeat(64),
          };
        },
        sessionSlug: (sessionId) => sessionId,
      },
    );

    expect(calls).toBe(2);
    expect(report).toMatchObject({
      schemaVersion: 2,
      sourceId: 'capture-events',
      status: 'complete',
      batches: 2,
      scanned: 20,
      insertedMembership: 16,
      membership: 102,
      providerCalls: 0,
    });
    expect(toBoundedContextMirrorReconciliationWireReport(report)).toEqual({
      schema_version: 2,
      source_id: 'capture-events',
      status: 'complete',
      batches: 2,
      scanned: 20,
      inserted_membership: 16,
      membership: 102,
      ambiguous_identity_pages: 0,
      total_heads: 20,
      pending_eligible: 5,
      cursor_page_id: 102,
      scan_upper_page_id: 102,
      lease_generation: 2,
      resume_fingerprint: '2'.repeat(64),
      provider_calls: 0,
    });
  });

  test('admits a first batch at the minimum runtime when the clock advances', async () => {
    const clock = [1_000, 1_001];
    let calls = 0;
    const report = await runBoundedContextMirrorReconciliation(
      { kind: 'postgres' } as Parameters<typeof runBoundedContextMirrorReconciliation>[0],
      {
        sourceId: 'capture-events',
        batchSize: 1,
        maxBatches: 1,
        maxRuntimeMs: 2_000,
        actor: 'railway-context-mirror-tail',
        reason: 'minimum runtime tail',
      },
      {
        nowMs: () => clock.shift()!,
        runBatch: async () => {
          calls += 1;
          return {
            status: 'complete',
            schemaVersion: 2,
            scanned: 1,
            insertedMembership: 1,
            membership: 1,
            ambiguousIdentityPages: 0,
            totalHeads: 1,
            pendingEligible: 0,
            cursorPageId: 1,
            scanUpperPageId: 1,
            leaseGeneration: 1,
            resumeFingerprint: 'a'.repeat(64),
          };
        },
      },
    );

    expect(calls).toBe(1);
    expect(report).toMatchObject({ status: 'complete', batches: 1, scanned: 1, providerCalls: 0 });
  });

  test('reports committed progress when a later batch reaches its deadline', async () => {
    const clock = [0, 1, 28_000];
    let calls = 0;
    const report = await runBoundedContextMirrorReconciliation(
      { kind: 'postgres' } as Parameters<typeof runBoundedContextMirrorReconciliation>[0],
      {
        sourceId: 'capture-events',
        batchSize: 10,
        maxBatches: 2,
        maxRuntimeMs: 30_000,
        actor: 'railway-context-mirror-tail',
        reason: 'deadline-bound tail',
      },
      {
        nowMs: () => clock.shift()!,
        runBatch: async () => {
          calls += 1;
          if (calls === 2) {
            throw new ContextMirrorReconciliationTimeoutError(
              'context mirror reconciliation has insufficient time to acquire a lease',
            );
          }
          return {
            status: 'partial',
            schemaVersion: 2,
            scanned: 10,
            insertedMembership: 8,
            membership: 108,
            ambiguousIdentityPages: 1,
            totalHeads: 20,
            pendingEligible: 5,
            cursorPageId: 110,
            scanUpperPageId: 120,
            leaseGeneration: 1,
            resumeFingerprint: 'b'.repeat(64),
          };
        },
      },
    );

    expect(calls).toBe(2);
    expect(report).toMatchObject({
      status: 'partial',
      batches: 1,
      scanned: 10,
      insertedMembership: 8,
      membership: 108,
      cursorPageId: 110,
      providerCalls: 0,
    });
  });
});

describe('targeted consolidation command safety flags', () => {
  test('requires an exact generation and finite provider envelope', () => {
    expect(parseTargetedConsolidationArgs([
      '--source', 'capture-events',
      '--session-id', 'opaque-session-001',
      '--generation', '1',
      '--max-partitions', '2',
      '--max-calls', '3',
      '--max-cost-usd', '0.10',
      '--max-runtime-ms', '60000',
      '--budget-audit-path', 'D:/BrainProof/consolidation-budget.jsonl',
      '--json',
    ])).toMatchObject({
      sourceId: 'capture-events',
      sessionId: 'opaque-session-001',
      generation: 1,
      maxPartitions: 2,
      maxCalls: 3,
      maxCostUsd: 0.1,
      maxRuntimeMs: 60_000,
      budgetAuditPath: 'D:/BrainProof/consolidation-budget.jsonl',
      json: true,
    });
  });

  test('rejects missing, unknown, non-finite, and unbounded inputs', () => {
    expect(() => parseTargetedConsolidationArgs([])).toThrow(/required/);
    expect(() => parseTargetedConsolidationArgs(['--typo', 'x'])).toThrow(/unknown/);
    expect(() => parseTargetedConsolidationArgs([
      '--source', 'capture-events', '--session-id', 's', '--generation', '0',
      '--max-partitions', '1', '--max-calls', '1', '--max-cost-usd', '0.1',
      '--max-runtime-ms', '1', '--budget-audit-path', 'D:/proof.jsonl',
    ])).toThrow(/generation/);
    expect(() => parseTargetedConsolidationArgs([
      '--source', 'capture-events', '--session-id', 's', '--generation', '1',
      '--max-partitions', '1', '--max-calls', 'Infinity', '--max-cost-usd', '0.1',
      '--max-runtime-ms', '1', '--budget-audit-path', 'D:/proof.jsonl',
    ])).toThrow(/max-calls/);
  });
});

describe('historical generation rollback command', () => {
  test('requires one exact source, session, current generation, and prior generation', () => {
    expect(parseGenerationRollbackArgs([
      '--source', 'capture-events', '--session-id', 'opaque-session',
      '--generation', '3', '--rollback-generation', '2', '--json',
    ])).toEqual({
      sourceId: 'capture-events', sessionId: 'opaque-session',
      generation: 3, rollbackGeneration: 2, json: true,
    });
    expect(() => parseGenerationRollbackArgs([])).toThrow(/required/);
    expect(() => parseGenerationRollbackArgs([
      '--source', 'capture-events', '--session-id', 's',
      '--generation', '2', '--rollback-generation', '0',
    ])).toThrow(/finite integer/);
  });
});

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  // One ENABLED connector source (foo) + one with a DISABLED connector (bar).
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('conn-on', 'conn-on', $1)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
    [JSON.stringify({ connectors: { foo: { enabled: true } } })],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('conn-off', 'conn-off', $1)
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`,
    [JSON.stringify({ connectors: { bar: { enabled: false } } })],
  );
});
afterAll(async () => { await engine.disconnect(); });

describe('resolveConnectorPollTargets', () => {
  test('no flags → selects ONLY enabled connector targets', async () => {
    const { targets, error } = await resolveConnectorPollTargets(engine, {});
    expect(error).toBeUndefined();
    expect(targets).toContainEqual({ sourceId: 'conn-on', provider: 'foo' });
    // a disabled connector is never a target; a no-connector source contributes none
    expect(targets.find((t) => t.provider === 'bar')).toBeUndefined();
  });

  test('explicit --source + --provider → exactly that target (bypasses DB selection)', async () => {
    const { targets, error } = await resolveConnectorPollTargets(engine, { source: 'whatever', provider: 'granola' });
    expect(error).toBeUndefined();
    expect(targets).toEqual([{ sourceId: 'whatever', provider: 'granola' }]);
  });

  test('--source without --provider → usage error, no targets', async () => {
    const { targets, error } = await resolveConnectorPollTargets(engine, { source: 'x' });
    expect(error).toBeTruthy();
    expect(targets).toEqual([]);
  });

  test('--provider without --source → usage error', async () => {
    const { error } = await resolveConnectorPollTargets(engine, { provider: 'granola' });
    expect(error).toBeTruthy();
  });
});

describe('connector poll result aggregation', () => {
  test('continues after one target throws and produces a final nonzero summary', async () => {
    const targets = [
      { sourceId: 'broken', provider: 'context_mirror' },
      { sourceId: 'healthy', provider: 'calendar' },
    ];
    const called: string[] = [];
    const results = await pollConnectorTargets(engine, targets, async (_engine, target) => {
      called.push(target.sourceId);
      if (target.sourceId === 'broken') throw new Error('provider unavailable');
      return { sourceId: target.sourceId, provider: target.provider, status: 'ok', landed: 2, tombstoned: 0 };
    });

    expect(called).toEqual(['broken', 'healthy']);
    expect(results[0]).toMatchObject({ status: 'failed', landed: 0 });
    expect(results[1]).toMatchObject({ status: 'ok', landed: 2 });
    expect(connectorPollSummary(results)).toMatchObject({ status: 'failed', exitCode: 1, landed: 2 });
  });
});
