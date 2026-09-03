import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  consolidateContextMirrorGeneration,
  contextMirrorConnector,
} from '../src/core/connectors/context-mirror.ts';
import { distillCaptureSessions } from '../src/core/connectors/distill.ts';
import {
  admitWaitingCandidates,
  claimContextPartitions,
  completeContextGeneration,
  ensureContextGeneration,
  readContextMirrorRecoveryHold,
  rollbackContextGeneration,
  reserveReviewCapacity,
  reviewCapacitySnapshot,
  setContextMirrorRecoveryHold,
} from '../src/core/connectors/context-mirror-state.ts';
import { sweepExpiredCandidates, toRow } from '../src/core/connectors/candidate.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SOURCE_ID = 'default';
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
  resetGateway();
  configureGateway({ env: {} });
  __setChatTransportForTests(null);
});

afterEach(() => {
  __setChatTransportForTests(null);
  resetGateway();
});

async function setContextConfig(config: Record<string, unknown>): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources SET config = $2::jsonb WHERE id = $1`,
    [SOURCE_ID, JSON.stringify({ connectors: { context_mirror: config } })],
  );
}

async function seedGeneration(sessionId: string, partitions: string[]): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO context_mirror_session_heads (
       source_id, session_id, session_slug, capture_slug_prefix,
       newest_capture_at, turn_count, state, disposition, current_generation
     ) VALUES ($1,$2,$2,'capture/' || $2 || '/',now() - INTERVAL '1 day',2,'complete','distilled',1)`,
    [SOURCE_ID, sessionId],
  );
  await engine.executeRaw(
    `INSERT INTO context_mirror_generations (
       source_id, session_id, generation, input_hash, transform_version, model,
       expected_partitions, materialized_partitions, state, is_current, completed_at
     ) VALUES ($1,$2,1,'input','test-v1','test:stub',$3,$3,'complete',true,now())`,
    [SOURCE_ID, sessionId, partitions.length],
  );
  for (const partition of partitions) {
    await engine.executeRaw(
      `INSERT INTO context_mirror_partitions (
         source_id, session_id, generation, partition_key, distilled_slug, content_hash
       ) VALUES ($1,$2,1,$3,$4,$5)`,
      [SOURCE_ID, sessionId, partition, `distilled/${sessionId}/g-1/${partition}`, `hash-${partition}`],
    );
  }
}

async function seedCapture(sessionId: string, suffix: string, body: string, turn: number): Promise<void> {
  await engine.putPage(
    `capture/${sessionId}/${suffix}`,
    {
      type: 'note',
      title: suffix,
      compiled_truth: body,
      timeline: '',
      frontmatter: { session_id: sessionId, kind: turn === 1 ? 'prompt' : 'reply', turn },
    } as never,
    { sourceId: SOURCE_ID },
  );
}

describe('Context Mirror generation and review ledgers', () => {
  test('historical repair rollback reactivates the prior immutable page generation', async () => {
    await seedGeneration('repair-rollback', ['mem-1']);
    await engine.putPage(
      'distilled/repair-rollback/g-1/mem-1',
      {
        type: 'note', title: 'generation one', compiled_truth: 'Verified generation one memory.', timeline: '',
        frontmatter: { session_id: 'repair-rollback', generation: 1, partition: 'mem-1' },
      } as never,
      { sourceId: SOURCE_ID },
    );
    await engine.upsertChunks(
      'distilled/repair-rollback/g-1/mem-1',
      [{ chunk_index: 0, chunk_text: 'Verified generation one memory.', chunk_source: 'compiled_truth' }],
      { sourceId: SOURCE_ID },
    );
    const prior = await engine.getPage('distilled/repair-rollback/g-1/mem-1', { sourceId: SOURCE_ID });
    await engine.executeRaw(
      `UPDATE context_mirror_partitions SET content_hash = $4
        WHERE source_id = $1 AND session_id = $2 AND generation = 1 AND partition_key = $3`,
      [SOURCE_ID, 'repair-rollback', 'mem-1', prior!.content_hash],
    );
    await engine.executeRaw(
      `UPDATE context_mirror_generations
          SET state = 'superseded', is_current = false, superseded_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = 1`,
      [SOURCE_ID, 'repair-rollback'],
    );
    await engine.executeRaw(
      `UPDATE context_mirror_session_heads SET current_generation = 2
        WHERE source_id = $1 AND session_id = $2`,
      [SOURCE_ID, 'repair-rollback'],
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_generations (
         source_id, session_id, generation, input_hash, transform_version, model,
         expected_partitions, materialized_partitions, state, is_current, requires_human_review, completed_at
       ) VALUES ($1,$2,2,'corrected-input','test-v2','test:stub',1,1,'complete',true,true,now())`,
      [SOURCE_ID, 'repair-rollback'],
    );
    await engine.putPage(
      'distilled/repair-rollback/g-2/mem-1',
      {
        type: 'note', title: 'generation two', compiled_truth: 'Rejected generation two memory.', timeline: '',
        frontmatter: { session_id: 'repair-rollback', generation: 2, partition: 'mem-1' },
      } as never,
      { sourceId: SOURCE_ID },
    );
    await engine.upsertChunks(
      'distilled/repair-rollback/g-2/mem-1',
      [{ chunk_index: 0, chunk_text: 'Rejected generation two memory.', chunk_source: 'compiled_truth' }],
      { sourceId: SOURCE_ID },
    );
    const replacement = await engine.getPage('distilled/repair-rollback/g-2/mem-1', { sourceId: SOURCE_ID });
    await engine.executeRaw(
      `INSERT INTO context_mirror_partitions (
         source_id,session_id,generation,partition_key,distilled_slug,content_hash
       ) VALUES ($1,$2,2,'mem-1','distilled/repair-rollback/g-2/mem-1',$3)`,
      [SOURCE_ID, 'repair-rollback', replacement!.content_hash],
    );

    const result = await rollbackContextGeneration(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'repair-rollback',
      generation: 2,
      rollbackGeneration: 1,
    });
    expect(result).toMatchObject({
      status: 'rolled_back',
      source_id: SOURCE_ID,
      session_id: 'repair-rollback',
      generation: 2,
      rollback_generation: 1,
      rejected_candidates: 0,
      actor: 'system',
      reason: 'legacy_operator_request',
      verification: {
        current_generation: 1,
        rolled_back_generation_state: 'superseded',
        restored_generation_state: 'complete',
      },
    });
    expect(result.rolled_back_at).toBeTruthy();
    const rows = await engine.executeRaw<{ generation: number | string; state: string; is_current: boolean }>(
      `SELECT generation,state,is_current FROM context_mirror_generations
        WHERE source_id = $1 AND session_id = $2 ORDER BY generation`,
      [SOURCE_ID, 'repair-rollback'],
    );
    expect(rows).toEqual([
      { generation: 1, state: 'complete', is_current: true },
      { generation: 2, state: 'superseded', is_current: false },
    ]);
    const [head] = await engine.executeRaw<{ current_generation: number | string; disposition: string }>(
      `SELECT current_generation,disposition FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2`,
      [SOURCE_ID, 'repair-rollback'],
    );
    expect(head).toEqual({ current_generation: 1, disposition: 'generation_rollback' });
    expect((await engine.getPage('distilled/repair-rollback/g-1/mem-1', { sourceId: SOURCE_ID }))?.compiled_truth)
      .toBe('Verified generation one memory.');
    expect((await engine.getPage('distilled/repair-rollback/g-2/mem-1', { sourceId: SOURCE_ID }))?.compiled_truth)
      .toBe('Rejected generation two memory.');
    const claims = await claimContextPartitions(engine, SOURCE_ID, 10, new Date());
    expect(claims.map((claim) => claim.distilledSlug)).toEqual([
      'distilled/repair-rollback/g-1/mem-1',
    ]);
  });

  test('generation rollback refuses ordinary or already-promoted work', async () => {
    await seedGeneration('ordinary-generation', ['mem-1']);
    await expect(rollbackContextGeneration(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'ordinary-generation',
      generation: 1,
      rollbackGeneration: 0,
    })).rejects.toThrow(/generation must be greater than one/);
  });

  test('a timestamp-only legacy watermark imports equal-time pages as held, never current or actionable', async () => {
    const timestamp = '2026-08-01T12:00:00.000Z';
    await engine.putPage(
      'distilled/legacy-session/mem-1',
      {
        type: 'note',
        title: 'legacy memory',
        compiled_truth: 'Legacy evidence awaiting reconciliation.',
        timeline: '',
        frontmatter: { session_id: 'legacy-session', generation: 1, distilled: true },
      } as never,
      { sourceId: SOURCE_ID },
    );
    await engine.executeRaw(
      `UPDATE pages SET updated_at = $2::timestamptz
        WHERE source_id = $1 AND slug = 'distilled/legacy-session/mem-1'`,
      [SOURCE_ID, timestamp],
    );
    await setContextConfig({ watermark: timestamp, read_slug_prefix: 'distilled/' });

    const result = await contextMirrorConnector.backfill!(engine, {
      id: SOURCE_ID,
      config: { connectors: { context_mirror: { watermark: timestamp, read_slug_prefix: 'distilled/' } } },
    });

    expect(result).toMatchObject({ status: 'partial', landed: 0 });
    const [generation] = await engine.executeRaw<{
      state: string; is_current: boolean; recovery_hold: boolean; requires_human_review: boolean;
    }>(
      `SELECT state, is_current, recovery_hold, requires_human_review
         FROM context_mirror_generations
        WHERE source_id = $1 AND session_id = 'legacy-session' AND generation = 1`,
      [SOURCE_ID],
    );
    expect(generation).toEqual({
      state: 'unverified_legacy',
      is_current: false,
      recovery_hold: true,
      requires_human_review: true,
    });
    const [partition] = await engine.executeRaw<{ state: string }>(
      `SELECT state FROM context_mirror_partitions
        WHERE source_id = $1 AND session_id = 'legacy-session'`,
      [SOURCE_ID],
    );
    expect(partition.state).toBe('unverified_legacy');
    const [{ count }] = await engine.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM connector_candidates WHERE source_id = $1`,
      [SOURCE_ID],
    );
    expect(Number(count)).toBe(0);
  });

  test('overlapping workers receive disjoint partition leases', async () => {
    await seedGeneration('lease-session', ['mem-1', 'mem-2', 'mem-3', 'mem-4']);
    const now = new Date();
    const [first, second] = await Promise.all([
      claimContextPartitions(engine, SOURCE_ID, 3, now),
      claimContextPartitions(engine, SOURCE_ID, 3, now),
    ]);
    const keys = [...first, ...second].map((claim) => claim.partitionKey);
    expect(new Set(keys).size).toBe(keys.length);
    const remainder = await claimContextPartitions(engine, SOURCE_ID, 3, now);
    const allKeys = [...keys, ...remainder.map((claim) => claim.partitionKey)];
    expect(new Set(allKeys)).toEqual(new Set(['mem-1', 'mem-2', 'mem-3', 'mem-4']));
  });

  test('an exact generation lease never claims an older unrelated partition', async () => {
    await seedGeneration('older-unrelated', ['mem-1']);
    await seedGeneration('named-canary', ['mem-1']);

    const claims = await claimContextPartitions(engine, SOURCE_ID, 1, new Date(), {
      sessionId: 'named-canary',
      generation: 1,
    });

    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ sessionId: 'named-canary', generation: 1, partitionKey: 'mem-1' });
    const [unrelated] = await engine.executeRaw<{ state: string; attempt_count: number | string }>(
      `SELECT state, attempt_count FROM context_mirror_partitions
        WHERE source_id = $1 AND session_id = 'older-unrelated' AND generation = 1`,
      [SOURCE_ID],
    );
    expect(unrelated.state).toBe('pending');
    expect(Number(unrelated.attempt_count)).toBe(0);
  });

  test('targeted consolidation reaches one exact decision inside its own one-call ceiling', async () => {
    await setContextConfig({ enabled: true, consolidation_enabled: true });
    await seedGeneration('named-canary', ['mem-1']);
    await engine.putPage(
      'distilled/named-canary/g-1/mem-1',
      {
        type: 'note',
        title: 'named canary',
        compiled_truth: 'A bounded canary memory records a durable decision that is long enough for review admission.',
        timeline: '',
        frontmatter: {
          session_id: 'named-canary', generation: 1, partition: 'mem-1',
          evidence_trust: 'untrusted_transcript',
        },
      } as never,
      { sourceId: SOURCE_ID },
    );
    const [page] = await engine.executeRaw<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE source_id = $1 AND slug = 'distilled/named-canary/g-1/mem-1'`,
      [SOURCE_ID],
    );
    await engine.executeRaw(
      `UPDATE context_mirror_partitions SET content_hash = $3
        WHERE source_id = $1 AND session_id = $2 AND generation = 1`,
      [SOURCE_ID, 'named-canary', page.content_hash],
    );
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      return {
        text: JSON.stringify({ facts: ['A bounded canary memory.'], confidence: 0.9 }),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'claude-haiku-4-5-20251001',
        providerId: 'test',
      };
    });

    const auditDir = mkdtempSync('D:/Temp/gbrain-targeted-canary-');
    let report;
    try {
      report = await consolidateContextMirrorGeneration(
        engine,
        { id: SOURCE_ID, config: { connectors: { context_mirror: { enabled: true, consolidation_enabled: true } } } },
        {
          sessionId: 'named-canary',
          generation: 1,
          maxPartitions: 1,
          maxCalls: 1,
          maxCostUsd: 0.1,
          maxRuntimeMs: 60_000,
          budgetAuditPath: join(auditDir, 'budget.jsonl'),
        },
      );
    } finally {
      rmSync(auditDir, { recursive: true, force: true });
    }

    expect(report).toMatchObject({
      status: 'ok',
      stop_reason: 'completed',
      selected_partitions: 1,
      provider_calls_reserved: 1,
      provider_calls_recorded: 1,
    });
    expect(calls).toBe(1);
    const [partition] = await engine.executeRaw<{ state: string }>(
      `SELECT state FROM context_mirror_partitions
        WHERE source_id = $1 AND session_id = 'named-canary' AND generation = 1`,
      [SOURCE_ID],
    );
    expect(partition.state).toBe('decided');
  });

  test('a lower-key late row is claimed from the ledger even after the scan cursor advanced', async () => {
    await engine.executeRaw(
      `INSERT INTO context_mirror_checkpoints (source_id, checkpoint_kind, cursor, completed)
       VALUES ($1,'distilled_legacy_import_v1',$2::jsonb,true)`,
      [SOURCE_ID, JSON.stringify({ updated_at: '2099-01-01T00:00:00.000Z', slug: 'distilled/zzz' })],
    );
    await seedGeneration('late-key', ['aaa']);
    const claims = await claimContextPartitions(engine, SOURCE_ID, 5, new Date());
    expect(claims.map((claim) => claim.partitionKey)).toEqual(['aaa']);
  });

  test('a completed replacement generation closes stale pending review but preserves accepted history', async () => {
    await seedGeneration('supersede-session', []);
    const pending = await toRow(engine, {
      source_id: SOURCE_ID,
      source_record_id: 'old-pending',
      version: '1',
      provider: 'context_mirror',
      proposed_slug: 'old-pending',
      proposed_markdown: 'old pending memory',
      context_session_id: 'supersede-session',
      context_generation: 1,
      context_partition: 'mem-1',
    });
    const accepted = await toRow(engine, {
      source_id: SOURCE_ID,
      source_record_id: 'old-accepted',
      version: '1',
      provider: 'context_mirror',
      proposed_slug: 'old-accepted',
      proposed_markdown: 'already accepted memory',
      context_session_id: 'supersede-session',
      context_generation: 1,
      context_partition: 'mem-2',
    });
    await engine.executeRaw(
      `UPDATE connector_candidates SET status = 'accepted' WHERE id = $1`,
      [accepted.row.id],
    );

    await ensureContextGeneration(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'supersede-session',
      generation: 2,
      inputHash: 'generation-two-input',
      originator: 'codex',
      runtime: 'codex',
      transformVersion: 'test-v2',
      model: 'test:stub',
    });
    await engine.putPage(
      'distilled/supersede-session/mem-1',
      {
        type: 'note', title: 'replacement', compiled_truth: 'replacement memory', timeline: '',
        frontmatter: { session_id: 'supersede-session', generation: 2, partition: 'mem-1' },
        content_hash: 'replacement-hash',
      } as never,
      { sourceId: SOURCE_ID },
    );
    await engine.upsertChunks(
      'distilled/supersede-session/mem-1',
      [{ chunk_index: 0, chunk_text: 'replacement memory', chunk_source: 'compiled_truth' }],
      { sourceId: SOURCE_ID },
    );
    await completeContextGeneration(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'supersede-session',
      generation: 2,
      inputHash: 'generation-two-input',
      originator: 'codex',
      runtime: 'codex',
      transformVersion: 'test-v2',
      model: 'test:stub',
      partitions: [{
        partitionKey: 'mem-1',
        distilledSlug: 'distilled/supersede-session/mem-1',
        contentHash: 'replacement-hash',
      }],
    });

    const rows = await engine.executeRaw<{ id: number | string; status: string; status_reason: string | null }>(
      `SELECT id, status, status_reason FROM connector_candidates
        WHERE id IN ($1,$2) ORDER BY id`,
      [pending.row.id, accepted.row.id],
    );
    expect(rows).toEqual([
      {
        id: pending.row.id,
        status: 'rejected',
        status_reason: 'superseded_generation_pending_replacement',
      },
      { id: accepted.row.id, status: 'accepted', status_reason: null },
    ]);
  });

  test('zero derived capacity leaves the session eligible and makes no provider call', async () => {
    await setContextConfig({
      pending_review_limit: 0,
      staging_review_limit: 0,
      staging_review_bytes: 1,
    });
    await seedCapture('no-capacity', 'prompt-1', 'Remember this decision?', 1);
    await seedCapture('no-capacity', 'reply-1', 'Keep it durable.', 2);
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      throw new Error('provider must not be called without review capacity');
    });

    const report = await distillCaptureSessions(engine, {
      sourceId: SOURCE_ID,
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });

    expect(calls).toBe(0);
    expect(report).toMatchObject({ status: 'partial', stop_reason: 'review_capacity', deferred: 1 });
    const [head] = await engine.executeRaw<{ state: string }>(
      `SELECT state FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = 'no-capacity'`,
      [SOURCE_ID],
    );
    expect(head.state).toBe('pending');
  });

  test('an oversized transcript is quarantined with generation lineage before any provider call', async () => {
    await seedCapture('oversized', 'prompt-1', 'x'.repeat(512), 1);
    await seedCapture('oversized', 'reply-1', 'y'.repeat(512), 2);
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      return {
        text: '[]',
        blocks: [],
        stopReason: 'end',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
        },
        model: 'test:stub',
        providerId: 'test',
      };
    });

    const report = await distillCaptureSessions(engine, {
      sourceId: SOURCE_ID,
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
      maxMemoryBytes: 64,
    });

    expect(calls).toBe(0);
    expect(report).toMatchObject({ status: 'partial', failed: 1 });
    const [generation] = await engine.executeRaw<{ state: string; input_hash: string }>(
      `SELECT state, input_hash FROM context_mirror_generations
        WHERE source_id = $1 AND session_id = 'oversized' AND generation = 1`,
      [SOURCE_ID],
    );
    expect(generation.state).toBe('quarantined');
    expect(generation.input_hash.length).toBeGreaterThan(10);
    const [head] = await engine.executeRaw<{ state: string; disposition: string }>(
      `SELECT state, disposition FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = 'oversized'`,
      [SOURCE_ID],
    );
    expect(head).toEqual({ state: 'quarantined', disposition: 'memory_limit' });
  });

  test('review admission is bounded and promotes waiting candidates oldest-first', async () => {
    await setContextConfig({
      pending_review_limit: 2,
      staging_review_limit: 3,
      staging_review_bytes: 10_000,
    });
    for (const id of ['human-1', 'human-2']) {
      await toRow(engine, {
        source_id: SOURCE_ID,
        source_record_id: id,
        provider: 'context_mirror',
        proposed_slug: id,
        proposed_markdown: 'human review item',
      });
    }
    for (const [index, id] of ['waiting-oldest', 'waiting-newer'].entries()) {
      await toRow(engine, {
        source_id: SOURCE_ID,
        source_record_id: id,
        provider: 'context_mirror',
        proposed_slug: id,
        proposed_markdown: 'staged review item',
        status: 'awaiting_review_capacity',
        status_reason: 'review_capacity',
      });
      await engine.executeRaw(
        `UPDATE connector_candidates SET proposed_at = $2::timestamptz
          WHERE source_id = $1 AND source_record_id = $3`,
        [SOURCE_ID, `2026-08-01T00:00:0${index}.000Z`, id],
      );
    }
    expect(await admitWaitingCandidates(engine, SOURCE_ID)).toBe(0);
    await engine.executeRaw(
      `UPDATE connector_candidates SET status = 'rejected'
        WHERE source_id = $1 AND source_record_id = 'human-1'`,
      [SOURCE_ID],
    );
    const admitted = await Promise.all([
      admitWaitingCandidates(engine, SOURCE_ID),
      admitWaitingCandidates(engine, SOURCE_ID),
    ]);
    expect(admitted.reduce((sum, count) => sum + count, 0)).toBe(1);
    const rows = await engine.executeRaw<{ source_record_id: string; status: string }>(
      `SELECT source_record_id, status FROM connector_candidates
        WHERE source_record_id LIKE 'waiting-%' ORDER BY proposed_at ASC`,
    );
    expect(rows).toEqual([
      { source_record_id: 'waiting-oldest', status: 'pending' },
      { source_record_id: 'waiting-newer', status: 'awaiting_review_capacity' },
    ]);
    const snapshot = await reviewCapacitySnapshot(engine, SOURCE_ID);
    expect(snapshot).toMatchObject({ humanPending: 2, staged: 1 });
  });

  test('the source recovery hold protects pages and candidate decisions until explicitly released', async () => {
    await engine.putPage(
      'distilled/held/mem-1',
      {
        type: 'note', title: 'held', compiled_truth: 'held evidence', timeline: '', frontmatter: {},
      } as never,
      { sourceId: SOURCE_ID },
    );
    await engine.softDeletePage('distilled/held/mem-1', { sourceId: SOURCE_ID });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() - INTERVAL '2 days'
        WHERE source_id = $1 AND slug = 'distilled/held/mem-1'`,
      [SOURCE_ID],
    );
    await toRow(engine, {
      source_id: SOURCE_ID,
      source_record_id: 'held-candidate',
      provider: 'context_mirror',
      proposed_slug: 'held-candidate',
      proposed_markdown: 'held candidate',
      expires_at: new Date(Date.now() - 60_000),
    });
    await setContextMirrorRecoveryHold(engine, SOURCE_ID, true, 'migration reconciliation');

    expect((await readContextMirrorRecoveryHold(engine, SOURCE_ID)).active).toBe(true);
    expect(await sweepExpiredCandidates(engine)).toBe(0);
    expect((await engine.purgeDeletedPages(0)).count).toBe(0);

    await setContextMirrorRecoveryHold(engine, SOURCE_ID, false, 'migration reconciliation complete');
    expect(await sweepExpiredCandidates(engine)).toBe(1);
    expect((await engine.purgeDeletedPages(0)).count).toBe(1);
  });

  test('a worst-case reservation is denied before work when the combined envelope is full', async () => {
    await setContextConfig({
      pending_review_limit: 1,
      staging_review_limit: 1,
      staging_review_bytes: 100,
    });
    await seedGeneration('reserve-session', []);
    await toRow(engine, {
      source_id: SOURCE_ID,
      source_record_id: 'human-full',
      provider: 'context_mirror',
      proposed_slug: 'human-full',
      proposed_markdown: 'pending',
    });
    await toRow(engine, {
      source_id: SOURCE_ID,
      source_record_id: 'stage-full',
      provider: 'context_mirror',
      proposed_slug: 'stage-full',
      proposed_markdown: 'x'.repeat(100),
      status: 'awaiting_review_capacity',
    });
    const reservation = await reserveReviewCapacity(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'reserve-session',
      generation: 1,
      slots: 1,
      bytes: 1,
      now: new Date(),
    });
    expect(reservation).toBeNull();
  });

  test('historical work preserves the fresh quota and an aged staging queue stops new work', async () => {
    await setContextConfig({
      pending_review_limit: 10,
      staging_review_limit: 0,
      staging_review_bytes: 10_000,
      staging_review_max_age_hours: 168,
    });
    await seedGeneration('historical-one', []);
    await seedGeneration('historical-two', []);
    const first = await reserveReviewCapacity(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'historical-one',
      generation: 1,
      slots: 6,
      bytes: 6_000,
      cohortKind: 'historical',
      now: new Date(),
    });
    const second = await reserveReviewCapacity(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'historical-two',
      generation: 1,
      slots: 6,
      bytes: 6_000,
      cohortKind: 'historical',
      now: new Date(),
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect((await reviewCapacitySnapshot(engine, SOURCE_ID)).freshQuota).toBe(2);

    await engine.executeRaw(
      `UPDATE context_mirror_review_reservations SET state = 'released' WHERE source_id = $1`,
      [SOURCE_ID],
    );
    await setContextConfig({
      pending_review_limit: 10,
      staging_review_limit: 5,
      staging_review_bytes: 10_000,
      staging_review_max_age_hours: 168,
    });
    await toRow(engine, {
      source_id: SOURCE_ID,
      source_record_id: 'aged-stage',
      provider: 'context_mirror',
      proposed_slug: 'aged-stage',
      proposed_markdown: 'aged stage',
      status: 'awaiting_review_capacity',
    });
    await engine.executeRaw(
      `UPDATE connector_candidates SET proposed_at = now() - INTERVAL '8 days'
        WHERE source_id = $1 AND source_record_id = 'aged-stage'`,
      [SOURCE_ID],
    );
    const agedSnapshot = await reviewCapacitySnapshot(engine, SOURCE_ID);
    expect(agedSnapshot.stagingAgeExceeded).toBe(true);
    expect(await reserveReviewCapacity(engine, {
      sourceId: SOURCE_ID,
      sessionId: 'historical-two',
      generation: 1,
      slots: 1,
      bytes: 1,
      cohortKind: 'fresh',
      now: new Date(),
    })).toBeNull();
  });
});
