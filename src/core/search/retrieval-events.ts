import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

export interface RetrievalEventInput {
  client?: string | null;
  sourceId?: string | null;
  agentName?: string | null;
  mode?: string | null;
  intent?: string | null;
  queryText: string;
  resultCount: number;
  topResultSlug?: string | null;
}

export interface RetrievalResponseMeta {
  query_id: string;
  /**
   * v0.42 — true iff the keyword `search` op returned zero lexical results and
   * the keyword_semantic_fallback path returned semantic neighbors instead.
   * Surfaced to the caller as `_meta.retrieval.fallback_fired` (dispatch.ts
   * spreads this whole object) so an existence-check caller knows the results
   * are a semantic guess, not exact keyword matches. Absent on the
   * `query`/hybrid path and on non-fallback keyword hits.
   */
  fallback_fired?: boolean;
}

const responseMeta = new WeakMap<object, RetrievalResponseMeta>();

function safeText(value: string | null | undefined, fallback = 'unknown'): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : fallback;
}

export function hashQueryText(queryText: string): string {
  return createHash('sha256').update(queryText, 'utf8').digest('hex');
}

export function recordRetrievalEvent(engine: BrainEngine, input: RetrievalEventInput): string {
  const queryId = randomUUID();
  const resultCount = Number.isFinite(input.resultCount)
    ? Math.max(0, Math.trunc(input.resultCount))
    : 0;

  void engine.executeRaw(
    `INSERT INTO retrieval_events
       (query_id, client, source_id, agent_name, mode, intent, query_hash, result_count, top_result_slug)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      queryId,
      safeText(input.client),
      safeText(input.sourceId),
      input.agentName ? safeText(input.agentName, '') : null,
      input.mode ? safeText(input.mode, 'unset') : 'unset',
      input.intent ? safeText(input.intent, 'unset') : 'unset',
      hashQueryText(input.queryText),
      resultCount,
      input.topResultSlug ?? null,
    ],
  ).catch(() => {});

  return queryId;
}

export function attachRetrievalResponseMeta(result: unknown, meta: RetrievalResponseMeta): void {
  if (result && (typeof result === 'object' || typeof result === 'function')) {
    responseMeta.set(result, meta);
  }
}

export function getRetrievalResponseMeta(result: unknown): RetrievalResponseMeta | undefined {
  if (!result || (typeof result !== 'object' && typeof result !== 'function')) return undefined;
  return responseMeta.get(result);
}