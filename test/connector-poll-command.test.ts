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
  pollConnectorTargets,
  resolveConnectorPollTargets,
} from '../src/commands/connector.ts';

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
