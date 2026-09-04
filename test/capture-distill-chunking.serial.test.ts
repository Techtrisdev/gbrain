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
import { createHash } from 'node:crypto';
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatOpts,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError } from '../src/core/ai/errors.ts';
import { distillCaptureSessions, toSessionSlug } from '../src/core/connectors/distill.ts';
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

    const page = await engine.getPage('distilled/chunkgap-sess-1/g-1/mem-1');
    expect(page).not.toBeNull();

    // THE assertion. A chunkless page is invisible to semantic search forever,
    // because the embed sweep only ever embeds chunks.
    const chunks = await engine.getChunks('distilled/chunkgap-sess-1/g-1/mem-1', {
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

  test('a timed-out or disconnected provider send becomes ambiguous and is never replayed', async () => {
    await seedCapture('capture/chunkgap-sess-1/prompt-1', 'Remember this once.', 1);
    await seedCapture('capture/chunkgap-sess-1/reply-1', 'One durable response.', 2);
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      throw new AITransientError('connection closed after request send');
    });
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const first = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });
    const second = await distillCaptureSessions(engine, { now, sourceId: CAPTURE_SOURCE });

    expect(first.status).toBe('failed');
    expect(first.stop_reason).toBe('ambiguous_provider_outcome');
    expect(second.calls).toBe(0);
    expect(calls).toBe(1);
    const [provider] = await engine.executeRaw<{
      state: string;
      error_class: string;
      error_message: string;
    }>(
      `SELECT state,error_class,error_message FROM context_mirror_provider_calls
        WHERE source_id = $1 AND session_id = $2`,
      [CAPTURE_SOURCE, SESSION_ID],
    );
    const [head] = await engine.executeRaw<{ state: string; disposition: string }>(
      `SELECT state,disposition FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2`,
      [CAPTURE_SOURCE, SESSION_ID],
    );
    expect(provider?.state).toBe('ambiguous_provider_outcome');
    expect(provider?.error_class).toBe('transient');
    expect(provider?.error_message).toBe(
      'provider outcome ambiguous; details omitted; reconcile by correlation_id',
    );
    expect(provider?.error_message).not.toContain('connection closed');
    expect(head).toEqual({ state: 'ambiguous', disposition: 'ambiguous_provider_outcome' });
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
  }, 30_000);

  test('lossy-locator collisions keep exact sessions and transcripts separate', async () => {
    const sessions = [
      { id: 'a/b', prompt: 'ONLY-SLASH-PROMPT', reply: 'ONLY-SLASH-REPLY' },
      { id: 'a b', prompt: 'ONLY-SPACE-PROMPT', reply: 'ONLY-SPACE-REPLY' },
    ];
    for (const [index, session] of sessions.entries()) {
      for (const [turn, body] of [session.prompt, session.reply].entries()) {
        await engine.putPage(
          `capture/shared/${index}-${turn + 1}`,
          {
            type: 'note',
            title: session.id,
            compiled_truth: body,
            timeline: '',
            frontmatter: { session_id: session.id, kind: turn === 0 ? 'prompt' : 'reply', turn: turn + 1 },
          } as never,
          { sourceId: CAPTURE_SOURCE },
        );
      }
    }

    const calls: string[] = [];
    __setChatTransportForTests(async (opts: ChatOpts): Promise<ChatResult> => {
      const content = String(opts.messages[0]?.content ?? '');
      calls.push(content);
      return {
        text: JSON.stringify([content.includes('ONLY-SLASH-PROMPT') ? 'slash memory' : 'space memory']),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);

    for (const session of sessions) {
      const report = await distillCaptureSessions(engine, {
        now,
        sourceId: CAPTURE_SOURCE,
        sessionIds: [session.id],
        maxSessions: 1,
        maxCalls: 1,
      });
      expect(report.distilled).toBe(1);
    }

    const heads = await engine.executeRaw<{ session_id: string; session_slug: string; turn_count: number | string }>(
      `SELECT session_id, session_slug, turn_count
         FROM context_mirror_session_heads
        WHERE source_id = $1
        ORDER BY session_id`,
      [CAPTURE_SOURCE],
    );
    expect(heads).toHaveLength(2);
    expect(new Set(heads.map((head) => head.session_slug)).size).toBe(2);
    expect(heads.map((head) => Number(head.turn_count))).toEqual([2, 2]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('ONLY-SLASH-PROMPT');
    expect(calls[0]).toContain('ONLY-SLASH-REPLY');
    expect(calls[0]).not.toContain('ONLY-SPACE');
    expect(calls[1]).toContain('ONLY-SPACE-PROMPT');
    expect(calls[1]).toContain('ONLY-SPACE-REPLY');
    expect(calls[1]).not.toContain('ONLY-SLASH');

    for (const head of heads) {
      const marker = await engine.getPage(`distill-state/${head.session_slug}`, { sourceId: CAPTURE_SOURCE });
      expect((marker?.frontmatter as Record<string, unknown>)?.session_id).toBe(head.session_id);
      expect(await engine.getPage(`distilled/${head.session_slug}/g-1/mem-1`, { sourceId: CAPTURE_SOURCE })).not.toBeNull();
    }
  });

  test('an existing locator with conflicting durable artifacts is quarantined before provider work', async () => {
    await engine.putPage(
      'capture/legacy/prompt-1',
      {
        type: 'note', title: 'legacy', compiled_truth: 'must not be processed', timeline: '',
        frontmatter: { session_id: 'legacy', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );
    await engine.executeRaw(
      `INSERT INTO context_mirror_session_heads (
         source_id, session_id, session_slug, capture_slug_prefix, newest_capture_at, turn_count
       ) VALUES ($1, 'legacy', 'legacy', 'capture/legacy/', now() - INTERVAL '1 day', 1)`,
      [CAPTURE_SOURCE],
    );
    await engine.putPage(
      'distill-state/legacy',
      {
        type: 'note', title: 'foreign marker', compiled_truth: 'foreign marker', timeline: '',
        frontmatter: { session_id: 'different-session', generation: 1, kind: 'distill-marker' },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );

    await advanceSessionHeadBootstrap(engine, {
      sourceId: CAPTURE_SOURCE,
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
      idleHours: 6,
      sessionSlug: (sessionId) => sessionId,
    });

    const [head] = await engine.executeRaw<{ state: string; disposition: string | null; session_slug: string }>(
      `SELECT state, disposition, session_slug
         FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = 'legacy'`,
      [CAPTURE_SOURCE],
    );
    expect(head).toEqual({ state: 'quarantined', disposition: 'locator_ownership_conflict', session_slug: 'legacy' });
  });

  test('a missing-ID page under a multi-session prefix blocks provider work as ambiguous', async () => {
    for (const [slug, sessionId] of [
      ['capture/shared/known-a', 'exact-a'],
      ['capture/shared/known-b', 'exact-b'],
    ] as const) {
      await engine.putPage(
        slug,
        {
          type: 'note', title: sessionId, compiled_truth: sessionId, timeline: '',
          frontmatter: { session_id: sessionId, kind: 'prompt', turn: 1 },
        } as never,
        { sourceId: CAPTURE_SOURCE },
      );
    }
    await engine.putPage(
      'capture/shared/missing-id',
      {
        type: 'note', title: 'unknown', compiled_truth: 'AMBIGUOUS-BODY', timeline: '',
        frontmatter: { kind: 'reply', turn: 2 },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      throw new Error('must not be called');
    });

    const report = await distillCaptureSessions(engine, {
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
      sourceId: CAPTURE_SOURCE,
      maxSessions: 1,
      maxCalls: 1,
    });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('identity_ambiguous');
    expect(report.calls).toBe(0);
    expect(calls).toBe(0);
  });

  test('bootstrap completes a head only from an exact-identity legacy marker', async () => {
    await engine.putPage(
      'capture/exact-marker/prompt-1',
      {
        type: 'note', title: 'exact marker', compiled_truth: 'already processed', timeline: '',
        frontmatter: { session_id: 'exact-marker', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );
    await engine.putPage(
      'distill-state/exact-marker',
      {
        type: 'note', title: 'exact marker', compiled_truth: 'done', timeline: '',
        frontmatter: { session_id: 'exact-marker', generation: 1, kind: 'distill-marker' },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );

    await advanceSessionHeadBootstrap(engine, {
      sourceId: CAPTURE_SOURCE,
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
      idleHours: 6,
      sessionSlug: toSessionSlug,
    });

    const [head] = await engine.executeRaw<{ state: string; disposition: string | null }>(
      `SELECT state, disposition FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = 'exact-marker'`,
      [CAPTURE_SOURCE],
    );
    expect(head).toEqual({ state: 'complete', disposition: 'legacy_marker' });
  });

  test('a conflicting digest locator rolls back without advancing bootstrap', async () => {
    const sessionId = 'a b';
    const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, 12);
    await engine.executeRaw(
      `INSERT INTO context_mirror_session_heads (
         source_id, session_id, session_slug, capture_slug_prefix, newest_capture_at, turn_count
       ) VALUES ($1, 'a/b', 'a-b', 'capture/owner/', now() - INTERVAL '1 day', 1)`,
      [CAPTURE_SOURCE],
    );
    await engine.putPage(
      `distill-state/a-b--${digest}`,
      {
        type: 'note', title: 'foreign marker', compiled_truth: 'foreign marker', timeline: '',
        frontmatter: { session_id: 'foreign-owner', generation: 1, kind: 'distill-marker' },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );
    await engine.putPage(
      'capture/candidate/prompt-1',
      {
        type: 'note', title: sessionId, compiled_truth: 'candidate', timeline: '',
        frontmatter: { session_id: sessionId, kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );

    await expect(advanceSessionHeadBootstrap(engine, {
      sourceId: CAPTURE_SOURCE,
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
      idleHours: 6,
      sessionSlug: toSessionSlug,
    })).rejects.toThrow('context mirror session locator ownership conflict');

    const checkpoints = await engine.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM context_mirror_checkpoints
        WHERE source_id = $1 AND checkpoint_kind = 'capture_session_scan_v1'`,
      [CAPTURE_SOURCE],
    );
    expect(Number(checkpoints[0]?.count ?? 0)).toBe(0);
    const candidateHeads = await engine.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2`,
      [CAPTURE_SOURCE, sessionId],
    );
    expect(Number(candidateHeads[0]?.count ?? 0)).toBe(0);
  });

  test('an exact canary lease cannot claim or call for an unrelated pending session', async () => {
    for (const sessionId of ['older-unrelated', 'named-canary']) {
      await engine.putPage(
        `capture/${sessionId}/prompt-1`,
        {
          type: 'note',
          title: sessionId,
          compiled_truth: `redacted input for ${sessionId}`,
          timeline: '',
          frontmatter: { session_id: sessionId, kind: 'prompt', turn: 1 },
        } as never,
        { sourceId: CAPTURE_SOURCE },
      );
    }
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      return {
        text: JSON.stringify(['one bounded canary memory']),
        blocks: [],
        stopReason: 'end',
        usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'test:stub',
        providerId: 'test',
      };
    });
    const now = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const report = await distillCaptureSessions(engine, {
      now,
      sourceId: CAPTURE_SOURCE,
      sessionIds: ['named-canary'],
      maxSessions: 1,
      maxCalls: 1,
    });

    expect(report.status).toBe('partial');
    expect(report.stop_reason).toBe('session_limit');
    expect(report.selected).toBe(1);
    expect(report.calls).toBe(1);
    expect(calls).toBe(1);
    expect(report.sessions.map((session) => session.session_id)).toEqual(['named-canary']);
    expect(await engine.getPage('distilled/named-canary/g-1/mem-1', { sourceId: CAPTURE_SOURCE })).not.toBeNull();
    expect(await engine.getPage('distilled/older-unrelated/g-1/mem-1', { sourceId: CAPTURE_SOURCE })).toBeNull();
    const [unrelated] = await engine.executeRaw<{ state: string; attempt_count: number | string }>(
      `SELECT state, attempt_count FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2`,
      [CAPTURE_SOURCE, 'older-unrelated'],
    );
    expect(unrelated).toMatchObject({ state: 'pending' });
    expect(Number(unrelated.attempt_count)).toBe(0);
  });

  test('a missing named canary fails closed without falling back to backlog work', async () => {
    await engine.putPage(
      'capture/unrelated/prompt-1',
      {
        type: 'note', title: 'unrelated', compiled_truth: 'unrelated redacted input', timeline: '',
        frontmatter: { session_id: 'unrelated', kind: 'prompt', turn: 1 },
      } as never,
      { sourceId: CAPTURE_SOURCE },
    );
    let calls = 0;
    __setChatTransportForTests(async (): Promise<ChatResult> => {
      calls += 1;
      throw new Error('must not be called');
    });
    const report = await distillCaptureSessions(engine, {
      now: new Date(Date.now() + 24 * 60 * 60 * 1000),
      sourceId: CAPTURE_SOURCE,
      sessionIds: ['missing-canary'],
      maxSessions: 1,
      maxCalls: 1,
    });

    expect(report.status).toBe('failed');
    expect(report.stop_reason).toBe('target_unavailable');
    expect(report.selected).toBe(0);
    expect(report.calls).toBe(0);
    expect(calls).toBe(0);
    const [unrelated] = await engine.executeRaw<{ state: string; attempt_count: number | string }>(
      `SELECT state, attempt_count FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2`,
      [CAPTURE_SOURCE, 'unrelated'],
    );
    expect(unrelated).toMatchObject({ state: 'pending' });
    expect(Number(unrelated.attempt_count)).toBe(0);
  });

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
    const firstPage = await engine.getPage('distilled/chunkgap-sess-1/g-1/mem-1', { sourceId: CAPTURE_SOURCE });
    const page = await engine.getPage('distilled/chunkgap-sess-1/g-2/mem-1', { sourceId: CAPTURE_SOURCE });
    expect(firstPage?.compiled_truth).toBe('generation one memory');
    expect((firstPage?.frontmatter as Record<string, unknown>)?.generation).toBe(1);
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
