import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { BrainEngine } from '../src/core/engine.ts';
import {
  parseContextMirrorTailArgs,
  runConnector,
  type ContextMirrorTailCommandRuntime,
} from '../src/commands/connector.ts';
import type { BoundedContextMirrorReconciliationReport } from '../src/core/connectors/context-mirror-reconcile.ts';

const engine = { kind: 'postgres' } as BrainEngine;
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function sourceRow(id = 'capture-events') {
  return {
    id,
    name: id,
    local_path: null,
    last_commit: null,
    last_sync_at: null,
    config: { token: 'must-not-be-printed' },
    created_at: new Date('2026-09-05T12:00:00Z'),
  };
}

function report(status: 'complete' | 'partial'): BoundedContextMirrorReconciliationReport {
  return {
    schemaVersion: 2,
    sourceId: 'capture-events',
    status,
    batches: 1,
    scanned: 12,
    insertedMembership: 10,
    membership: 42,
    ambiguousIdentityPages: 0,
    totalHeads: 7,
    pendingEligible: 2,
    cursorPageId: 12,
    scanUpperPageId: 12,
    leaseGeneration: 3,
    resumeFingerprint: 'a'.repeat(64),
    providerCalls: 0,
  };
}

function commandRuntime(overrides: Partial<ContextMirrorTailCommandRuntime> = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCodes: number[] = [];
  const runtime: ContextMirrorTailCommandRuntime = {
    fetchSource: async () => sourceRow(),
    reconcile: async () => report('complete'),
    writeStdout: (text) => { stdout.push(text); },
    writeStderr: (text) => { stderr.push(text); },
    setExitCode: (code) => { exitCodes.push(code); },
    ...overrides,
  };
  return { runtime, stdout, stderr, exitCodes };
}

const validArgs = [
  'tail-context-mirror',
  '--source', 'capture-events',
  '--batch-size', '1000',
  '--max-batches', '2',
  '--max-runtime-ms', '30000',
  '--reason', 'scheduled no-provider tail',
  '--json',
];

describe('connector tail-context-mirror command boundary', () => {
  test.each([['--help'], ['-h']])('%s prints useful help without a database and succeeds', async (flag) => {
    let fetched = false;
    const harness = commandRuntime({
      fetchSource: async () => {
        fetched = true;
        return null;
      },
    });

    await runConnector(null, ['tail-context-mirror', flag], harness.runtime);

    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stderr).toEqual([]);
    expect(harness.stdout.join('')).toContain('tail-context-mirror options:');
    expect(harness.stdout.join('')).toContain('--max-runtime-ms <2000-45000>');
    expect(fetched).toBe(false);
  });

  test('dispatches an exact source and emits a stable JSON success report', async () => {
    const fetchedSources: string[] = [];
    const reconciliationOptions: unknown[] = [];
    const harness = commandRuntime({
      fetchSource: async (_engine, sourceId) => {
        fetchedSources.push(sourceId);
        return sourceRow(sourceId);
      },
      reconcile: async (_engine, options) => {
        reconciliationOptions.push(options);
        return report('complete');
      },
    });

    await runConnector(engine, validArgs, harness.runtime);

    expect(fetchedSources).toEqual(['capture-events']);
    expect(reconciliationOptions).toEqual([{
      sourceId: 'capture-events',
      batchSize: 1_000,
      maxBatches: 2,
      maxRuntimeMs: 30_000,
      actor: 'context-mirror-tail-cli',
      reason: 'scheduled no-provider tail',
    }]);
    expect(harness.exitCodes).toEqual([0]);
    expect(harness.stderr).toEqual([]);
    expect(JSON.parse(harness.stdout.join(''))).toEqual({
      schema_version: 2,
      source_id: 'capture-events',
      status: 'complete',
      batches: 1,
      scanned: 12,
      inserted_membership: 10,
      membership: 42,
      ambiguous_identity_pages: 0,
      total_heads: 7,
      pending_eligible: 2,
      cursor_page_id: 12,
      scan_upper_page_id: 12,
      lease_generation: 3,
      resume_fingerprint: 'a'.repeat(64),
      provider_calls: 0,
    });
    expect(harness.stdout.join('')).not.toContain('must-not-be-printed');
  });

  test('rejects invalid input before source or reconciliation work', async () => {
    let fetchCalls = 0;
    let reconciliationCalls = 0;
    const harness = commandRuntime({
      fetchSource: async () => {
        fetchCalls += 1;
        return null;
      },
      reconcile: async () => {
        reconciliationCalls += 1;
        return report('complete');
      },
    });

    await runConnector(engine, ['tail-context-mirror', '--json'], harness.runtime);

    expect(harness.exitCodes).toEqual([2]);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join('')).toContain('required Context Mirror tail options missing');
    expect(fetchCalls).toBe(0);
    expect(reconciliationCalls).toBe(0);
  });

  test('reports an unknown exact source as an operational failure', async () => {
    const harness = commandRuntime({ fetchSource: async () => null });

    await runConnector(engine, validArgs, harness.runtime);

    expect(harness.exitCodes).toEqual([1]);
    expect(harness.stdout).toEqual([]);
    expect(harness.stderr.join('')).toContain('source capture-events not found');
  });

  test('emits an honest partial JSON report and exits nonzero', async () => {
    const harness = commandRuntime({ reconcile: async () => report('partial') });

    await runConnector(engine, validArgs, harness.runtime);

    expect(JSON.parse(harness.stdout.join(''))).toMatchObject({
      source_id: 'capture-events',
      status: 'partial',
      provider_calls: 0,
    });
    expect(harness.stderr).toEqual([]);
    expect(harness.exitCodes).toEqual([1]);
  });
});

describe('connector tail-context-mirror CLI help routing', () => {
  test.each([['--help'], ['-h']])('%s bypasses database initialization', (flag) => {
    const result = spawnSync(
      'bun',
      ['run', 'src/cli.ts', 'connector', 'tail-context-mirror', flag],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          GBRAIN_DATABASE_URL: 'not-a-valid-database-url',
          DATABASE_URL: 'not-a-valid-database-url',
        },
        timeout: 15_000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('tail-context-mirror options:');
    expect(result.stdout).toContain('--help, -h');
    expect(result.stderr).not.toContain('not-a-valid-database-url');
  });
});

describe('Context Mirror tail parser runtime bounds', () => {
  test('keeps strict parsing while advertising only usable runtime values', () => {
    expect(() => parseContextMirrorTailArgs(validArgs.slice(1).map((arg) => (
      arg === '30000' ? '1999' : arg
    )))).toThrow(/max-runtime-ms.*2000.*45000/);
    expect(() => parseContextMirrorTailArgs([...validArgs.slice(1), '--unknown', 'x'])).toThrow(/unknown/);
  });
});
