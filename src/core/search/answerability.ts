/**
 * Answerability judge (v0.43) — "does this passage actually ANSWER the question?"
 *
 * The cross-encoder reranker scores TOPICAL RELEVANCE ("is this passage about the
 * query's topic"), not answerability. So a topically-adjacent page can rerank
 * ABOVE the abstention floor and get served confidently while not answering —
 * e.g. "What are the Forge approval gate rules?" → a Context Mirror page @ 0.69.
 * No score threshold separates 0.69-wrong from 0.63-right. This judge is a
 * genuinely different objective: an instructed LLM asked yes/no whether the
 * passage answers the question.
 *
 * FAIL-OPEN by construction: any error / timeout / gateway-unavailable returns
 * `unknown` (the caller serves normally). The judge can therefore only ever
 * cause a clean miss (in enforce mode), never a new wrong answer. Every outcome
 * is reported (answered | not_answered | error | timeout | unavailable) so a
 * silently-disabled judge (e.g. no chat key in the runtime) is VISIBLE in
 * telemetry rather than masquerading as protection.
 *
 * Mirrors the gated/fail-open shape of classifyModalityWithLLM, but with an
 * EXPLICIT small model (the shared chat default is Sonnet — 3-5x the cost/latency
 * of the Haiku this call is budgeted for) and a verdict cache.
 */

import { createHash } from 'node:crypto';

/** Small utility-tier model for the judge. Explicit — do NOT fall through to the
 *  Sonnet chat default. */
const JUDGE_MODEL = 'anthropic:claude-haiku-4-5-20251001';
/** Timeout sized for a full chunk in the prompt (not the 1s query-classify budget). */
const JUDGE_TIMEOUT_MS = 3000;
/** Cap the chunk text sent to the judge (cost + latency bound). */
const MAX_CHUNK_CHARS = 1200;

export type AnswerabilityOutcome = 'answered' | 'not_answered' | 'error' | 'timeout' | 'unavailable';

export interface AnswerabilityVerdict {
  outcome: AnswerabilityOutcome;
  /** True only when outcome === 'not_answered' (the enforce-abstain trigger). */
  reject: boolean;
  /** True when a live judge produced a verdict (answered|not_answered) — the
   *  denominator for the reject rate; excludes error/timeout/unavailable. */
  judged: boolean;
  cached: boolean;
  /** v0.43.1 — diagnostic detail for outcome 'error': the thrown message (capped)
   *  or `unparseable:<raw>` when the model replied but not with a clean yes/no.
   *  Surfaced so a shadow run reveals WHY the judge failed instead of a silent
   *  'error'. Truncated + never contains query/passage text (privacy). */
  error_detail?: string;
}

const SYSTEM_PROMPT =
  'You are a strict relevance judge for a knowledge-base retrieval system. ' +
  'Given a QUESTION and a PASSAGE, answer whether the passage actually ANSWERS ' +
  'the question — not merely whether it is about the same topic. A passage that ' +
  'is topically adjacent but does not contain the answer is NOT an answer. ' +
  'Reply with exactly one word: YES or NO.';

function parseVerdict(raw: string): 'answered' | 'not_answered' | 'error' {
  // Match on the FIRST whitespace-delimited token. Haiku obeys "reply YES or NO"
  // but often adds an explanation: "NO\n\nThe passage discusses…" — the verdict
  // is the first token, and requiring the WHOLE reply to equal yes/no wrongly
  // rejected those (the live shadow-diagnosed bug: outcome 'error' on a correct
  // NO). First-token match also preserves the F5 guard against a soft refusal:
  // "Not enough information" → first token "not" ≠ "no" → error (fail-open), never
  // a manufactured abstain. Strip trailing punctuation only (YES. / NO,).
  const first = raw.trim().split(/\s+/, 1)[0]?.toLowerCase().replace(/[^a-z]+/g, '') ?? '';
  if (first === 'yes') return 'answered';
  if (first === 'no') return 'not_answered';
  return 'error'; // no clean leading verdict → fail-open
}

/** Content-hash cache key: (query, chunk text). Chunk-content-keyed (NOT slug)
 *  so a reindex that changes the chunk naturally misses; exact-match only (never
 *  similarity — the entity-collision lesson). */
export function verdictCacheKey(query: string, chunkText: string): string {
  return createHash('sha256').update(JSON.stringify([query, chunkText])).digest('hex').slice(0, 32);
}

interface VerdictCacheEntry { outcome: 'answered' | 'not_answered'; at: number; }
const VERDICT_TTL_MS = 3_600_000; // 1h — a flaky NO must not become a durable abstention.
const verdictCache = new Map<string, VerdictCacheEntry>();

export function _resetAnswerabilityCacheForTest(): void {
  verdictCache.clear();
}

/**
 * Judge whether `chunkText` answers `query`. Test seam: `judgeFn` overrides the
 * gateway call (production must never set it). `now` is injectable for TTL tests.
 */
export async function judgeAnswerability(
  query: string,
  chunkText: string,
  opts: { judgeFn?: (q: string, c: string) => Promise<string>; now?: number } = {},
): Promise<AnswerabilityVerdict> {
  const now = opts.now ?? Date.now();
  const key = verdictCacheKey(query, chunkText);
  const hit = verdictCache.get(key);
  if (hit && now - hit.at < VERDICT_TTL_MS) {
    return { outcome: hit.outcome, reject: hit.outcome === 'not_answered', judged: true, cached: true };
  }

  const doc = (chunkText || '').slice(0, MAX_CHUNK_CHARS);

  if (opts.judgeFn) {
    // Test path — still exercises parse + cache + error_detail, never the gateway.
    let raw: string;
    try {
      raw = await opts.judgeFn(query, doc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: 'error', reject: false, judged: false, cached: false, error_detail: msg.slice(0, 120) };
    }
    const outcome = parseVerdict(raw);
    if (outcome === 'error') {
      return { outcome: 'error', reject: false, judged: false, cached: false,
               error_detail: `unparseable:${(raw ?? '').trim().slice(0, 40)}` };
    }
    verdictCache.set(key, { outcome, at: now });
    return { outcome, reject: outcome === 'not_answered', judged: true, cached: false };
  }

  let chat: typeof import('../ai/gateway.ts').chat;
  let isAvailable: typeof import('../ai/gateway.ts').isAvailable;
  try {
    ({ chat, isAvailable } = await import('../ai/gateway.ts'));
  } catch {
    return { outcome: 'unavailable', reject: false, judged: false, cached: false };
  }
  if (!isAvailable('chat')) {
    return { outcome: 'unavailable', reject: false, judged: false, cached: false };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, JUDGE_TIMEOUT_MS);
  try {
    const result = await chat({
      model: JUDGE_MODEL,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: `QUESTION: ${query.slice(0, 500)}\n\nPASSAGE: ${doc}` }],
      // v0.43.1 — 16 (was 4; matches the working classifyModalityWithLLM budget).
      // A leading whitespace/format token could eat a 4-token budget before the
      // verdict word, producing an unparseable (empty) reply → false 'error'.
      maxTokens: 16,
      abortSignal: controller.signal,
    });
    const outcome = parseVerdict(result.text);
    if (outcome === 'error') {
      // Model replied but not a clean yes/no — capture what it said (short, no
      // query/passage text) so shadow shows the real shape.
      return { outcome: 'error', reject: false, judged: false, cached: false,
               error_detail: `unparseable:${(result.text ?? '').trim().slice(0, 40)}` };
    }
    verdictCache.set(key, { outcome, at: now });
    return { outcome, reject: outcome === 'not_answered', judged: true, cached: false };
  } catch (err) {
    if (timedOut) return { outcome: 'timeout', reject: false, judged: false, cached: false };
    const msg = err instanceof Error ? err.message : String(err);
    return { outcome: 'error', reject: false, judged: false, cached: false, error_detail: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}
