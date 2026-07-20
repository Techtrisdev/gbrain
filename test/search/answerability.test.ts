/**
 * Answerability judge (v0.43) — unit tests for the judge module.
 * Gate/integration behavior (shadow serves-normally, enforce abstains) is in
 * answerability-gate.serial.test.ts (needs the gateway/embed stub).
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import {
  judgeAnswerability,
  verdictCacheKey,
  _resetAnswerabilityCacheForTest,
} from '../../src/core/search/answerability.ts';

beforeEach(() => _resetAnswerabilityCacheForTest());

const yes = async () => 'YES';
const no = async () => 'NO';

describe('judgeAnswerability (stubbed judge)', () => {
  test('YES → answered, not rejected, judged', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: yes });
    expect(v.outcome).toBe('answered');
    expect(v.reject).toBe(false);
    expect(v.judged).toBe(true);
  });

  test('NO → not_answered, rejected, judged', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: no });
    expect(v.outcome).toBe('not_answered');
    expect(v.reject).toBe(true);
    expect(v.judged).toBe(true);
  });

  test('unparseable verdict → error, fail-open (not rejected, not judged)', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: async () => 'maybe?' });
    expect(v.outcome).toBe('error');
    expect(v.reject).toBe(false);
    expect(v.judged).toBe(false);
  });

  test('verbose NO ("NO\\n\\nThe passage discusses…") parses as not_answered (the live-diagnosed case)', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: async () => 'NO\n\nThe passage discusses update actions, not approval gates.' });
    expect(v.outcome).toBe('not_answered');
    expect(v.reject).toBe(true);
    expect(v.judged).toBe(true);
  });

  test('verbose YES parses as answered', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: async () => 'YES. The passage states the rules directly.' });
    expect(v.outcome).toBe('answered');
  });

  test('soft refusal "Not enough information" → error (first token "not" != "no"), NOT a manufactured abstain', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: async () => 'Not enough information to say.' });
    expect(v.outcome).toBe('error');
    expect(v.reject).toBe(false);
  });

  test('judge throwing → error, fail-open, error_detail carries the message', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: async () => { throw new Error('gateway 429'); } });
    expect(v.outcome).toBe('error');
    expect(v.reject).toBe(false);
    expect(v.judged).toBe(false);
    expect(v.error_detail).toContain('gateway 429'); // v0.43.1: cause is visible, not swallowed
  });

  test('unparseable verdict → error_detail shows what the model actually said', async () => {
    const v = await judgeAnswerability('q', 'passage', { judgeFn: async () => 'I think probably yes' });
    expect(v.outcome).toBe('error');
    expect(v.error_detail).toContain('unparseable');
  });

  test('verdict is cached (exact query+chunk) and replayed', async () => {
    let calls = 0;
    const counting = async () => { calls++; return 'NO'; };
    await judgeAnswerability('q', 'passage', { judgeFn: counting });
    const v2 = await judgeAnswerability('q', 'passage', { judgeFn: counting });
    expect(calls).toBe(1);          // second call served from cache
    expect(v2.cached).toBe(true);
    expect(v2.reject).toBe(true);
  });

  test('cache is content-keyed: different chunk text is a different key (no collision)', async () => {
    expect(verdictCacheKey('q', 'chunk A')).not.toBe(verdictCacheKey('q', 'chunk B'));
    expect(verdictCacheKey('q1', 'chunk')).not.toBe(verdictCacheKey('q2', 'chunk'));
    // A NO on chunk A must not serve chunk B.
    await judgeAnswerability('q', 'chunk A', { judgeFn: no });
    const other = await judgeAnswerability('q', 'chunk B', { judgeFn: yes });
    expect(other.cached).toBe(false);
    expect(other.outcome).toBe('answered');
  });

  test('errors are NOT cached (a flaky failure must not become durable)', async () => {
    let calls = 0;
    await judgeAnswerability('q', 'p', { judgeFn: async () => { calls++; throw new Error('x'); } });
    await judgeAnswerability('q', 'p', { judgeFn: async () => { calls++; return 'YES'; } });
    expect(calls).toBe(2);          // the error did not populate the cache
  });

  test('TTL expiry: a cached verdict past TTL is re-judged', async () => {
    await judgeAnswerability('q', 'p', { judgeFn: no, now: 1_000 });
    const fresh = await judgeAnswerability('q', 'p', { judgeFn: yes, now: 1_000 + 3_600_001 });
    expect(fresh.cached).toBe(false);
    expect(fresh.outcome).toBe('answered');
  });
});
