/**
 * connector-context-mirror.serial.test.ts — the distill_before_poll live-scheduling path.
 *
 * SERIAL because it uses `mock.module` (a GLOBAL mock that leaks across files): the
 * connector's backfill, when distill_before_poll is set, dynamically imports ./distill.ts,
 * and we mock that module to spy on distillCaptureSessions. Per check-test-isolation policy,
 * a test using mock.module must be a *.serial.test.ts (run at --max-concurrency=1, isolated)
 * rather than living in the sharded/parallel suite.
 */
import { describe, test, expect, mock } from 'bun:test';
import { contextMirrorConnector } from '../src/core/connectors/context-mirror.ts';
import type { ConnectorSource } from '../src/core/connectors/base.ts';
import type { BrainEngine } from '../src/core/engine.ts';

function source(config: Record<string, unknown> = {}): ConnectorSource {
  return { id: 'capture-events', config };
}

/** Minimal engine: listPages returns nothing, so backfill returns 0 AFTER the distill step
 *  runs (empty page set → no consolidation, no watermark write). The distill step itself
 *  goes through the mocked distillCaptureSessions, so it never touches the engine. */
function emptyEngine(): BrainEngine {
  return {
    kind: 'postgres',
    listPages: async () => [],
    executeRaw: async () => [],
  } as unknown as BrainEngine;
}

describe('Context Mirror live scheduling — distill_before_poll (serial: mock.module)', () => {
  test('distill_before_poll=true distills (sourceId + idleHours) before consolidating; absent skips it', async () => {
    const distillSpy = mock(async (_engine: unknown, _opts: { sourceId?: string; idleHours?: number }) => ({
      source_id: 'capture-events', idle_hours_threshold: 6, dry_run: false,
    }));
    mock.module('../src/core/connectors/distill.ts', () => ({ distillCaptureSessions: distillSpy }));

    await contextMirrorConnector.backfill!(emptyEngine(), source({ connectors: { context_mirror: {} } }));
    expect(distillSpy).toHaveBeenCalledTimes(0);

    await contextMirrorConnector.backfill!(
      emptyEngine(),
      source({ connectors: { context_mirror: { distill_before_poll: true, distill_idle_hours: 3 } } }),
    );
    expect(distillSpy).toHaveBeenCalledTimes(1);
    expect(distillSpy.mock.calls[0]?.[1]).toMatchObject({ sourceId: 'capture-events', idleHours: 3 });
  });

  test('a distill failure is non-fatal — consolidation still proceeds', async () => {
    const distillSpy = mock(async () => {
      throw new Error('gateway down');
    });
    mock.module('../src/core/connectors/distill.ts', () => ({ distillCaptureSessions: distillSpy }));
    const landed = await contextMirrorConnector.backfill!(
      emptyEngine(),
      source({ connectors: { context_mirror: { distill_before_poll: true } } }),
    );
    expect(landed).toBe(0);
  });
});
