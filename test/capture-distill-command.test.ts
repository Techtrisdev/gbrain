import { describe, expect, test } from 'bun:test';
import { parseDistillArgs } from '../src/commands/capture-distill.ts';
import {
  DEFAULT_MAX_CALLS,
  DEFAULT_MAX_COST_USD,
  DEFAULT_MAX_SESSIONS,
} from '../src/core/connectors/distill.ts';

describe('capture distill command safety flags', () => {
  test('defaults are finite and cost bounded', () => {
    const parsed = parseDistillArgs([]);
    expect(parsed).toMatchObject({
      maxSessions: DEFAULT_MAX_SESSIONS,
      maxCalls: DEFAULT_MAX_CALLS,
      maxCostUsd: DEFAULT_MAX_COST_USD,
      maxRetries: 0,
    });
  });

  test('parses explicit finite limits', () => {
    const parsed = parseDistillArgs([
      '--max-sessions', '2',
      '--max-calls', '1',
      '--max-cost-usd', '0.05',
      '--request-timeout-ms', '30000',
      '--max-retries', '0',
      '--model', 'claude-test',
    ]);
    expect(parsed).toMatchObject({
      maxSessions: 2,
      maxCalls: 1,
      maxCostUsd: 0.05,
      requestTimeoutMs: 30_000,
      maxRetries: 0,
      model: 'claude-test',
    });
  });

  test('rejects unknown, missing, non-finite, and unbounded values', () => {
    expect(() => parseDistillArgs(['--typo'])).toThrow(/unknown/);
    expect(() => parseDistillArgs(['--max-sessions'])).toThrow(/requires a value/);
    expect(() => parseDistillArgs(['--max-sessions', 'Infinity'])).toThrow(/finite integer/);
    expect(() => parseDistillArgs(['--max-cost-usd', '0'])).toThrow(/finite number/);
    expect(() => parseDistillArgs(['--max-retries', '-1'])).toThrow(/finite integer/);
  });
});
