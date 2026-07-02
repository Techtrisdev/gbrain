import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { operations } from '../src/core/operations.ts';
import type { AuthInfo } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SOURCE_ID = 'source-alpha';
const SOURCE_ID_BETA = 'source-beta';
const CLIENT_NAME = 'client-alpha';
const AGENT_NAME = 'agent-alpha';
const SLUG = 'guides/retrieval-outcome-proof';
const QUERY_TEXT = 'uniquequerytoken retrieval attribution marker';

interface RetrievalEventRow {
  query_id: string;
  client: string;
  source_id: string;
  agent_name: string | null;
  mode: string | null;
  intent: string | null;
  query_hash: string;
  result_count: number;
  top_result_slug: string | null;
  used_result_rank: number | null;
  used_at: string | null;
}

let engine: PGLiteEngine;

const auth: AuthInfo = {
  token: 'token-alpha',
  clientId: 'client-alpha-id',
  clientName: CLIENT_NAME,
  scopes: ['read', 'write'],
  sourceId: SOURCE_ID,
  allowedSources: [SOURCE_ID],
};

const betaAuth: AuthInfo = {
  token: 'token-beta',
  clientId: 'client-beta-id',
  clientName: 'client-beta',
  scopes: ['read', 'write'],
  sourceId: SOURCE_ID_BETA,
  allowedSources: [SOURCE_ID_BETA],
};

function parseText<T>(result: Awaited<ReturnType<typeof dispatchToolCall>>): T {
  return JSON.parse(result.content[0]?.text ?? 'null') as T;
}

function retrievalQueryId(result: Awaited<ReturnType<typeof dispatchToolCall>>): string {
  const meta = result._meta?.retrieval as { query_id?: unknown } | undefined;
  expect(typeof meta?.query_id).toBe('string');
  return meta!.query_id as string;
}

async function seedPage(): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, '{"federated": true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [SOURCE_ID, SOURCE_ID],
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config)
       VALUES ($1, $2, '{"federated": true}'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
    [SOURCE_ID_BETA, SOURCE_ID_BETA],
  );
  await engine.putPage(SLUG, {
    type: 'guide',
    title: 'Retrieval outcome proof',
    compiled_truth: 'Uniquequerytoken retrieval attribution marker for outcome capture.',
    timeline: '',
    frontmatter: {},
  }, { sourceId: SOURCE_ID });
  await engine.upsertChunks(SLUG, [
    {
      chunk_index: 0,
      chunk_text: 'Uniquequerytoken retrieval attribution marker for outcome capture.',
      chunk_source: 'compiled_truth',
    },
  ], { sourceId: SOURCE_ID });
}

async function waitForEvent(queryId: string): Promise<RetrievalEventRow> {
  for (let i = 0; i < 40; i += 1) {
    const rows = await engine.executeRaw<RetrievalEventRow>(
      `SELECT query_id, client, source_id, agent_name, mode, intent, query_hash,
              result_count, top_result_slug, used_result_rank, used_at::text AS used_at
         FROM retrieval_events
        WHERE query_id = $1`,
      [queryId],
    );
    if (rows[0]) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`retrieval_event not written for query_id ${queryId}`);
}

async function runQuery(): Promise<{ queryId: string; row: RetrievalEventRow; body: unknown[] }> {
  const result = await dispatchToolCall(engine, 'query', { query: QUERY_TEXT, limit: 5 }, {
    remote: true,
    sourceId: SOURCE_ID,
    auth,
    agentName: AGENT_NAME,
  });
  expect(result.isError).toBeUndefined();
  const body = parseText<unknown[]>(result);
  expect(Array.isArray(body)).toBe(true);
  expect(body.length).toBeGreaterThan(0);
  const queryId = retrievalQueryId(result);
  const row = await waitForEvent(queryId);
  return { queryId, row, body };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
}, 30_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await seedPage();
});

describe('retrieval_events migration', () => {
  test('v100 applies idempotently and verify passes on PGLite', async () => {
    const migration = MIGRATIONS.find((m) => m.version === 100);
    expect(migration).toBeDefined();
    expect(migration!.idempotent).toBe(true);
    expect(typeof migration!.verify).toBe('function');

    const local = new PGLiteEngine();
    try {
      await local.connect({});
      await local.initSchema();
      await local.executeRaw('DROP TABLE IF EXISTS retrieval_events');
      await local.setConfig('version', '99');

      const result = await runMigrations(local);
      expect(result.current).toBe(LATEST_VERSION);
      expect(await migration!.verify!(local)).toBe(true);

      await local.runMigration(migration!.version, migration!.sql);
      expect(await migration!.verify!(local)).toBe(true);
    } finally {
      await local.disconnect();
    }
  }, 30_000);
});

describe('retrieval event write path and ack path', () => {
  test('query writes caller-attributed retrieval_event and returns query_id in MCP metadata', async () => {
    const { queryId, row, body } = await runQuery();

    expect(queryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row).toMatchObject({
      query_id: queryId,
      client: CLIENT_NAME,
      source_id: SOURCE_ID,
      agent_name: AGENT_NAME,
      mode: 'balanced',
      intent: 'general',
      top_result_slug: SLUG,
    });
    expect(row.result_count).toBe(body.length);
    expect(row.query_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('record_retrieval_use records a known query_id and is remote write-scoped', async () => {
    const op = operations.find((candidate) => candidate.name === 'record_retrieval_use');
    expect(op?.scope).toBe('write');
    expect(op?.localOnly).toBeUndefined();

    const { queryId } = await runQuery();
    const ack = await dispatchToolCall(engine, 'record_retrieval_use', {
      query_id: queryId,
      used_rank: 1,
    }, {
      remote: true,
      sourceId: SOURCE_ID,
      auth,
      agentName: AGENT_NAME,
    });
    expect(ack.isError).toBeUndefined();
    expect(parseText<{ status: string; query_id: string; used_result_rank: number }>(ack)).toMatchObject({
      status: 'recorded',
      query_id: queryId,
      used_result_rank: 1,
    });

    const rows = await engine.executeRaw<RetrievalEventRow>(
      `SELECT query_id, client, source_id, agent_name, mode, intent, query_hash,
              result_count, top_result_slug, used_result_rank, used_at::text AS used_at
         FROM retrieval_events
        WHERE query_id = $1`,
      [queryId],
    );
    expect(rows[0]?.used_result_rank).toBe(1);
    expect(rows[0]?.used_at).toBeTruthy();
  });

  test('record_retrieval_use rejects a known query_id from a different source without mutating the row', async () => {
    const { queryId, row } = await runQuery();
    expect(row.source_id).toBe(SOURCE_ID);
    expect(row.used_result_rank).toBeNull();
    expect(row.used_at).toBeNull();

    const wrongSourceAck = await dispatchToolCall(engine, 'record_retrieval_use', {
      query_id: queryId,
      used_rank: 1,
    }, {
      remote: true,
      sourceId: SOURCE_ID_BETA,
      auth: betaAuth,
      agentName: 'agent-beta',
    });

    expect(wrongSourceAck.isError).toBe(true);
    expect(parseText<{ error: string }>(wrongSourceAck).error).toBe('retrieval_event_not_found');
    expect(await waitForEvent(queryId)).toEqual(row);

    const sameSourceAck = await dispatchToolCall(engine, 'record_retrieval_use', {
      query_id: queryId,
      used_rank: 1,
    }, {
      remote: true,
      sourceId: SOURCE_ID,
      auth,
      agentName: AGENT_NAME,
    });

    expect(sameSourceAck.isError).toBeUndefined();
    expect(parseText<{ status: string; query_id: string; used_result_rank: number }>(sameSourceAck)).toMatchObject({
      status: 'recorded',
      query_id: queryId,
      used_result_rank: 1,
    });
    expect((await waitForEvent(queryId)).used_result_rank).toBe(1);
  });

  test('record_retrieval_use rejects used_rank above result_count without mutating the row', async () => {
    const queryId = '11111111-1111-4111-8111-111111111111';
    await engine.executeRaw(
      `INSERT INTO retrieval_events
         (query_id, client, source_id, agent_name, mode, intent, query_hash, result_count, top_result_slug)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        queryId,
        CLIENT_NAME,
        SOURCE_ID,
        AGENT_NAME,
        'balanced',
        'general',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        2,
        SLUG,
      ],
    );
    const row = await waitForEvent(queryId);
    expect(row.result_count).toBe(2);
    expect(row.used_result_rank).toBeNull();
    expect(row.used_at).toBeNull();

    const tooHighAck = await dispatchToolCall(engine, 'record_retrieval_use', {
      query_id: queryId,
      used_rank: 99,
    }, {
      remote: true,
      sourceId: SOURCE_ID,
      auth,
      agentName: AGENT_NAME,
    });

    expect(tooHighAck.isError).toBe(true);
    expect(parseText<{ error: string }>(tooHighAck).error).toBe('invalid_params');
    expect(await waitForEvent(queryId)).toEqual(row);

    const validAck = await dispatchToolCall(engine, 'record_retrieval_use', {
      query_id: queryId,
      used_rank: 2,
    }, {
      remote: true,
      sourceId: SOURCE_ID,
      auth,
      agentName: AGENT_NAME,
    });

    expect(validAck.isError).toBeUndefined();
    expect(parseText<{ status: string; query_id: string; used_result_rank: number }>(validAck)).toMatchObject({
      status: 'recorded',
      query_id: queryId,
      used_result_rank: 2,
    });
    expect((await waitForEvent(queryId)).used_result_rank).toBe(2);
  });

  test('unknown query_id is rejected without creating an orphan row', async () => {
    const unknownId = '00000000-0000-4000-8000-000000000000';
    const before = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM retrieval_events');

    const ack = await dispatchToolCall(engine, 'record_retrieval_use', {
      query_id: unknownId,
      used_rank: 1,
    }, {
      remote: true,
      sourceId: SOURCE_ID,
      auth,
      agentName: AGENT_NAME,
    });

    expect(ack.isError).toBe(true);
    expect(parseText<{ error: string }>(ack).error).toBe('retrieval_event_not_found');
    const after = await engine.executeRaw<{ n: number }>('SELECT COUNT(*)::int AS n FROM retrieval_events');
    const orphan = await engine.executeRaw<{ query_id: string }>(
      'SELECT query_id FROM retrieval_events WHERE query_id = $1',
      [unknownId],
    );
    expect(after[0].n).toBe(before[0].n);
    expect(orphan).toEqual([]);
  });

  test('stored retrieval_event keeps only the query hash, not raw query text', async () => {
    const { row } = await runQuery();

    expect(row.query_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.query_hash).not.toBe(QUERY_TEXT);
    expect(JSON.stringify(row)).not.toContain(QUERY_TEXT);
    expect(Object.keys(row)).not.toContain('query');
    expect(Object.keys(row)).not.toContain('query_text');
  });
});
