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
import { distillCaptureSessions } from '../src/core/connectors/distill.ts';
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
});
