/**
 * Tests for src/core/connectors/poll.ts — the `connector_poll` Minion job core
 * + the autopilot connector-dispatch selection logic (TECH-2038).
 *
 * No DB, no Express: the engine is faked (records executeRaw calls + canned
 * returns) and the connector is registered as a stub via registerConnector. The
 * six AC6 scenarios:
 *   1. selection picks ONLY enabled + no-local_path connector sources,
 *   2. the kill-switch (env + per-source flag) suppresses ALL connector dispatch,
 *   3. a poll calls the connector's backfill,
 *   4. reconciliation emits a TOMBSTONE candidate (not a delete) for vanished records,
 *   5. default-off is respected (configured-but-disabled never dispatches/polls),
 *   6. (covered across the above) idempotent re-run shape.
 */

import { describe, test, expect } from 'bun:test';
import {
  selectEnabledConnectorSources,
  isEnabledConnectorSource,
  connectorAutomationDisabled,
  computeTombstoneCandidates,
  runConnectorPoll,
  connectorPollBreakerTripped,
  CONNECTOR_POLL_BREAKER_THRESHOLD,
  readConnectorsConfig,
  parseSourceConfigObject,
  TOMBSTONE_VERSION_SUFFIX,
  type ConnectorSourceRow,
} from '../src/core/connectors/poll.ts';
import {
  registerConnector,
  type SaaSConnector,
  type ConnectorSource,
} from '../src/core/connectors/base.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NO_ENV: Record<string, string | undefined> = {};

function connectorSource(
  id: string,
  config: Record<string, unknown>,
  local_path: string | null = null,
): ConnectorSourceRow {
  return { id, local_path, config };
}

/** A config with a single provider entry at the given enabled state. */
function withConnector(provider: string, enabled: boolean, extra: Record<string, unknown> = {}) {
  return { connectors: { [provider]: { enabled, account: 'acct-1', secret: 'x', ...extra } } };
}

// ── 1. selection: only enabled + no-local_path ───────────────────────────────

describe('selectEnabledConnectorSources — AC2 selection', () => {
  test('selects an enabled connector source with no local_path', () => {
    const sources = [connectorSource('s1', withConnector('linear', true))];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([
      { sourceId: 's1', provider: 'linear' },
    ]);
  });

  test('EXCLUDES a source with a local_path even when a connector is enabled', () => {
    const sources = [connectorSource('git1', withConnector('linear', true), '/repos/git1')];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([]);
  });

  test('EXCLUDES a source with no enabled connector (default-off — AC5)', () => {
    const sources = [connectorSource('s1', withConnector('linear', false))];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([]);
  });

  test('EXCLUDES a source with no connectors map at all', () => {
    const sources = [connectorSource('s1', { federated: true })];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([]);
  });

  test('emits one target per ENABLED provider; skips disabled siblings; sorted by provider', () => {
    const sources = [
      connectorSource('s1', {
        connectors: {
          slack: { enabled: true },
          linear: { enabled: true },
          notion: { enabled: false }, // default-off sibling — excluded
        },
      }),
    ];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([
      { sourceId: 's1', provider: 'linear' },
      { sourceId: 's1', provider: 'slack' },
    ]);
  });

  test('mixed fleet: only the enabled connector source is dispatched', () => {
    const sources = [
      connectorSource('git1', { connectors: {} }, '/repos/git1'), // git source
      connectorSource('conn-on', withConnector('linear', true)), // enabled connector
      connectorSource('conn-off', withConnector('slack', false)), // disabled connector
    ];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([
      { sourceId: 'conn-on', provider: 'linear' },
    ]);
  });

  test('config arriving as a JSON string is parsed (PGLite driver shape)', () => {
    const sources = [connectorSource('s1', JSON.stringify(withConnector('linear', true)) as unknown as Record<string, unknown>)];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([
      { sourceId: 's1', provider: 'linear' },
    ]);
  });
});

// ── 2. kill-switch suppresses everything ─────────────────────────────────────

describe('kill-switch — AC4: disables ALL connector automation', () => {
  test('env GBRAIN_CONNECTORS_KILLSWITCH=1 suppresses every target', () => {
    const sources = [
      connectorSource('s1', withConnector('linear', true)),
      connectorSource('s2', withConnector('slack', true)),
    ];
    expect(selectEnabledConnectorSources(sources, { GBRAIN_CONNECTORS_KILLSWITCH: '1' })).toEqual([]);
  });

  test('per-source config flag connectors_killswitch=true suppresses that source only', () => {
    const sources = [
      connectorSource('s1', { ...withConnector('linear', true), connectors_killswitch: true }),
      connectorSource('s2', withConnector('slack', true)),
    ];
    expect(selectEnabledConnectorSources(sources, NO_ENV)).toEqual([
      { sourceId: 's2', provider: 'slack' },
    ]);
  });

  test('connectorAutomationDisabled: falsey env values do NOT trip the switch', () => {
    const src = { config: withConnector('linear', true) };
    expect(connectorAutomationDisabled(src, { GBRAIN_CONNECTORS_KILLSWITCH: '0' })).toBe(false);
    expect(connectorAutomationDisabled(src, { GBRAIN_CONNECTORS_KILLSWITCH: 'false' })).toBe(false);
    expect(connectorAutomationDisabled(src, { GBRAIN_CONNECTORS_KILLSWITCH: '' })).toBe(false);
    expect(connectorAutomationDisabled(src, {})).toBe(false);
  });

  test('connectorAutomationDisabled: truthy env trips the switch', () => {
    const src = { config: {} };
    expect(connectorAutomationDisabled(src, { GBRAIN_CONNECTORS_KILLSWITCH: '1' })).toBe(true);
    expect(connectorAutomationDisabled(src, { GBRAIN_CONNECTORS_KILLSWITCH: 'true' })).toBe(true);
    expect(connectorAutomationDisabled(src, { GBRAIN_CONNECTORS_KILLSWITCH: 'yes' })).toBe(true);
  });

  test('isEnabledConnectorSource is false under kill-switch even with an enabled connector', () => {
    const src = connectorSource('s1', withConnector('linear', true));
    expect(isEnabledConnectorSource(src, NO_ENV)).toBe(true);
    expect(isEnabledConnectorSource(src, { GBRAIN_CONNECTORS_KILLSWITCH: '1' })).toBe(false);
  });
});

// ── 3 + 5. runConnectorPoll: calls backfill / respects default-off ───────────

/** A fake engine: routes the source-row SELECT, the known-record-ids SELECT, and
 *  the connector_candidates INSERT/SELECT through canned returns; records calls. */
function makeFakeEngine(opts: {
  sourceRow?: { id: string; config: Record<string, unknown> | string; archived?: boolean } | null;
  knownRecordIds?: string[];
  conflict?: boolean;
  /** Status history (most-recent first) the breaker query returns. */
  breakerHistory?: string[];
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const engine = {
    kind: 'postgres' as const,
    executeRaw: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      if (/FROM minion_jobs/.test(sql)) {
        return (opts.breakerHistory ?? []).map((status) => ({ status }));
      }
      if (/FROM sources WHERE id/.test(sql)) {
        return opts.sourceRow === null ? [] : [opts.sourceRow ?? { id: 's1', config: {} }];
      }
      if (/FROM connector_candidates/.test(sql) && /DISTINCT source_record_id/.test(sql)) {
        return (opts.knownRecordIds ?? []).map((source_record_id) => ({ source_record_id }));
      }
      if (/INSERT INTO connector_candidates/.test(sql)) {
        return opts.conflict ? [] : [{ id: 1 }];
      }
      // toRow's fetch-on-conflict SELECT.
      return [{ id: 1 }];
    },
  } as unknown as BrainEngine;
  return { engine, calls };
}

/** A stub connector whose backfill records the call + returns a fixed landed count. */
function makeStubConnector(provider: string, landed: number) {
  const backfillCalls: ConnectorSource[] = [];
  const connector: SaaSConnector = {
    provider,
    signatureHeader: `x-${provider}-signature`,
    verifyWebhook: () => true,
    accountFromPayload: () => 'acct-1',
    normalize: () => [],
    toCandidate: (r, sourceId) => ({ source_id: sourceId, source_record_id: r.sourceRecordId }),
    backfill: async (_engine, source) => {
      backfillCalls.push(source);
      return landed;
    },
  };
  registerConnector(connector);
  return { connector, backfillCalls };
}

describe('runConnectorPoll — AC1: calls backfill, idempotent', () => {
  test('AC3: resolves provider + calls the connector backfill, returns landed count', async () => {
    const { backfillCalls } = makeStubConnector('poll-probe-a', 7);
    const { engine } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-probe-a', true) },
    });
    const result = await runConnectorPoll(engine, { sourceId: 's1', provider: 'poll-probe-a' }, NO_ENV);
    expect(result.landed).toBe(7);
    expect(result.tombstoned).toBe(0);
    expect(result.skippedReason).toBeUndefined();
    // backfill was called exactly once with the source row.
    expect(backfillCalls).toHaveLength(1);
    expect(backfillCalls[0].id).toBe('s1');
  });

  test('AC5: a configured-but-DISABLED connector is a clean no-op (no backfill)', async () => {
    const { backfillCalls } = makeStubConnector('poll-probe-b', 5);
    const { engine } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-probe-b', false) },
    });
    const result = await runConnectorPoll(engine, { sourceId: 's1', provider: 'poll-probe-b' }, NO_ENV);
    expect(result.skippedReason).toBe('connector_not_enabled');
    expect(result.landed).toBe(0);
    expect(backfillCalls).toHaveLength(0);
  });

  test('a missing source short-circuits before touching the connector', async () => {
    const { backfillCalls } = makeStubConnector('poll-probe-c', 1);
    const { engine } = makeFakeEngine({ sourceRow: null });
    const result = await runConnectorPoll(engine, { sourceId: 'gone', provider: 'poll-probe-c' }, NO_ENV);
    expect(result.skippedReason).toBe('source_not_found');
    expect(backfillCalls).toHaveLength(0);
  });

  test('an unregistered provider short-circuits', async () => {
    const { engine } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('no-such-provider-xyz', true) },
    });
    const result = await runConnectorPoll(engine, { sourceId: 's1', provider: 'no-such-provider-xyz' }, NO_ENV);
    expect(result.skippedReason).toBe('connector_not_registered');
  });

  // ── Fix #1 (kill-switch gates RUN time) ──────────────────────────────────────
  test('REVIEW#1: kill-switch (env) at RUN time skips before backfill', async () => {
    const { backfillCalls } = makeStubConnector('poll-killsw-a', 9);
    const { engine } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-killsw-a', true) },
    });
    // Connector is ENABLED, but the kill-switch is tripped in the injected env.
    const result = await runConnectorPoll(
      engine,
      { sourceId: 's1', provider: 'poll-killsw-a' },
      { GBRAIN_CONNECTORS_KILLSWITCH: '1' },
    );
    expect(result.skippedReason).toBe('killswitch_tripped');
    expect(result.landed).toBe(0);
    // The whole point: NO outbound backfill fired for an in-flight job.
    expect(backfillCalls).toHaveLength(0);
  });

  test('REVIEW#1: kill-switch (per-source config flag) at RUN time skips before backfill', async () => {
    const { backfillCalls } = makeStubConnector('poll-killsw-b', 4);
    const { engine } = makeFakeEngine({
      sourceRow: {
        id: 's1',
        config: { ...withConnector('poll-killsw-b', true), connectors_killswitch: true },
      },
    });
    const result = await runConnectorPoll(engine, { sourceId: 's1', provider: 'poll-killsw-b' }, NO_ENV);
    expect(result.skippedReason).toBe('killswitch_tripped');
    expect(backfillCalls).toHaveLength(0);
  });

  // ── Fix #5 (run-time archived re-check) ──────────────────────────────────────
  test('REVIEW#5: an archived source skips at RUN time before backfill', async () => {
    const { backfillCalls } = makeStubConnector('poll-arch-a', 6);
    const { engine } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-arch-a', true), archived: true },
    });
    const result = await runConnectorPoll(engine, { sourceId: 's1', provider: 'poll-arch-a' }, NO_ENV);
    expect(result.skippedReason).toBe('source_archived');
    expect(backfillCalls).toHaveLength(0);
  });
});

// ── 4. reconciliation: tombstone, not delete ─────────────────────────────────

describe('computeTombstoneCandidates — AC5 reconciliation (pure)', () => {
  test('a vanished known record yields a tombstone candidate', () => {
    const tombs = computeTombstoneCandidates({
      sourceId: 's1',
      provider: 'linear',
      knownRecordIds: ['rec-1', 'rec-2', 'rec-3'],
      seenRecordIds: ['rec-1', 'rec-3'], // rec-2 vanished
    });
    expect(tombs).toHaveLength(1);
    const t = tombs[0];
    expect(t.source_record_id).toBe('rec-2');
    expect(t.version).toBe(`1:${TOMBSTONE_VERSION_SUFFIX}`);
    expect(t.provider).toBe('linear');
    expect(t.proposed_slug).toBe('linear-tombstone-rec-2');
    expect(t.proposed_markdown).toContain('vanished');
    expect(t.redactions).toEqual([{ field: 'record', action: 'tombstone' }]);
  });

  test('no vanish → no tombstones (steady state)', () => {
    const tombs = computeTombstoneCandidates({
      sourceId: 's1',
      provider: 'linear',
      knownRecordIds: ['rec-1', 'rec-2'],
      seenRecordIds: ['rec-1', 'rec-2'],
    });
    expect(tombs).toEqual([]);
  });

  test('a NEW record (seen but not known) is NOT tombstoned — backfill owns it', () => {
    const tombs = computeTombstoneCandidates({
      sourceId: 's1',
      provider: 'linear',
      knownRecordIds: ['rec-1'],
      seenRecordIds: ['rec-1', 'rec-NEW'],
    });
    expect(tombs).toEqual([]);
  });

  test('multiple vanished records each get exactly one tombstone (de-duped)', () => {
    const tombs = computeTombstoneCandidates({
      sourceId: 's1',
      provider: 'linear',
      knownRecordIds: ['a', 'b', 'b', 'c'], // duplicate 'b' in known set
      seenRecordIds: ['a'],
    });
    expect(tombs.map((t) => t.source_record_id).sort()).toEqual(['b', 'c']);
  });
});

describe('runConnectorPoll reconciliation — writes a tombstone, never a delete', () => {
  test('vanished record → tombstone INSERT via toRow; NO DELETE issued', async () => {
    makeStubConnector('poll-recon-a', 0);
    const { engine, calls } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-recon-a', true) },
      knownRecordIds: ['rec-1', 'rec-2'], // rec-2 will be reported vanished
    });
    const result = await runConnectorPoll(engine, {
      sourceId: 's1',
      provider: 'poll-recon-a',
      seenRecordIds: ['rec-1'], // rec-2 vanished
    }, NO_ENV);
    expect(result.tombstoned).toBe(1);

    // A tombstone INSERT into connector_candidates was issued for rec-2.
    const insert = calls.find((c) => /INSERT INTO connector_candidates/.test(c.sql));
    expect(insert).toBeDefined();
    expect(insert!.params).toContain('rec-2');
    expect(insert!.params).toContain(`1:${TOMBSTONE_VERSION_SUFFIX}`);

    // Reconciliation NEVER deletes a record — it tombstones via INSERT. (The U3 TTL
    // self-cleaning sweep is the ONLY DELETE the poll runs; it is unrelated to
    // reconciliation and is excluded here by its `expires_at` predicate.)
    const reconcileDelete = calls.find((c) => /DELETE\s+FROM/i.test(c.sql) && !/expires_at/i.test(c.sql));
    expect(reconcileDelete).toBeUndefined();
  });

  test('idempotent re-run: tombstone ON CONFLICT surfaces tombstoned=0', async () => {
    makeStubConnector('poll-recon-b', 0);
    const { engine } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-recon-b', true) },
      knownRecordIds: ['rec-1', 'rec-2'],
      conflict: true, // simulate the tombstone already existing
    });
    const result = await runConnectorPoll(engine, {
      sourceId: 's1',
      provider: 'poll-recon-b',
      seenRecordIds: ['rec-1'],
    }, NO_ENV);
    expect(result.tombstoned).toBe(0); // ON CONFLICT DO NOTHING → no new write
  });

  test('without seenRecordIds, reconciliation is skipped (no tombstones, no known-id query)', async () => {
    makeStubConnector('poll-recon-c', 3);
    const { engine, calls } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-recon-c', true) },
      knownRecordIds: ['rec-1', 'rec-2'],
    });
    const result = await runConnectorPoll(engine, { sourceId: 's1', provider: 'poll-recon-c' }, NO_ENV);
    expect(result.landed).toBe(3);
    expect(result.tombstoned).toBe(0);
    // The known-record-ids reconciliation query is NOT issued.
    const reconQuery = calls.find((c) => /DISTINCT source_record_id/.test(c.sql));
    expect(reconQuery).toBeUndefined();
  });

  // ── Fix #3 (empty seen set must NOT mass-tombstone) ──────────────────────────
  test('REVIEW#3: seenRecordIds:[] with a non-empty known set tombstones NOTHING', async () => {
    makeStubConnector('poll-recon-empty', 0);
    const { engine, calls } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-recon-empty', true) },
      knownRecordIds: ['rec-1', 'rec-2', 'rec-3'], // would ALL be tombstoned if [] were honored
    });
    const result = await runConnectorPoll(engine, {
      sourceId: 's1',
      provider: 'poll-recon-empty',
      seenRecordIds: [], // transient zero-record poll — must be treated as "no signal"
    }, NO_ENV);
    expect(result.tombstoned).toBe(0);
    // Reconciliation is skipped entirely: no known-id query, no INSERT.
    expect(calls.find((c) => /DISTINCT source_record_id/.test(c.sql))).toBeUndefined();
    expect(calls.find((c) => /INSERT INTO connector_candidates/.test(c.sql))).toBeUndefined();
  });

  test('REVIEW#3: confirmedEmpty:true is the EXPLICIT signal that DOES tombstone all known', async () => {
    makeStubConnector('poll-recon-confirmed', 0);
    const { engine, calls } = makeFakeEngine({
      sourceRow: { id: 's1', config: withConnector('poll-recon-confirmed', true) },
      knownRecordIds: ['rec-1', 'rec-2'],
    });
    const result = await runConnectorPoll(engine, {
      sourceId: 's1',
      provider: 'poll-recon-confirmed',
      confirmedEmpty: true, // connector authoritatively saw zero current records
    }, NO_ENV);
    expect(result.tombstoned).toBe(2);
    // Still tombstones via INSERT; reconciliation issues no DELETE (the U3 TTL sweep,
    // identified by its `expires_at` predicate, is the only — unrelated — DELETE).
    expect(calls.find((c) => /INSERT INTO connector_candidates/.test(c.sql))).toBeDefined();
    expect(calls.find((c) => /DELETE\s+FROM/i.test(c.sql) && !/expires_at/i.test(c.sql))).toBeUndefined();
  });
});

// ── config parsing helpers ───────────────────────────────────────────────────

describe('config parsing helpers', () => {
  test('parseSourceConfigObject tolerates object / string / null / bad-json', () => {
    expect(parseSourceConfigObject({ a: 1 })).toEqual({ a: 1 });
    expect(parseSourceConfigObject('{"a":2}')).toEqual({ a: 2 });
    expect(parseSourceConfigObject(null)).toEqual({});
    expect(parseSourceConfigObject('{not json')).toEqual({});
    expect(parseSourceConfigObject('[1,2]')).toEqual({}); // arrays are not config objects
  });

  test('readConnectorsConfig returns the connectors map or empty object', () => {
    expect(readConnectorsConfig({ connectors: { linear: { enabled: true } } })).toEqual({
      linear: { enabled: true },
    });
    expect(readConnectorsConfig({})).toEqual({});
    expect(readConnectorsConfig({ connectors: 'not-an-object' })).toEqual({});
    expect(readConnectorsConfig(null)).toEqual({});
  });
});

// ── Fix #2: dispatch fan-out must NOT coalesce targets ───────────────────────
//
// The autopilot connector branch submits one connector_poll per (source, provider)
// target with a distinct idempotency_key and NO maxWaiting. maxWaiting is keyed on
// (name, queue) — shared across every target — so maxWaiting:1 would coalesce all N
// targets into one waiting job and starve the rest on an idle worker. This test
// replicates the dispatch submission shape against a stub queue (the inline loop in
// autopilot.ts isn't a separately-exported function) and asserts every target
// survives with a unique key and no coalescing knob. Mirrors the autopilot-fanout
// "MUST NOT pass maxWaiting" regression guard.

describe('connector dispatch fan-out — REVIEW#2 no maxWaiting coalescing', () => {
  type Added = { name: string; data: Record<string, unknown>; opts: Record<string, unknown> };

  /** Replicate the autopilot branch's per-target submission for the selected targets. */
  async function simulateDispatch(sources: ConnectorSourceRow[], slot: string) {
    const added: Added[] = [];
    let nextId = 1;
    const queue = {
      add: async (name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
        added.push({ name, data, opts });
        return { id: nextId++ };
      },
    };
    const targets = selectEnabledConnectorSources(sources, NO_ENV);
    for (const target of targets) {
      await queue.add(
        'connector_poll',
        { sourceId: target.sourceId, provider: target.provider },
        {
          queue: 'default',
          idempotency_key: `connector-poll:${target.sourceId}:${target.provider}:${slot}`,
          max_attempts: 2,
          timeout_ms: 600_000,
          // NB: intentionally no maxWaiting (the fix).
        },
      );
    }
    return { added, targets };
  }

  test('N distinct targets → N jobs, each with a UNIQUE idempotency key', async () => {
    const sources = [
      connectorSource('s1', { connectors: { linear: { enabled: true }, slack: { enabled: true } } }),
      connectorSource('s2', withConnector('notion', true)),
    ];
    const { added, targets } = await simulateDispatch(sources, 'SLOT-1');
    // All three targets survive — none coalesced away.
    expect(added.length).toBe(3);
    expect(targets.length).toBe(3);
    const keys = added.map((j) => j.opts.idempotency_key as string);
    expect(new Set(keys).size).toBe(3); // all distinct
    expect(keys.sort()).toEqual([
      'connector-poll:s1:linear:SLOT-1',
      'connector-poll:s1:slack:SLOT-1',
      'connector-poll:s2:notion:SLOT-1',
    ]);
  });

  test('NO submission carries maxWaiting (the coalescing trap)', async () => {
    const sources = [
      connectorSource('s1', withConnector('linear', true)),
      connectorSource('s2', withConnector('slack', true)),
      connectorSource('s3', withConnector('notion', true)),
    ];
    const { added } = await simulateDispatch(sources, 'SLOT-2');
    expect(added.length).toBe(3);
    for (const job of added) {
      expect(job.opts.maxWaiting).toBeUndefined();
    }
  });
});

// ── Fix #4: circuit breaker on consecutive dead-letters ──────────────────────

describe('connectorPollBreakerTripped — REVIEW#4 circuit breaker', () => {
  /** A minimal engine returning a canned minion_jobs status history. */
  function breakerEngine(history: string[], opts: { throws?: boolean } = {}) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const engine = {
      kind: 'postgres' as const,
      executeRaw: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        if (opts.throws) throw new Error('minion_jobs query failed');
        return history.map((status) => ({ status }));
      },
    } as unknown as BrainEngine;
    return { engine, calls };
  }

  test('threshold consecutive dead-letters trips the breaker', async () => {
    const history = Array(CONNECTOR_POLL_BREAKER_THRESHOLD).fill('dead');
    const { engine } = breakerEngine(history);
    const r = await connectorPollBreakerTripped(engine, 's1', 'linear');
    expect(r.tripped).toBe(true);
    expect(r.consecutiveDead).toBe(CONNECTOR_POLL_BREAKER_THRESHOLD);
  });

  test('a recent success at the head resets the streak — NOT tripped', async () => {
    // Most-recent-first: a completed job followed by many dead ones.
    const history = ['completed', 'dead', 'dead', 'dead', 'dead', 'dead', 'dead'];
    const { engine } = breakerEngine(history);
    const r = await connectorPollBreakerTripped(engine, 's1', 'linear');
    expect(r.tripped).toBe(false);
    expect(r.consecutiveDead).toBe(0);
  });

  test('below-threshold dead streak does not trip', async () => {
    const history = Array(CONNECTOR_POLL_BREAKER_THRESHOLD - 1).fill('dead');
    const { engine } = breakerEngine(history);
    const r = await connectorPollBreakerTripped(engine, 's1', 'linear');
    expect(r.tripped).toBe(false);
  });

  test('the leading dead streak is counted up to the first non-dead terminal', async () => {
    const history = ['dead', 'dead', 'completed', 'dead', 'dead']; // streak = 2
    const { engine } = breakerEngine(history);
    const r = await connectorPollBreakerTripped(engine, 's1', 'linear', 2);
    expect(r.consecutiveDead).toBe(2);
    expect(r.tripped).toBe(true); // threshold lowered to 2 for this case
  });

  test('empty history (never polled) does not trip', async () => {
    const { engine } = breakerEngine([]);
    const r = await connectorPollBreakerTripped(engine, 's1', 'linear');
    expect(r.tripped).toBe(false);
    expect(r.consecutiveDead).toBe(0);
  });

  test('breaker query filters by (sourceId, provider) via the data JSONB', async () => {
    const { engine, calls } = breakerEngine(['dead']);
    await connectorPollBreakerTripped(engine, 'src-x', 'prov-y');
    const q = calls[0];
    expect(q.sql).toMatch(/data->>'sourceId'/);
    expect(q.sql).toMatch(/data->>'provider'/);
    expect(q.params).toContain('src-x');
    expect(q.params).toContain('prov-y');
  });
});
