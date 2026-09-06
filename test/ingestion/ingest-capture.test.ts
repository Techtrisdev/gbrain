/**
 * ingest_capture Minion handler tests. Exercises the slug-resolution
 * fallback chain, content-type gating (binary rejection), validation,
 * and the importFromContent integration against an in-memory PGLite.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  defaultSlugForEvent,
  makeIngestCaptureHandler as makeRawIngestCaptureHandler,
  signIngestCaptureSourceAuthorization,
} from '../../src/core/minions/handlers/ingest-capture.ts';
import {
  computeContentHash,
  type IngestionEvent,
} from '../../src/core/ingestion/types.ts';
import type { MinionJobContext } from '../../src/core/minions/types.ts';
import { UnrecoverableError } from '../../src/core/minions/types.ts';

let engine: PGLiteEngine;
const TEST_AUTH_SECRET = 'test-ingest-queue-auth-secret-32-bytes-minimum';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('webhook-test', 'webhook-test') ON CONFLICT DO NOTHING`,
  );
});

function makeEvent(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  const content = overrides.content ?? '# captured thought';
  return {
    source_id: 'webhook-test',
    source_kind: 'webhook',
    source_uri: 'mcp-webhook:client-x:1234',
    received_at: new Date('2026-05-20T12:00:00Z').toISOString(),
    content_type: 'text/markdown',
    content,
    content_hash: overrides.content_hash ?? computeContentHash(content),
    ...overrides,
  };
}

function makeJob(data: Record<string, unknown>): MinionJobContext {
  const event = data.event as IngestionEvent | undefined;
  const jobData = event && !Object.prototype.hasOwnProperty.call(data, 'source_authorization')
    ? {
        ...data,
        source_authorization: signIngestCaptureSourceAuthorization(
          TEST_AUTH_SECRET,
          {
            version: 2,
            transport: 'daemon',
            producer_id: event.source_kind,
            source_id: event.source_id,
          },
          { event, slug: data.slug, noEmbed: data.noEmbed },
        ),
      }
    : data;
  return {
    id: 1,
    name: 'ingest_capture',
    data: jobData,
    attempts_made: 1,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

function makeIngestCaptureHandler(_engine: PGLiteEngine) {
  return makeRawIngestCaptureHandler(engine, { authorizationSecret: TEST_AUTH_SECRET });
}

describe('defaultSlugForEvent', () => {
  test('builds inbox/YYYY-MM-DD-<hash6> slug', () => {
    const ev = makeEvent({ content_hash: 'abcdef1234567890'.padEnd(64, '0') });
    const slug = defaultSlugForEvent(ev, new Date('2026-05-20T00:00:00Z'));
    expect(slug).toBe('inbox/2026-05-20-abcdef');
  });

  test('stable for same content (deterministic hash)', () => {
    const ev = makeEvent({ content: 'same thought' });
    const date = new Date('2026-05-20T00:00:00Z');
    expect(defaultSlugForEvent(ev, date)).toBe(defaultSlugForEvent(ev, date));
  });

  test('UTC date math (no tz drift)', () => {
    const ev = makeEvent();
    const slug = defaultSlugForEvent(ev, new Date('2026-01-05T23:59:59Z'));
    expect(slug).toMatch(/^inbox\/2026-01-05-/);
  });
});

describe('ingest_capture handler — slug resolution', () => {
  test('uses caller-provided job.data.slug when present', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'with explicit slug' });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/specific/page' }));
    expect(result.slug).toBe('wiki/specific/page');
    expect(result.status).toBe('imported');
  });

  test('uses event.metadata.slug when set', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'metadata slug', metadata: { slug: 'inbox/custom-from-meta' } });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toBe('inbox/custom-from-meta');
  });

  test('falls back to inbox/YYYY-MM-DD-<hash6> when no slug provided', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'fallback slug' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.slug).toMatch(/^inbox\/\d{4}-\d{2}-\d{2}-[a-f0-9]{6}$/);
  });
});

describe('ingest_capture handler — validation + routing', () => {
  test('throws when event missing', async () => {
    const handler = makeIngestCaptureHandler(engine);
    await expect(handler(makeJob({}))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  test('throws on invalid event payload (caught at the handler boundary)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = { ...makeEvent(), content_hash: 'short' };
    await expect(handler(makeJob({ event: ev }))).rejects.toBeInstanceOf(UnrecoverableError);
  });

  test('missing worker authorization secret fails retryably and writes nothing', async () => {
    const handler = makeRawIngestCaptureHandler(engine, { authorizationSecret: '' });
    const ev = makeEvent({ content: 'must not write without verifier secret' });
    const slug = 'inbox/missing-verifier-secret';

    await expect(handler(makeJob({ event: ev, slug }))).rejects.toThrow(
      /GBRAIN_INGEST_QUEUE_HMAC_SECRET is not configured/,
    );
    expect(await engine.getPage(slug, { sourceId: 'webhook-test' })).toBeNull();
  });

  test('rejects binary content_type with helpful message', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content_type: 'image/*',
      content: '/path/to/screenshot.png',
      content_hash: computeContentHash('/path/to/screenshot.png'),
    });
    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(
      /content_type 'image\/\*' requires a content-type processor/,
    );
  });

  test('untrusted_payload flag round-trips to the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'untrusted', untrusted_payload: true });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(true);
  });

  test('trusted (default) payload round-trips as false', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'trusted' });
    const result = await handler(makeJob({ event: ev }));
    expect(result.untrusted_payload).toBe(false);
  });

  test('source provenance round-trips into the result', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'with provenance',
      source_kind: 'inbox-folder',
      source_uri: '/Users/test/.gbrain/inbox/note.md',
    });
    const result = await handler(makeJob({ event: ev }));
    expect(result.source_kind).toBe('inbox-folder');
    expect(result.source_uri).toBe('/Users/test/.gbrain/inbox/note.md');
  });

  test('rejects a pre-fix OAuth webhook job without server source authorization', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'legacy public webhook job',
      metadata: { client_id: 'gbrain_cl_legacy' },
    });

    await expect(handler(makeJob({ event: ev, source_authorization: null }))).rejects.toThrow(
      /missing signed source authorization/i,
    );
  });

  test('rejects a pre-fix webhook with a caller-chosen URI and no signed authorization', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'legacy custom-uri public webhook job',
      source_uri: 'https://example.invalid/attacker-chosen',
      metadata: { client_id: 'gbrain_cl_legacy' },
      untrusted_payload: true,
    });

    await expect(handler(makeJob({ event: ev, source_authorization: null }))).rejects.toThrow(
      /missing signed source authorization/i,
    );
  });

  test('rejects an OAuth webhook job whose authorization contradicts the event source', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'contradictory public webhook job',
      metadata: { client_id: 'gbrain_cl_client_x' },
    });

    const source_authorization = signIngestCaptureSourceAuthorization(
      TEST_AUTH_SECRET,
      {
        version: 2,
        transport: 'oauth',
        client_id: 'gbrain_cl_client_x',
        source_id: 'shared',
      },
      { event: ev },
    );
    await expect(handler(makeJob({ event: ev, source_authorization }))).rejects.toThrow(
      /authorized source 'shared'.*event source 'webhook-test'/i,
    );
  });

  test('rejects malformed OAuth webhook source authorization', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'malformed public webhook job',
      metadata: { client_id: 'gbrain_cl_client_x' },
    });
    const malformed = [
      { version: 1, transport: 'oauth', client_id: 'gbrain_cl_client_x', source_id: 'webhook-test' },
      { version: 2, transport: 'header', client_id: 'gbrain_cl_client_x', source_id: 'webhook-test' },
      { version: 2, transport: 'oauth', client_id: '', source_id: 'webhook-test', signature: 'a'.repeat(64) },
      { version: 2, transport: 'oauth', client_id: 'gbrain_cl_client_x', source_id: '', signature: 'a'.repeat(64) },
    ];

    for (const source_authorization of malformed) {
      await expect(handler(makeJob({ event: ev, source_authorization }))).rejects.toThrow(
        /invalid signed source authorization/i,
      );
    }
  });

  test('rejects a forged source authorization signature', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'forged signature attempt' });
    const valid = signIngestCaptureSourceAuthorization(
      TEST_AUTH_SECRET,
      {
        version: 2,
        transport: 'daemon',
        producer_id: ev.source_kind,
        source_id: ev.source_id,
      },
      { event: ev },
    );

    await expect(handler(makeJob({
      event: ev,
      source_authorization: { ...valid, signature: '0'.repeat(64) },
    }))).rejects.toThrow(/invalid source authorization signature/i);
  });

  test('rejects signed metadata whose content hash does not match its content', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'actual body',
      content_hash: computeContentHash('different body'),
    });

    await expect(handler(makeJob({ event: ev }))).rejects.toThrow(
      /content hash does not match signed event content/i,
    );
  });

  test('rejects a destination changed through event metadata after signing', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const signedEvent = makeEvent({
      content: 'metadata destination integrity',
      metadata: { slug: 'inbox/original' },
    });
    const source_authorization = signIngestCaptureSourceAuthorization(
      TEST_AUTH_SECRET,
      {
        version: 2,
        transport: 'daemon',
        producer_id: signedEvent.source_kind,
        source_id: signedEvent.source_id,
      },
      { event: signedEvent },
    );
    const changedEvent = {
      ...signedEvent,
      metadata: { slug: 'inbox/changed-after-signing' },
    };

    await expect(handler(makeJob({ event: changedEvent, source_authorization }))).rejects.toThrow(
      /invalid source authorization signature/i,
    );
  });

  test('normalizes an empty explicit slug to the same signed default destination', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'empty slug normalization' });
    const source_authorization = signIngestCaptureSourceAuthorization(
      TEST_AUTH_SECRET,
      {
        version: 2,
        transport: 'daemon',
        producer_id: ev.source_kind,
        source_id: ev.source_id,
      },
      { event: ev, slug: '' },
    );

    const result = await handler(makeJob({ event: ev, source_authorization }));
    expect(result.status).toBe('imported');
    expect(result.slug).toMatch(/^inbox\//);
  });

  test('normalizes an empty metadata slug to the same signed default destination', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: 'empty metadata slug normalization',
      metadata: { slug: '' },
    });

    const result = await handler(makeJob({ event: ev }));
    expect(result.status).toBe('imported');
    expect(result.slug).toMatch(/^inbox\//);
  });

  test('uses the same lowercase destination for signing and processing', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'uppercase destination normalization' });

    const result = await handler(makeJob({ event: ev, slug: 'Wiki/Upper-Page' }));
    expect(result.status).toBe('imported');
    expect(result.slug).toBe('wiki/upper-page');
    expect(await engine.getPage('wiki/upper-page', { sourceId: 'webhook-test' })).not.toBeNull();
  });

  test('rejects a signed queued job with a malformed destination slug as unrecoverable', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: 'malformed destination' });

    await expect(handler(makeJob({ event: ev, slug: '../outside' }))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});

describe('ingest_capture handler — integration with importFromContent', () => {
  test('imported event lands as a page in the DB', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({
      content: '---\ntitle: Test Page\n---\n\n# E2E import\n\nbody content',
    });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/e2e-test' }));
    expect(result.status).toBe('imported');

    const page = await engine.getPage('wiki/e2e-test');
    expect(page).not.toBeNull();
    expect(page?.compiled_truth).toContain('E2E import');
  });

  test('repeat ingest of same content returns skipped status (content_hash dedup at importFromContent level)', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const ev = makeEvent({ content: '# stable content' });
    const result1 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result1.status).toBe('imported');

    const result2 = await handler(makeJob({ event: ev, slug: 'wiki/stable' }));
    expect(result2.status).toBe('skipped');
  });

  test('chunks count is reported on imported events', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const longContent = '---\ntitle: long\n---\n\n' + 'Paragraph.\n\n'.repeat(50);
    const ev = makeEvent({ content: longContent });
    const result = await handler(makeJob({ event: ev, slug: 'wiki/long' }));
    expect(result.chunks).toBeGreaterThan(0);
  });

  test('OAuth webhook page and chunks land only in the server-authorized source', async () => {
    const handler = makeIngestCaptureHandler(engine);
    const slug = 'wiki/source-bound';
    await engine.putPage(slug, {
      type: 'note',
      title: 'Default sentinel',
      compiled_truth: 'default source must remain unchanged',
      timeline: '',
      frontmatter: {},
      content_hash: 'default-sentinel',
    }, { sourceId: 'default' });
    const ev = makeEvent({
      content: '# source-bound content\n\nThis must stay in webhook-test.',
      metadata: { client_id: 'gbrain_cl_client_x' },
      untrusted_payload: true,
    });

    const source_authorization = signIngestCaptureSourceAuthorization(
      TEST_AUTH_SECRET,
      {
        version: 2,
        transport: 'oauth',
        client_id: 'gbrain_cl_client_x',
        source_id: 'webhook-test',
      },
      { event: ev, slug },
    );

    const result = await handler(makeJob({
      event: ev,
      slug,
      source_authorization,
    }));

    expect(result.status).toBe('imported');
    expect(await engine.getPage(slug, { sourceId: 'webhook-test' })).not.toBeNull();
    expect(await engine.getChunks(slug, { sourceId: 'webhook-test' })).not.toHaveLength(0);
    expect((await engine.getPage(slug, { sourceId: 'default' }))?.compiled_truth).toBe(
      'default source must remain unchanged',
    );
  });
});
