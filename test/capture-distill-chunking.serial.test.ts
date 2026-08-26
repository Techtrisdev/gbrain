/**
 * Regression test for the distill CHUNKING gap.
 *
 * Bug (measured live 2026-07-25): `distillCaptureSessions` wrote memory pages via
 * `engine.putPage`, which upserts the `pages` row ONLY and creates no
 * `content_chunks`. The embed sweep (`gbrain embed --stale`, autopilot's embed
 * phase) embeds CHUNKS — so a chunkless page is never embedded and the distilled
 * memory is invisible to semantic search permanently. 83 of 199 distilled pages in
 * production (every one written since 2026-07-01) had zero chunks and zero
 * embeddings; raw captures were fine because that path
 * (minions/handlers/ingest-capture.ts) already goes through `importFromContent`.
 *
 * This test runs against a REAL PGLiteEngine on purpose. The fake engine in
 * capture-distill.serial.test.ts implements only listPages/listAllSlugs/getPage/
 * putPage, so it cannot observe chunking at all — passing there proves nothing
 * about the defect. The assertion that matters is `getChunks(page.id).length > 0`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import { distillCaptureSessions } from '../src/core/connectors/distill.ts';
import { contextMirrorConnector } from '../src/core/connectors/context-mirror.ts';
import {
  advanceSessionHeadBootstrap,
  claimPendingSessionHeads,
} from '../src/core/connectors/context-mirror-state.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

// Seed into the auto-created 'default' source: only 'default' exists after
// initSchema, and creating a second source is orthogonal to the defect.
const CAPTURE_SOURCE = 'default';
const SESSION_ID = 'chunkgap-sess-1';

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

function stubChat(text: string): void {
  __setChatTransportForTests(async (_opts: ChatOpts): Promise<ChatResult> => ({
    text,
    blocks: [],
    stopReason: 'end',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'test:stub',
    providerId: 'test',
  }));
}

async function seedCapture(slug: string, body: string, turn: number): Promise<void> {
  await engine.putPage(
    slug,
    {
      type: 'note',
      title: slug,
      compiled_truth: body,
      timeline: '',
      frontmatter: { session_id: SESSION_ID, kind: turn === 1 ? 'prompt' : 'reply', turn },
    } as never,
    { sourceId: CAPTURE_SOURCE },
  );
}

describe('distillCaptureSessions — distilled pages must be CHUNKED (retrievable)', () => {
  test('a distilled memory page has content_chunks, not just a pages row', async () => {
    await seedCapture('capture/chunkgap-sess-1/prompt-1', 'Should we ship X?', 1);
    await seedCapture('capture/chunkgap-sess-1/reply-1', 'Yes, ship X behind a flag.', 2);
    stubChat(JSON.stringify(['Jonathan prefers shipping behind flags.']));

    // Seeded pages carry a real `updated_at` of now, so look at them from far
    // enough in the future that the session reads as idle/completed.
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const report = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });

    expect(report.distilled).toBe(1);
    expect(report.memories_written).toBe(1);

    const page = await engine.getPage('distilled/chunkgap-sess-1/mem-1');
    expect(page).not.toBeNull();

    // THE assertion. A chunkless page is invisible to semantic search forever,
    // because the embed sweep only ever embeds chunks.
    const chunks = await engine.getChunks('distilled/chunkgap-sess-1/mem-1', {
      sourceId: CAPTURE_SOURCE,
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((c) => c.chunk_text).join(' ')).toContain('shipping behind flags');
  });

  test('a persisted provider result finalizes after a page-write crash without a second charge', async () => {
    await seedCapture('capture/chunkgap-sess-1/prompt-1', 'Remember the durable decision.', 1);
    await seedCapture('capture/chunkgap-sess-1/reply-1', 'The durable decision is to use a flag.', 2);
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      return {
        text: JSON.stringify(['Jonathan decided to use a feature flag.']),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const originalPutPage = engine.putPage.bind(engine);
    (engine as unknown as { putPage: PGLiteEngine['putPage'] }).putPage = async (slug, page, opts) => {
      if (slug.startsWith('distilled/')) throw new Error('simulated crash after provider result');
      return originalPutPage(slug, page, opts);
    };

    const first = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });
    expect(first.status).toBe('partial');
    expect(first.failed).toBe(1);
    expect(calls).toBe(1);

    (engine as unknown as { putPage: PGLiteEngine['putPage'] }).putPage = originalPutPage;
    const second = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });
    expect(second.status).toBe('ok');
    expect(second.distilled).toBe(1);
    expect(calls).toBe(1);
  });

  test('a systemic provider failure opens a durable circuit before another run can call again', async () => {
    await seedCapture('capture/chunkgap-sess-1/prompt-1', 'Remember this.', 1);
    await seedCapture('capture/chunkgap-sess-1/reply-1', 'A durable response.', 2);
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      throw new AIConfigError('billing configuration unavailable');
    });
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const first = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });
    const second = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });

    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    expect(second.calls).toBe(0);
    expect(calls).toBe(1);
  });

  test('a 3,000-session bootstrap resumes by checkpoint and claims only five metadata heads', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (
         source_id, slug, type, title, compiled_truth, timeline, frontmatter, updated_at
       )
       SELECT 'default',
              'capture/sess-' || lpad(i::text, 4, '0') || '/prompt-1',
              'note', 'capture', repeat('body-not-read-', 20), '',
              jsonb_build_object('session_id', 'sess-' || lpad(i::text, 4, '0')),
              now() - INTERVAL '2 days' + (i * INTERVAL '1 second')
         FROM generate_series(1, 3000) AS i`,
    );
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const complete: boolean[] = [];
    let last;
    for (let i = 0; i < 4; i++) {
      last = await advanceSessionHeadBootstrap(engine, {
        sourceId: CAPTURE_SOURCE,
        now,
        idleHours: 6,
        sessionSlug: (sessionId) => sessionId,
        batchSize: 1_000,
      });
      complete.push(last.complete);
    }
    expect(complete).toEqual([false, false, false, true]);
    expect(last).toMatchObject({ totalHeads: 3_000, pendingEligible: 3_000 });

    const claimed = await claimPendingSessionHeads(engine, CAPTURE_SOURCE, 5, now);
    expect(claimed).toHaveLength(5);
    expect(claimed.map((head) => head.sessionId)).toEqual([
      'sess-0001', 'sess-0002', 'sess-0003', 'sess-0004', 'sess-0005',
    ]);
  }, 15_000);

  test('same-timestamp consolidation above 100 rows resumes with a composite cursor', async () => {
    await engine.executeRaw(
      `INSERT INTO pages (
         source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, updated_at
       )
       SELECT 'default',
              'distilled/bulk/mem-' || lpad(i::text, 3, '0'),
              'note', 'memory', repeat('durable memory body ', 8), '',
              jsonb_build_object(
                'session_id', 'bulk', 'generation', 1,
                'partition', 'mem-' || lpad(i::text, 3, '0'),
                'evidence_trust', 'untrusted_transcript'
              ),
              'hash-' || lpad(i::text, 3, '0'),
              '2026-08-01T12:00:00Z'::timestamptz
         FROM generate_series(1, 150) AS i`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_session_heads (
         source_id, session_id, session_slug, capture_slug_prefix,
         newest_capture_at, turn_count, state, current_generation
       ) VALUES ('default','bulk','bulk','capture/bulk/',now() - INTERVAL '1 day',150,'complete',1)`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_generations (
         source_id, session_id, generation, input_hash, transform_version, model,
         expected_partitions, materialized_partitions, state, is_current, completed_at
       ) VALUES ('default','bulk',1,'input-hash','test-v1','test:stub',150,150,'complete',true,now())`,
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_partitions (
         source_id, session_id, generation, partition_key, distilled_slug, content_hash
       )
       SELECT 'default','bulk',1,
              'mem-' || lpad(i::text, 3, '0'),
              'distilled/bulk/mem-' || lpad(i::text, 3, '0'),
              'hash-' || lpad(i::text, 3, '0')
         FROM generate_series(1,150) AS i`,
    );
    const source = {
      id: CAPTURE_SOURCE,
      config: { connectors: { context_mirror: { read_slug_prefix: 'distilled/' } } },
    };

    const first = await contextMirrorConnector.backfill!(engine, source);
    const second = await contextMirrorConnector.backfill!(engine, source);

    expect(first).toMatchObject({ status: 'partial', landed: 0 });
    expect(second).toMatchObject({ status: 'partial', landed: 0 });
    const [checkpoint] = await engine.executeRaw<{ cursor: unknown; completed: boolean }>(
      `SELECT cursor, completed FROM context_mirror_checkpoints
        WHERE source_id = $1 AND checkpoint_kind = 'distilled_legacy_import_v1'`,
      [CAPTURE_SOURCE],
    );
    const cursor = typeof checkpoint.cursor === 'string'
      ? JSON.parse(checkpoint.cursor) as Record<string, unknown>
      : checkpoint.cursor as Record<string, unknown>;
    expect(checkpoint.completed).toBe(true);
    expect(cursor).toMatchObject({
      updated_at: '2026-08-01T12:00:00.000Z',
      slug: 'distilled/bulk/mem-150',
    });
    const rows = await engine.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM context_mirror_partitions
        WHERE source_id = $1 AND state = 'pending'`,
      [CAPTURE_SOURCE],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(150);
    const candidates = await engine.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM connector_candidates
        WHERE source_id = $1 AND provider = 'context_mirror'`,
      [CAPTURE_SOURCE],
    );
    expect(Number(candidates[0]?.count ?? 0)).toBe(0);
  });

  test('late capture evidence creates a new durable generation instead of being hidden by the old marker', async () => {
    await seedCapture('capture/chunkgap-sess-1/prompt-1', 'Initial decision?', 1);
    await seedCapture('capture/chunkgap-sess-1/reply-1', 'Initial decision.', 2);
    let memory = 'generation one memory';
    stubChat(JSON.stringify([memory]));
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const first = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });
    expect(first.distilled).toBe(1);
    const [firstHead] = await engine.executeRaw<{
      first_eligible_at: Date | string;
      current_eligible_at: Date | string;
    }>(
      `SELECT first_eligible_at, current_eligible_at
         FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2`,
      [CAPTURE_SOURCE, SESSION_ID],
    );

    await seedCapture('capture/chunkgap-sess-1/reply-2', 'Late evidence changes the decision.', 3);
    memory = 'generation two corrected memory';
    stubChat(JSON.stringify([memory]));
    const secondNow = new Date(now.getTime() + 60 * 60 * 1000);
    const second = await distillCaptureSessions(engine, { now: secondNow, sourceId: CAPTURE_SOURCE });

    expect(second.distilled).toBe(1);
    const page = await engine.getPage('distilled/chunkgap-sess-1/mem-1', { sourceId: CAPTURE_SOURCE });
    expect(page?.compiled_truth).toBe(memory);
    expect((page?.frontmatter as Record<string, unknown>)?.generation).toBe(2);
    const calls = await engine.executeRaw<{ generation: number | string }>(
      `SELECT generation FROM context_mirror_provider_calls
        WHERE source_id = $1 AND session_id = $2 AND state = 'result_persisted'
        ORDER BY generation`,
      [CAPTURE_SOURCE, SESSION_ID],
    );
    expect(calls.map((row) => Number(row.generation))).toEqual([1, 2]);
    const [secondHead] = await engine.executeRaw<{
      first_eligible_at: Date | string;
      current_eligible_at: Date | string;
    }>(
      `SELECT first_eligible_at, current_eligible_at
         FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2`,
      [CAPTURE_SOURCE, SESSION_ID],
    );
    expect(new Date(secondHead.first_eligible_at).toISOString())
      .toBe(new Date(firstHead.first_eligible_at).toISOString());
    expect(new Date(secondHead.current_eligible_at).toISOString())
      .toBe(secondNow.toISOString());
  });
});
