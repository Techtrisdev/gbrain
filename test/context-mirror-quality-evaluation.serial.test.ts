import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  runContextMirrorEvaluation,
  type ContextMirrorEvaluationOptions,
} from '../src/core/connectors/context-mirror-evaluation.ts';
import type { DistillConversationOutcome } from '../src/core/connectors/distill.ts';

const usage = { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 };

function options(
  distill: (text: string) => Promise<DistillConversationOutcome>,
  overrides: Partial<ContextMirrorEvaluationOptions> = {},
): ContextMirrorEvaluationOptions {
  return {
    maxItems: 5,
    maxCalls: 5,
    maxInputTokens: 10_000,
    maxOutputTokens: 10_000,
    maxRuntimeMs: 60_000,
    maxCostUsd: 1,
    requestTimeoutMs: 5_000,
    distill,
    ...overrides,
  };
}

describe('Context Mirror evaluation-only isolation', () => {
  test('reuses production-shaped outcomes without any operational mutation surface', async () => {
    const result = await runContextMirrorEvaluation(
      [
        { opaqueId: 'eval-001', conversation: 'one' },
        { opaqueId: 'eval-002', conversation: 'two' },
      ],
      options(async (text) => ({
        status: 'distilled',
        memories: text === 'one' ? ['fact'] : [],
        usage,
      })),
    );
    expect(result.mode).toBe('evaluation_only');
    expect(result.operational_mutations).toBe(0);
    expect(result.dispositions.map((row) => row.status)).toEqual(['memory', 'noop']);
    expect(result.usage).toEqual({ input_tokens: 20, output_tokens: 10 });
  });

  test('session rejection is isolated while a sibling still evaluates', async () => {
    let calls = 0;
    const result = await runContextMirrorEvaluation(
      [
        { opaqueId: 'eval-001', conversation: 'bad' },
        { opaqueId: 'eval-002', conversation: 'good' },
      ],
      options(async () => {
        calls += 1;
        return calls === 1
          ? { status: 'session_rejected', errorClass: 'validation', error: 'invalid' }
          : { status: 'distilled', memories: ['fact'], usage };
      }),
    );
    expect(result.dispositions.map((row) => row.status)).toEqual(['rejected', 'memory']);
  });

  test('systemic failure stops later calls and leaves them deferred', async () => {
    let calls = 0;
    const result = await runContextMirrorEvaluation(
      [
        { opaqueId: 'eval-001', conversation: 'one' },
        { opaqueId: 'eval-002', conversation: 'two' },
      ],
      options(async () => {
        calls += 1;
        return { status: 'systemic_failure', errorClass: 'config', error: 'billing' };
      }),
    );
    expect(calls).toBe(1);
    expect(result.status).toBe('failed');
    expect(result.dispositions.map((row) => row.status)).toEqual(['systemic_failure', 'deferred']);
  });

  test('finite call and output reservations stop before crossing a limit', async () => {
    const result = await runContextMirrorEvaluation(
      [
        { opaqueId: 'eval-001', conversation: 'one' },
        { opaqueId: 'eval-002', conversation: 'two' },
      ],
      options(async () => ({ status: 'distilled', memories: ['fact'], usage }), {
        maxCalls: 1,
        maxOutputTokens: 1_500,
      }),
    );
    expect(result.calls).toBe(1);
    expect(result.stop_reason).toBe('call_limit');
    expect(result.dispositions[1]?.status).toBe('deferred');
  });

  test('module cannot import or invoke operational engine/candidate surfaces', () => {
    const source = readFileSync(new URL('../src/core/connectors/context-mirror-evaluation.ts', import.meta.url), 'utf8');
    for (const forbidden of ['BrainEngine', 'putPage(', 'upsertChunks(', 'connector_candidates', 'landRecords(', 'promote']) {
      expect(source).not.toContain(forbidden);
    }
  });
});
