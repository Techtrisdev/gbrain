import { randomUUID } from 'node:crypto';

import type { BrainEngine } from '../engine.ts';

const BOOTSTRAP_CHECKPOINT = 'capture_session_scan_v1';
const DEFAULT_BOOTSTRAP_BATCH = 5_000;
const CLAIM_LEASE_MS = 15 * 60_000;

export interface DurableSessionHead {
  sessionId: string;
  sessionSlug: string;
  captureSlugPrefix: string;
  turns: number;
  newestMs: number;
  firstEligibleMs: number;
  claimId: string;
  generation: number;
}

export interface BootstrapResult {
  scanned: number;
  complete: boolean;
  totalHeads: number;
  pendingEligible: number;
}

export interface CircuitState {
  state: 'closed' | 'open' | 'half_open';
  reason: string | null;
  nextProbeAt: Date | null;
}

export interface PersistedProviderResult {
  correlationId: string;
  memories: string[];
  usage: Record<string, number>;
}

interface CaptureMetadataRow {
  id: number | string;
  slug: string;
  frontmatter: Record<string, unknown> | string | null;
  captured_at: Date | string;
  updated_at: Date | string;
}

interface ScanCursor {
  updatedAt: string;
  id: number;
}

/** Real Postgres/PGLite engines expose their driver escape hatch; lightweight
 * unit fakes intentionally do not and use the legacy in-memory path. */
export function supportsContextMirrorOperationalState(engine: BrainEngine): boolean {
  const row = engine as BrainEngine & { sql?: unknown; db?: unknown };
  return (engine.kind === 'postgres' && row.sql != null) || (engine.kind === 'pglite' && row.db != null);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cursorFrom(value: unknown): ScanCursor {
  const row = parseJsonObject(value);
  const updatedAt = typeof row.updated_at === 'string' ? row.updated_at : '1970-01-01T00:00:00.000Z';
  const id = Number(row.id ?? 0);
  return { updatedAt, id: Number.isFinite(id) ? id : 0 };
}

function sessionIdFor(row: CaptureMetadataRow): { sessionId: string; prefix: string } | null {
  const parts = row.slug.split('/');
  if (parts[0] !== 'capture' || !parts[1]) return null;
  const fm = parseJsonObject(row.frontmatter);
  const sessionId = typeof fm.session_id === 'string' && fm.session_id.trim()
    ? fm.session_id.trim()
    : parts[1];
  return sessionId ? { sessionId, prefix: `capture/${parts[1]}/` } : null;
}

/**
 * Advance the raw-capture metadata scan by one finite keyset page. Only slug,
 * frontmatter, and timestamps are read; transcript bodies are never hydrated.
 * The checkpoint and accumulated session heads make restart progress durable.
 */
export async function advanceSessionHeadBootstrap(
  engine: BrainEngine,
  opts: {
    sourceId: string;
    now: Date;
    idleHours: number;
    sessionSlug: (sessionId: string) => string;
    batchSize?: number;
  },
): Promise<BootstrapResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BOOTSTRAP_BATCH;
  if (!Number.isFinite(batchSize) || !Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('context mirror bootstrap batchSize must be a positive finite integer');
  }
  const checkpointRows = await engine.executeRaw<{ cursor: unknown; completed: boolean }>(
    `SELECT cursor, completed FROM context_mirror_checkpoints
      WHERE source_id = $1 AND checkpoint_kind = $2`,
    [opts.sourceId, BOOTSTRAP_CHECKPOINT],
  );
  const cursor = cursorFrom(checkpointRows[0]?.cursor);
  const rows = await engine.executeRaw<CaptureMetadataRow>(
    `SELECT id, slug, frontmatter,
            CASE
              WHEN COALESCE(frontmatter->>'captured_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                THEN (frontmatter->>'captured_at')::timestamptz
              ELSE updated_at
            END AS captured_at,
            updated_at
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND slug LIKE 'capture/%'
        AND (updated_at > $2::timestamptz OR (updated_at = $2::timestamptz AND id > $3))
      ORDER BY updated_at ASC, id ASC
      LIMIT $4`,
    [opts.sourceId, cursor.updatedAt, cursor.id, batchSize],
  );

  const grouped = new Map<string, {
    sessionId: string;
    sessionSlug: string;
    prefix: string;
    turns: number;
    newest: Date;
  }>();
  for (const row of rows) {
    const identity = sessionIdFor(row);
    if (!identity) continue;
    const captured = new Date(row.captured_at);
    if (!Number.isFinite(captured.getTime())) continue;
    const current = grouped.get(identity.sessionId);
    if (current) {
      current.turns += 1;
      if (captured > current.newest) current.newest = captured;
    } else {
      grouped.set(identity.sessionId, {
        sessionId: identity.sessionId,
        sessionSlug: opts.sessionSlug(identity.sessionId),
        prefix: identity.prefix,
        turns: 1,
        newest: captured,
      });
    }
  }

  await engine.transaction(async (tx) => {
    for (const head of grouped.values()) {
      await tx.executeRaw(
        `INSERT INTO context_mirror_session_heads (
           source_id, session_id, session_slug, capture_slug_prefix,
           newest_capture_at, turn_count
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (source_id, session_id) DO UPDATE SET
           capture_slug_prefix = EXCLUDED.capture_slug_prefix,
           newest_capture_at = GREATEST(context_mirror_session_heads.newest_capture_at, EXCLUDED.newest_capture_at),
           turn_count = context_mirror_session_heads.turn_count + EXCLUDED.turn_count,
           state = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN 'pending'
             ELSE context_mirror_session_heads.state
           END,
           disposition = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN NULL
             ELSE context_mirror_session_heads.disposition
           END,
           first_eligible_at = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN NULL
             ELSE context_mirror_session_heads.first_eligible_at
           END,
           cohort_at = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN NULL
             ELSE context_mirror_session_heads.cohort_at
           END,
           current_generation = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN context_mirror_session_heads.current_generation + 1
             ELSE context_mirror_session_heads.current_generation
           END,
           updated_at = now()`,
        [opts.sourceId, head.sessionId, head.sessionSlug, head.prefix, head.newest.toISOString(), head.turns],
      );
    }
    const last = rows.at(-1);
    const complete = rows.length < batchSize;
    const next = last
      ? { updated_at: new Date(last.updated_at).toISOString(), id: Number(last.id) }
      : { updated_at: cursor.updatedAt, id: cursor.id };
    await tx.executeRaw(
      `INSERT INTO context_mirror_checkpoints (source_id, checkpoint_kind, cursor, completed, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (source_id, checkpoint_kind) DO UPDATE SET
         cursor = EXCLUDED.cursor,
         completed = EXCLUDED.completed,
         updated_at = now()`,
      [opts.sourceId, BOOTSTRAP_CHECKPOINT, JSON.stringify(next), complete],
    );
    if (complete) {
      const threshold = new Date(opts.now.getTime() - opts.idleHours * 3_600_000).toISOString();
      await tx.executeRaw(
        `UPDATE context_mirror_session_heads
            SET first_eligible_at = COALESCE(first_eligible_at, $2::timestamptz),
                cohort_at = COALESCE(cohort_at, $2::timestamptz),
                updated_at = now()
          WHERE source_id = $1
            AND state = 'pending'
            AND newest_capture_at <= $3::timestamptz`,
        [opts.sourceId, opts.now.toISOString(), threshold],
      );
      await tx.executeRaw(
        `UPDATE context_mirror_session_heads h
            SET state = 'complete', disposition = COALESCE(disposition, 'legacy_marker'), updated_at = now()
          WHERE h.source_id = $1
            AND h.state IN ('pending','claimed','result_persisted')
            AND EXISTS (
              SELECT 1 FROM pages p
               WHERE p.source_id = h.source_id
                 AND p.slug = 'distill-state/' || h.session_slug
                 AND p.deleted_at IS NULL
                 AND COALESCE(
                   CASE WHEN COALESCE(p.frontmatter->>'generation', '') ~ '^\\d+$'
                     THEN (p.frontmatter->>'generation')::integer END,
                   1
                 ) = h.current_generation
            )`,
        [opts.sourceId],
      );
    }
  });

  const counts = await engine.executeRaw<{ total: number | string; pending: number | string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE state = 'pending' AND first_eligible_at IS NOT NULL) AS pending
       FROM context_mirror_session_heads WHERE source_id = $1`,
    [opts.sourceId],
  );
  return {
    scanned: rows.length,
    complete: rows.length < batchSize,
    totalHeads: Number(counts[0]?.total ?? 0),
    pendingEligible: Number(counts[0]?.pending ?? 0),
  };
}

/** Mark abandoned sends ambiguous before claiming more work; they cannot be replayed automatically. */
export async function quarantineAmbiguousInflightCalls(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ session_id: string; generation: number | string }>(
    `UPDATE context_mirror_provider_calls
        SET state = 'ambiguous_provider_outcome', updated_at = now()
      WHERE source_id = $1 AND state = 'inflight'
        AND sent_at < now() - INTERVAL '15 minutes'
      RETURNING session_id, generation`,
    [sourceId],
  );
  for (const row of rows) {
    await engine.executeRaw(
      `UPDATE context_mirror_session_heads
          SET state = 'ambiguous', disposition = 'ambiguous_provider_outcome',
              claim_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND current_generation = $3`,
      [sourceId, row.session_id, Number(row.generation)],
    );
  }
  return rows.length;
}

export async function claimPendingSessionHeads(
  engine: BrainEngine,
  sourceId: string,
  limit: number,
  now: Date,
): Promise<DurableSessionHead[]> {
  await engine.executeRaw(
    `UPDATE context_mirror_session_heads
        SET state = 'pending', claim_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE source_id = $1 AND state = 'claimed' AND lease_expires_at < $2::timestamptz`,
    [sourceId, now.toISOString()],
  );
  const candidates = await engine.executeRaw<{
    session_id: string;
    session_slug: string;
    capture_slug_prefix: string;
    turn_count: number | string;
    newest_capture_at: Date | string;
    first_eligible_at: Date | string;
    current_generation: number | string;
  }>(
    `SELECT session_id, session_slug, capture_slug_prefix, turn_count,
            newest_capture_at, first_eligible_at, current_generation
       FROM context_mirror_session_heads
      WHERE source_id = $1 AND state = 'pending' AND first_eligible_at IS NOT NULL
      ORDER BY first_eligible_at ASC, session_id ASC
      LIMIT $2`,
    [sourceId, limit],
  );
  const claimed: DurableSessionHead[] = [];
  for (const candidate of candidates) {
    const claimId = randomUUID();
    const rows = await engine.executeRaw<{ session_id: string }>(
      `UPDATE context_mirror_session_heads
          SET state = 'claimed', claim_id = $3, lease_expires_at = $4::timestamptz,
              attempt_count = attempt_count + 1, updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND state = 'pending'
        RETURNING session_id`,
      [sourceId, candidate.session_id, claimId, new Date(now.getTime() + CLAIM_LEASE_MS).toISOString()],
    );
    if (rows.length === 0) continue;
    claimed.push({
      sessionId: candidate.session_id,
      sessionSlug: candidate.session_slug,
      captureSlugPrefix: candidate.capture_slug_prefix,
      turns: Number(candidate.turn_count),
      newestMs: new Date(candidate.newest_capture_at).getTime(),
      firstEligibleMs: new Date(candidate.first_eligible_at).getTime(),
      claimId,
      generation: Number(candidate.current_generation),
    });
  }
  return claimed;
}

export async function startDistillRun(
  engine: BrainEngine,
  sourceId: string,
  limits: Record<string, number>,
): Promise<string> {
  const runId = randomUUID();
  await engine.executeRaw(
    `INSERT INTO context_mirror_distill_runs (run_id, source_id, status, limits)
     VALUES ($1, $2, 'running', $3::jsonb)`,
    [runId, sourceId, JSON.stringify(limits)],
  );
  return runId;
}

export async function finishDistillRun(
  engine: BrainEngine,
  runId: string,
  result: { status: 'ok' | 'partial' | 'failed'; stopReason: string; selected: number; completed: number; failed: number; deferred: number },
): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_distill_runs
        SET status = $2, stop_reason = $3, selected_count = $4,
            completed_count = $5, failed_count = $6, deferred_count = $7,
            finished_at = now(), updated_at = now()
      WHERE run_id = $1`,
    [runId, result.status, result.stopReason, result.selected, result.completed, result.failed, result.deferred],
  );
}

export async function readCircuit(engine: BrainEngine, sourceId: string, provider: string): Promise<CircuitState> {
  const rows = await engine.executeRaw<{ state: CircuitState['state']; reason: string | null; next_probe_at: Date | string | null }>(
    `SELECT state, reason, next_probe_at FROM context_mirror_circuits
      WHERE source_id = $1 AND provider = $2`,
    [sourceId, provider],
  );
  const row = rows[0];
  return row
    ? { state: row.state, reason: row.reason, nextProbeAt: row.next_probe_at ? new Date(row.next_probe_at) : null }
    : { state: 'closed', reason: null, nextProbeAt: null };
}

export async function openCircuit(
  engine: BrainEngine,
  sourceId: string,
  provider: string,
  reason: string,
  fingerprint: string,
  nextProbeAt: Date,
): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO context_mirror_circuits (
       source_id, provider, state, reason, error_fingerprint,
       consecutive_failures, opened_at, next_probe_at, updated_at
     ) VALUES ($1, $2, 'open', $3, $4, 1, now(), $5, now())
     ON CONFLICT (source_id, provider) DO UPDATE SET
       state = 'open', reason = EXCLUDED.reason,
       error_fingerprint = EXCLUDED.error_fingerprint,
       consecutive_failures = context_mirror_circuits.consecutive_failures + 1,
       opened_at = COALESCE(context_mirror_circuits.opened_at, now()),
       next_probe_at = EXCLUDED.next_probe_at, updated_at = now()`,
    [sourceId, provider, reason, fingerprint, nextProbeAt.toISOString()],
  );
}

export async function closeCircuit(engine: BrainEngine, sourceId: string, provider: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO context_mirror_circuits (source_id, provider, state, consecutive_failures, updated_at)
     VALUES ($1, $2, 'closed', 0, now())
     ON CONFLICT (source_id, provider) DO UPDATE SET
       state = 'closed', reason = NULL, error_fingerprint = NULL,
       consecutive_failures = 0, opened_at = NULL, next_probe_at = NULL, updated_at = now()`,
    [sourceId, provider],
  );
}

export async function readPersistedProviderResult(
  engine: BrainEngine,
  sourceId: string,
  sessionId: string,
  generation: number,
): Promise<PersistedProviderResult | null> {
  const rows = await engine.executeRaw<{ correlation_id: string; result_json: unknown; usage_json: unknown }>(
    `SELECT correlation_id, result_json, usage_json
       FROM context_mirror_provider_calls
      WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND state = 'result_persisted'
      ORDER BY result_persisted_at DESC LIMIT 1`,
    [sourceId, sessionId, generation],
  );
  const row = rows[0];
  if (!row) return null;
  const result = parseJsonObject(row.result_json);
  const memories = Array.isArray(result.memories)
    ? result.memories.filter((value): value is string => typeof value === 'string')
    : [];
  const usageRow = parseJsonObject(row.usage_json);
  const usage: Record<string, number> = {};
  for (const [key, value] of Object.entries(usageRow)) {
    if (typeof value === 'number' && Number.isFinite(value)) usage[key] = value;
  }
  return { correlationId: row.correlation_id, memories, usage };
}

export async function prepareProviderCall(
  engine: BrainEngine,
  args: { runId: string; sourceId: string; sessionId: string; generation: number; requestFingerprint: string },
): Promise<string> {
  const correlationId = randomUUID();
  await engine.executeRaw(
    `INSERT INTO context_mirror_provider_calls (
       correlation_id, run_id, source_id, session_id, generation, state, request_fingerprint
     ) VALUES ($1, $2, $3, $4, $5, 'prepared', $6)`,
    [correlationId, args.runId, args.sourceId, args.sessionId, args.generation, args.requestFingerprint],
  );
  return correlationId;
}

export async function markProviderCallInflight(engine: BrainEngine, correlationId: string): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_provider_calls
        SET state = 'inflight', sent_at = now(), updated_at = now()
      WHERE correlation_id = $1 AND state = 'prepared'`,
    [correlationId],
  );
}

export async function persistProviderResult(
  engine: BrainEngine,
  correlationId: string,
  memories: string[],
  usage: Record<string, number>,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_provider_calls
        SET state = 'result_persisted', result_json = $2::jsonb, usage_json = $3::jsonb,
            result_persisted_at = now(), updated_at = now()
      WHERE correlation_id = $1 AND state = 'inflight'`,
    [correlationId, JSON.stringify({ memories }), JSON.stringify(usage)],
  );
}

export async function markProviderCallFailed(
  engine: BrainEngine,
  correlationId: string,
  errorClass: string,
  errorMessage: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_provider_calls
        SET state = 'failed', error_class = $2, error_message = $3, updated_at = now()
      WHERE correlation_id = $1 AND state IN ('prepared','inflight')`,
    [correlationId, errorClass, errorMessage.slice(0, 500)],
  );
}

export async function finishSession(
  engine: BrainEngine,
  args: { sourceId: string; sessionId: string; claimId: string; state: 'complete' | 'quarantined'; disposition: string },
): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_session_heads
        SET state = $4, disposition = $5, claim_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE source_id = $1 AND session_id = $2 AND claim_id = $3`,
    [args.sourceId, args.sessionId, args.claimId, args.state, args.disposition],
  );
}

export async function releaseSessionClaim(
  engine: BrainEngine,
  args: { sourceId: string; sessionId: string; claimId: string },
): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_session_heads
        SET state = 'pending', claim_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE source_id = $1 AND session_id = $2 AND claim_id = $3 AND state = 'claimed'`,
    [args.sourceId, args.sessionId, args.claimId],
  );
}
