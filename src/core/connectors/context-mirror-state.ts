import { createHash, randomUUID } from 'node:crypto';

import type { BrainEngine } from '../engine.ts';
import { executeRawJsonb } from '../sql-query.ts';

const BOOTSTRAP_CHECKPOINT = 'capture_session_scan_v1';
const DEFAULT_BOOTSTRAP_BATCH = 5_000;
const RECONCILIATION_VERSION = 2;
const DEFAULT_RECONCILIATION_LEASE_MS = 60_000;
const CLAIM_LEASE_MS = 15 * 60_000;
const PARTITION_LEASE_MS = 15 * 60_000;
const REVIEW_RESERVATION_MS = 60 * 60_000;
const DEFAULT_PENDING_REVIEW_LIMIT = 10;
const DEFAULT_STAGING_LIMIT = 50;
const DEFAULT_STAGING_BYTES = 25 * 1024 * 1024;
const DEFAULT_REVIEW_MAX_AGE_HOURS = 7 * 24;
const COLLISION_DIGEST_LENGTH = 12;
const COLLISION_SESSION_SLUG_LENGTH = 96;

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
  ambiguousIdentityPages: number;
  totalHeads: number;
  pendingEligible: number;
}

export interface ReconciliationV2Result {
  status: 'busy' | 'partial' | 'complete' | 'blocked';
  schemaVersion: 2;
  scanned: number;
  insertedMembership: number;
  membership: number;
  ambiguousIdentityPages: number;
  totalHeads: number;
  pendingEligible: number;
  cursorPageId: number;
  scanUpperPageId: number;
  leaseGeneration: number;
  resumeFingerprint: string;
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

export interface ContextGenerationInput {
  sourceId: string;
  sessionId: string;
  generation: number;
  inputHash: string;
  originator: string | null;
  runtime: string | null;
  transformVersion: string;
  model: string;
  requiresHumanReview?: boolean;
}

export interface ContextGenerationPartition {
  partitionKey: string;
  distilledSlug: string;
  contentHash: string;
}

export interface ClaimedContextPartition extends ContextGenerationPartition {
  sourceId: string;
  sessionId: string;
  generation: number;
  claimId: string;
  requiresHumanReview: boolean;
}

export interface ReviewCapacitySnapshot {
  pendingLimit: number;
  stagingLimit: number;
  stagingBytesLimit: number;
  humanPending: number;
  humanBytes: number;
  staged: number;
  stagedBytes: number;
  reservedSlots: number;
  reservedBytes: number;
  freshQuota: number;
  humanOldestAt: Date | null;
  stagedOldestAt: Date | null;
  humanMaxAgeHours: number;
  stagingMaxAgeHours: number;
  humanAgeExceeded: boolean;
  stagingAgeExceeded: boolean;
  historicalHuman: number;
  historicalStaged: number;
  historicalReservedSlots: number;
}

export interface ContextMirrorRecoveryHold {
  active: boolean;
  generation: number;
  reason: string;
  actedBy: string;
  heldAt: Date | null;
  releasedAt: Date | null;
  updatedAt: Date | null;
}

export interface ContextGenerationRollbackReport {
  status: 'rolled_back' | 'already_rolled_back';
  source_id: string;
  session_id: string;
  generation: number;
  rollback_generation: number;
  rejected_candidates: number;
  actor: string;
  reason: string;
  rolled_back_at: string;
  verification: {
    current_generation: number;
    rolled_back_generation_state: 'superseded';
    restored_generation_state: 'complete';
  };
}

interface CaptureMetadataRow {
  id: number | string;
  slug: string;
  frontmatter: Record<string, unknown> | string | null;
  session_id_text: string | null;
  session_id_json_type: string | null;
  captured_at: Date | string;
  updated_at: Date | string;
}

/** Release only the exact active hold generation observed by the caller. */
export async function releaseContextMirrorRecoveryHold(
  engine: BrainEngine,
  sourceId: string,
  reason: string,
  actor: string,
  expectedGeneration: number,
): Promise<ContextMirrorRecoveryHold | null> {
  const cleanReason = reason.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
  const cleanActor = actor.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || 'system';
  const rows = await engine.executeRaw<{ source_id: string }>(
    `UPDATE context_mirror_recovery_holds
        SET active = false, reason = $3, acted_by = $4,
            released_at = now(), updated_at = now(), generation = generation + 1
      WHERE source_id = $1 AND active = true AND generation = $2
      RETURNING source_id`,
    [sourceId, expectedGeneration, cleanReason, cleanActor],
  );
  return rows[0] ? await readContextMirrorRecoveryHold(engine, sourceId) : null;
}

interface ScanCursor {
  updatedAt: string;
  id: number;
  ambiguousIdentityPages: number;
}

interface ReconciliationStateRow {
  phase: 'rebuilding' | 'tailing' | 'blocked';
  cursor_page_id: number | string;
  scan_upper_page_id: number | string;
  lease_generation: number | string;
  lease_owner: string | null;
  membership_count: number | string;
  ambiguous_count: number | string;
  head_count: number | string;
}

/** Real Postgres/PGLite engines expose their driver escape hatch; lightweight
 * unit fakes intentionally do not and use the legacy in-memory path. */
export function supportsContextMirrorOperationalState(engine: BrainEngine): boolean {
  const row = engine as BrainEngine & { sql?: unknown; db?: unknown };
  return (engine.kind === 'postgres' && row.sql != null) || (engine.kind === 'pglite' && row.db != null);
}

export async function readContextMirrorRecoveryHold(
  engine: BrainEngine,
  sourceId: string,
): Promise<ContextMirrorRecoveryHold> {
  const rows = await engine.executeRaw<{
    active: boolean;
    generation: number | string;
    reason: string;
    acted_by: string;
    held_at: Date | string | null;
    released_at: Date | string | null;
    updated_at: Date | string | null;
  }>(
    `SELECT active, generation, reason, acted_by, held_at, released_at, updated_at
       FROM context_mirror_recovery_holds WHERE source_id = $1`,
    [sourceId],
  );
  const row = rows[0];
  return {
    active: row?.active === true,
    generation: Number(row?.generation ?? 0),
    reason: row?.reason ?? '',
    actedBy: row?.acted_by ?? '',
    heldAt: row?.held_at ? new Date(row.held_at) : null,
    releasedAt: row?.released_at ? new Date(row.released_at) : null,
    updatedAt: row?.updated_at ? new Date(row.updated_at) : null,
  };
}

/** Operator-facing state primitive used by the guarded deployment/recovery
 * workflow. An empty reason can never activate the hold. */
export async function setContextMirrorRecoveryHold(
  engine: BrainEngine,
  sourceId: string,
  active: boolean,
  reason: string,
  actor = 'system',
): Promise<ContextMirrorRecoveryHold> {
  const cleanReason = reason.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
  const cleanActor = actor.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || 'system';
  if (active && !cleanReason) throw new Error('context mirror recovery hold requires a reason');
  await engine.executeRaw(
    `INSERT INTO context_mirror_recovery_holds (
       source_id, active, generation, reason, acted_by, held_at, released_at, updated_at
     ) VALUES (
       $1, $2, 1, $3, $4,
       CASE WHEN $2 THEN now() ELSE NULL END,
       CASE WHEN $2 THEN NULL ELSE now() END,
       now()
     )
     ON CONFLICT (source_id) DO UPDATE SET
       active = EXCLUDED.active,
       generation = context_mirror_recovery_holds.generation + 1,
       reason = EXCLUDED.reason,
       acted_by = EXCLUDED.acted_by,
       held_at = CASE
         WHEN EXCLUDED.active AND context_mirror_recovery_holds.active
           THEN context_mirror_recovery_holds.held_at
         WHEN EXCLUDED.active THEN now()
         ELSE context_mirror_recovery_holds.held_at
       END,
       released_at = CASE WHEN EXCLUDED.active THEN NULL ELSE now() END,
       updated_at = now()
     WHERE (context_mirror_recovery_holds.active,
            context_mirror_recovery_holds.reason,
            context_mirror_recovery_holds.acted_by)
       IS DISTINCT FROM (EXCLUDED.active, EXCLUDED.reason, EXCLUDED.acted_by)`,
    [sourceId, active, cleanReason, cleanActor],
  );
  return await readContextMirrorRecoveryHold(engine, sourceId);
}

export function parseJsonObject(value: unknown): Record<string, unknown> {
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
  const ambiguousIdentityPages = Number(row.ambiguous_identity_pages ?? 0);
  return {
    updatedAt,
    id: Number.isFinite(id) ? id : 0,
    ambiguousIdentityPages: Number.isFinite(ambiguousIdentityPages) ? ambiguousIdentityPages : 0,
  };
}

function capturePrefixFor(row: CaptureMetadataRow): string | null {
  const parts = row.slug.split('/');
  if (parts[0] !== 'capture' || !parts[1]) return null;
  return `capture/${parts[1]}/`;
}

function sessionIdFor(
  row: CaptureMetadataRow,
): { status: 'resolved'; sessionId: string; prefix: string } | { status: 'ambiguous' } | null {
  const prefix = capturePrefixFor(row);
  if (!prefix) return null;
  // Read the canonical text representation inside the database. Legacy YAML
  // imported digit-only Hermes IDs as JSON numbers; hydrating that JSON into
  // JavaScript first can round IDs beyond Number.MAX_SAFE_INTEGER and merge
  // unrelated sessions. PostgreSQL/PGLite `->>` preserves the exact digits.
  const sessionId = typeof row.session_id_text === 'string' ? row.session_id_text.trim() : '';
  const supportedIdentity = row.session_id_json_type === 'string'
    || (row.session_id_json_type === 'number' && /^[0-9]+$/.test(sessionId));
  if (supportedIdentity && sessionId) {
    return { status: 'resolved', sessionId, prefix };
  }
  return { status: 'ambiguous' };
}

function collisionSessionSlug(baseSlug: string, sessionId: string): string {
  const digest = createHash('sha256').update(sessionId, 'utf8').digest('hex').slice(0, COLLISION_DIGEST_LENGTH);
  const baseLimit = COLLISION_SESSION_SLUG_LENGTH - digest.length - 2;
  const boundedBase = baseSlug.slice(0, Math.max(1, baseLimit)).replace(/-+$/g, '') || 'unknown';
  return `${boundedBase}--${digest}`;
}

interface SessionLocatorOwnership {
  headOwners: Set<string>;
  artifactOwners: Array<string | null>;
}

function locatorOwnership(
  ownershipBySlug: Map<string, SessionLocatorOwnership>,
  sessionSlug: string,
): SessionLocatorOwnership {
  const current = ownershipBySlug.get(sessionSlug);
  if (current) return current;
  const empty = { headOwners: new Set<string>(), artifactOwners: [] };
  ownershipBySlug.set(sessionSlug, empty);
  return empty;
}

function resolveStoredSessionSlug(
  sessionId: string,
  legacySlug: string,
  existingSlug: string | undefined,
  ownershipBySlug: Map<string, SessionLocatorOwnership>,
): { sessionSlug: string; ownershipConflict: boolean } {
  const compatible = (ownership: SessionLocatorOwnership): boolean =>
    [...ownership.headOwners].every((owner) => owner === sessionId)
      && ownership.artifactOwners.every((owner) => owner === sessionId);

  if (existingSlug) {
    return {
      sessionSlug: existingSlug,
      ownershipConflict: !compatible(locatorOwnership(ownershipBySlug, existingSlug)),
    };
  }

  const legacyOwnership = locatorOwnership(ownershipBySlug, legacySlug);
  if (compatible(legacyOwnership)) {
    return { sessionSlug: legacySlug, ownershipConflict: false };
  }

  const hasOwnerlessArtifact = legacyOwnership.artifactOwners.some((owner) => owner === null);
  if (hasOwnerlessArtifact && legacyOwnership.headOwners.size === 0
      && legacyOwnership.artifactOwners.every((owner) => owner === null)) {
    return { sessionSlug: legacySlug, ownershipConflict: true };
  }

  const sessionSlug = collisionSessionSlug(legacySlug, sessionId);
  if (!compatible(locatorOwnership(ownershipBySlug, sessionSlug))) {
    throw new Error('context mirror session locator ownership conflict');
  }
  return { sessionSlug, ownershipConflict: hasOwnerlessArtifact };
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
            NULLIF(frontmatter->>'session_id', '') AS session_id_text,
            jsonb_typeof(frontmatter->'session_id') AS session_id_json_type,
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
  let ambiguousIdentityPages = 0;
  for (const row of rows) {
    const identity = sessionIdFor(row);
    if (!identity) continue;
    if (identity.status === 'ambiguous') {
      ambiguousIdentityPages += 1;
      continue;
    }
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
    const sessionIds = [...grouped.keys()];
    const candidateSlugs = [...new Set([...grouped.values()].flatMap((head) => [
      head.sessionSlug,
      collisionSessionSlug(head.sessionSlug, head.sessionId),
    ]))];
    const existingHeads = sessionIds.length === 0
      ? []
      : await tx.executeRaw<{ session_id: string; session_slug: string }>(
          `SELECT session_id, session_slug
             FROM context_mirror_session_heads
            WHERE source_id = $1
              AND (session_id = ANY($2::text[]) OR session_slug = ANY($3::text[]))`,
          [opts.sourceId, sessionIds, candidateSlugs],
        );
    const artifactRows = candidateSlugs.length === 0
      ? []
      : await tx.executeRaw<{ session_slug: string; session_id: string | null }>(
          `SELECT CASE
                    WHEN slug LIKE 'distill-state/%'
                      THEN substr(slug, length('distill-state/') + 1)
                    ELSE split_part(slug, '/', 2)
                  END AS session_slug,
                  NULLIF(frontmatter->>'session_id', '') AS session_id
             FROM pages
            WHERE source_id = $1 AND deleted_at IS NULL
              AND (
                (slug LIKE 'distill-state/%' AND substr(slug, length('distill-state/') + 1) = ANY($2::text[]))
                OR (slug LIKE 'distilled/%' AND split_part(slug, '/', 2) = ANY($2::text[]))
              )`,
          [opts.sourceId, candidateSlugs],
        );
    const existingSlugBySession = new Map(existingHeads.map((row) => [row.session_id, row.session_slug]));
    const ownershipBySlug = new Map<string, SessionLocatorOwnership>();
    for (const row of existingHeads) {
      locatorOwnership(ownershipBySlug, row.session_slug).headOwners.add(row.session_id);
    }
    for (const row of artifactRows) {
      locatorOwnership(ownershipBySlug, row.session_slug).artifactOwners.push(row.session_id);
    }

    for (const head of grouped.values()) {
      const locator = resolveStoredSessionSlug(
        head.sessionId,
        head.sessionSlug,
        existingSlugBySession.get(head.sessionId),
        ownershipBySlug,
      );
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
           current_eligible_at = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN NULL
             ELSE context_mirror_session_heads.current_eligible_at
           END,
           current_cohort_at = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN NULL
             ELSE context_mirror_session_heads.current_cohort_at
           END,
           current_generation = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
               THEN context_mirror_session_heads.current_generation + 1
             ELSE context_mirror_session_heads.current_generation
           END,
           updated_at = now()`,
        [opts.sourceId, head.sessionId, locator.sessionSlug, head.prefix, head.newest.toISOString(), head.turns],
      );
      locatorOwnership(ownershipBySlug, locator.sessionSlug).headOwners.add(head.sessionId);
      if (locator.ownershipConflict) {
        await tx.executeRaw(
          `UPDATE context_mirror_session_heads
              SET state = 'quarantined', disposition = 'locator_ownership_conflict',
                  claim_id = NULL, lease_expires_at = NULL,
                  current_eligible_at = NULL, current_cohort_at = NULL,
                  updated_at = now()
            WHERE source_id = $1 AND session_id = $2`,
          [opts.sourceId, head.sessionId],
        );
      }
    }
    const last = rows.at(-1);
    const nextAmbiguousIdentityPages = cursor.ambiguousIdentityPages + ambiguousIdentityPages;
    const complete = rows.length < batchSize && nextAmbiguousIdentityPages === 0;
    const next = last
      ? {
          updated_at: new Date(last.updated_at).toISOString(),
          id: Number(last.id),
          ambiguous_identity_pages: nextAmbiguousIdentityPages,
        }
      : {
          updated_at: cursor.updatedAt,
          id: cursor.id,
          ambiguous_identity_pages: nextAmbiguousIdentityPages,
        };
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
                current_eligible_at = COALESCE(current_eligible_at, $2::timestamptz),
                current_cohort_at = COALESCE(current_cohort_at, $2::timestamptz),
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
                 AND NULLIF(p.frontmatter->>'session_id', '') = h.session_id
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
            count(*) FILTER (WHERE state = 'pending' AND current_eligible_at IS NOT NULL) AS pending
       FROM context_mirror_session_heads WHERE source_id = $1`,
    [opts.sourceId],
  );
  return {
    scanned: rows.length,
    complete: rows.length < batchSize && cursor.ambiguousIdentityPages + ambiguousIdentityPages === 0,
    ambiguousIdentityPages: cursor.ambiguousIdentityPages + ambiguousIdentityPages,
    totalHeads: Number(counts[0]?.total ?? 0),
    pendingEligible: Number(counts[0]?.pending ?? 0),
  };
}

function reconciliationFingerprint(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function boundedAuditText(value: string, fallback: string, limit: number): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, limit) || fallback;
}

function reconciliationResult(
  state: ReconciliationStateRow,
  counts: { membership: number; ambiguous: number; heads: number; pending: number },
  status: ReconciliationV2Result['status'],
  scanned: number,
  insertedMembership: number,
): ReconciliationV2Result {
  const cursorPageId = Number(state.cursor_page_id);
  const scanUpperPageId = Number(state.scan_upper_page_id);
  const leaseGeneration = Number(state.lease_generation);
  return {
    status,
    schemaVersion: 2,
    scanned,
    insertedMembership,
    membership: counts.membership,
    ambiguousIdentityPages: counts.ambiguous,
    totalHeads: counts.heads,
    pendingEligible: counts.pending,
    cursorPageId,
    scanUpperPageId,
    leaseGeneration,
    resumeFingerprint: reconciliationFingerprint({
      version: RECONCILIATION_VERSION,
      status,
      cursor_page_id: cursorPageId,
      scan_upper_page_id: scanUpperPageId,
      membership: counts.membership,
      ambiguous: counts.ambiguous,
      heads: counts.heads,
    }),
  };
}

async function reconciliationCounts(
  engine: BrainEngine,
  sourceId: string,
): Promise<{ membership: number; ambiguous: number; heads: number; pending: number }> {
  const rows = await engine.executeRaw<{
    membership: number | string;
    ambiguous: number | string;
    heads: number | string;
    pending: number | string;
  }>(
    `WITH membership_counts AS (
       SELECT count(*) AS membership,
              count(*) FILTER (WHERE m.identity_status = 'ambiguous') AS ambiguous
         FROM context_mirror_capture_membership m
         JOIN pages p ON p.source_id = m.source_id AND p.id = m.page_id
        WHERE m.source_id = $1 AND p.deleted_at IS NULL
     ), head_counts AS (
       SELECT count(*) AS heads
         FROM context_mirror_reconciliation_heads
        WHERE source_id = $1
     ), pending_counts AS (
       SELECT count(*) AS pending
         FROM context_mirror_session_heads
        WHERE source_id = $1 AND state = 'pending' AND current_eligible_at IS NOT NULL
     )
     SELECT membership_counts.membership, membership_counts.ambiguous,
            head_counts.heads, pending_counts.pending
       FROM membership_counts CROSS JOIN head_counts CROSS JOIN pending_counts`,
    [sourceId],
  );
  return {
    membership: Number(rows[0]?.membership ?? 0),
    ambiguous: Number(rows[0]?.ambiguous ?? 0),
    heads: Number(rows[0]?.heads ?? 0),
    pending: Number(rows[0]?.pending ?? 0),
  };
}

/**
 * Reconcile raw capture metadata into exact session heads without hydrating a
 * transcript or calling a provider. Page IDs are admitted once into an
 * immutable membership ledger. Each affected head is then replaced from the
 * ledger aggregate, so a retry cannot increment its turn count twice.
 *
 * The lease is acquired in its own short transaction. Every work transaction
 * checks the monotonic generation and owner under row lock before it writes;
 * an expired worker therefore cannot overwrite a replacement worker.
 */
export async function runSessionHeadReconciliationV2(
  engine: BrainEngine,
  opts: {
    sourceId: string;
    now: Date;
    idleHours: number;
    sessionSlug: (sessionId: string) => string;
    batchSize?: number;
    leaseMs?: number;
    actor: string;
    reason: string;
  },
): Promise<ReconciliationV2Result> {
  const batchSize = opts.batchSize ?? DEFAULT_BOOTSTRAP_BATCH;
  const leaseMs = opts.leaseMs ?? DEFAULT_RECONCILIATION_LEASE_MS;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new Error('context mirror reconciliation batchSize must be an integer from 1 to 5000');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 5 * 60_000) {
    throw new Error('context mirror reconciliation leaseMs must be an integer from 1000 to 300000');
  }
  if (!Number.isFinite(opts.now.getTime()) || !Number.isFinite(opts.idleHours) || opts.idleHours < 0) {
    throw new Error('context mirror reconciliation time bounds are invalid');
  }
  const actor = boundedAuditText(opts.actor, 'system', 120);
  const reason = boundedAuditText(opts.reason, 'bounded reconciliation', 240);
  const owner = randomUUID();
  const requestFingerprint = reconciliationFingerprint({
    version: RECONCILIATION_VERSION,
    source_id: opts.sourceId,
    batch_size: batchSize,
    idle_hours: opts.idleHours,
  });

  await engine.transaction(async (tx) => {
    const initialized = await tx.executeRaw<{ source_id: string; scan_upper_page_id: number | string }>(
      `INSERT INTO context_mirror_reconciliation_state (
         source_id, version, phase, cursor_page_id, scan_upper_page_id
       ) VALUES (
         $1, 2, 'rebuilding', 0,
         COALESCE((SELECT max(id) FROM pages
                    WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'capture/%'), 0)
       ) ON CONFLICT (source_id) DO NOTHING
       RETURNING source_id, scan_upper_page_id`,
      [opts.sourceId],
    );
    if (initialized[0]) {
      await executeRawJsonb(
        tx,
        `INSERT INTO context_mirror_admin_audit (
           source_id, operation, actor, reason, request_fingerprint,
           precondition_fingerprint, outcome, before_counts, after_counts, receipt_ref
         ) VALUES ($1, 'context_mirror_reconcile_v2_initialize', $2, $3, $4, $5,
                   'initialized', '{}'::jsonb, $6::jsonb, 'reconcile-v2:initialize')`,
        [
          opts.sourceId,
          actor,
          reason,
          requestFingerprint,
          reconciliationFingerprint({ state: 'absent' }),
        ],
        [
          { scan_upper_page_id: Number(initialized[0].scan_upper_page_id) },
        ],
      );
    }
  });

  const acquired = await engine.transaction(async (tx) => {
    const beforeRows = await tx.executeRaw<ReconciliationStateRow>(
      `SELECT phase, cursor_page_id, scan_upper_page_id, lease_generation,
              lease_owner, membership_count, ambiguous_count, head_count
         FROM context_mirror_reconciliation_state
        WHERE source_id = $1 FOR UPDATE`,
      [opts.sourceId],
    );
    const before = beforeRows[0];
    if (!before) throw new Error('context mirror reconciliation state unavailable');
    const rows = await tx.executeRaw<ReconciliationStateRow>(
      `UPDATE context_mirror_reconciliation_state
          SET lease_generation = lease_generation + 1,
              lease_owner = $2,
              lease_expires_at = now() + ($3::text || ' milliseconds')::interval,
              scan_upper_page_id = CASE
                WHEN phase IN ('tailing','blocked') THEN GREATEST(
                  scan_upper_page_id,
                  COALESCE((SELECT max(id) FROM pages
                             WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'capture/%'), 0)
                )
                ELSE scan_upper_page_id
              END,
              updated_at = now()
        WHERE source_id = $1
          AND (lease_owner IS NULL OR lease_expires_at <= now())
      RETURNING phase, cursor_page_id, scan_upper_page_id, lease_generation,
                lease_owner, membership_count, ambiguous_count, head_count`,
      [opts.sourceId, owner, leaseMs],
    );
    const row = rows[0];
    if (!row) return null;
    await executeRawJsonb(
      tx,
      `INSERT INTO context_mirror_admin_audit (
         source_id, operation, actor, reason, request_fingerprint,
         precondition_fingerprint, outcome, before_counts, after_counts, receipt_ref
       ) VALUES ($1, 'context_mirror_reconcile_v2_lease', $2, $3, $4, $5,
                 'acquired', $7::jsonb, $8::jsonb, $6)`,
      [
        opts.sourceId,
        actor,
        reason,
        requestFingerprint,
        reconciliationFingerprint({
          phase: before.phase,
          cursor_page_id: Number(before.cursor_page_id),
          lease_generation: Number(before.lease_generation),
        }),
        `reconcile-v2:${row.lease_generation}`,
      ],
      [
        { cursor_page_id: Number(before.cursor_page_id), lease_generation: Number(before.lease_generation) },
        { cursor_page_id: Number(row.cursor_page_id), lease_generation: Number(row.lease_generation) },
      ],
    );
    return row;
  });

  if (!acquired) {
    const [state] = await engine.executeRaw<ReconciliationStateRow>(
      `SELECT phase, cursor_page_id, scan_upper_page_id, lease_generation,
              lease_owner, membership_count, ambiguous_count, head_count
         FROM context_mirror_reconciliation_state WHERE source_id = $1`,
      [opts.sourceId],
    );
    if (!state) throw new Error('context mirror reconciliation state unavailable');
    const counts = await reconciliationCounts(engine, opts.sourceId);
    return reconciliationResult(state, counts, 'busy', 0, 0);
  }

  const leaseGeneration = Number(acquired.lease_generation);
  return await engine.transaction(async (tx) => {
    const stateRows = await tx.executeRaw<ReconciliationStateRow>(
      `SELECT phase, cursor_page_id, scan_upper_page_id, lease_generation,
              lease_owner, membership_count, ambiguous_count, head_count
         FROM context_mirror_reconciliation_state
        WHERE source_id = $1 FOR UPDATE`,
      [opts.sourceId],
    );
    const state = stateRows[0];
    if (!state || state.lease_owner !== owner || Number(state.lease_generation) !== leaseGeneration) {
      throw new Error('context mirror reconciliation lease lost');
    }

    // A blocked run must be able to heal after an operator corrects legacy
    // metadata. Re-evaluate only previously ambiguous ledger rows, using
    // `->>` so digit-only JSON numbers retain their exact database text and
    // never pass through JavaScript's lossy Number representation.
    const recoveredMembership = state.phase === 'blocked' || Number(state.ambiguous_count) > 0
      ? await tx.executeRaw<{ session_id: string }>(
          `UPDATE context_mirror_capture_membership m
              SET identity_status = 'resolved',
                  session_id = NULLIF(btrim(p.frontmatter->>'session_id'), ''),
                  capture_slug_prefix = 'capture/' || split_part(p.slug, '/', 2) || '/'
             FROM pages p
            WHERE m.source_id = $1
              AND m.identity_status = 'ambiguous'
              AND p.source_id = m.source_id AND p.id = m.page_id
              AND p.deleted_at IS NULL AND p.slug LIKE 'capture/%/%'
              AND (
                (jsonb_typeof(p.frontmatter->'session_id') = 'string'
                  AND NULLIF(btrim(p.frontmatter->>'session_id'), '') IS NOT NULL)
                OR
                (jsonb_typeof(p.frontmatter->'session_id') = 'number'
                  AND (p.frontmatter->>'session_id') ~ '^[0-9]+$')
              )
          RETURNING m.session_id`,
          [opts.sourceId],
        )
      : [];

    const cursorPageId = Number(state.cursor_page_id);
    const upperPageId = Number(state.scan_upper_page_id);
    const rows = await tx.executeRaw<CaptureMetadataRow>(
      `SELECT id, slug, frontmatter,
              NULLIF(frontmatter->>'session_id', '') AS session_id_text,
              jsonb_typeof(frontmatter->'session_id') AS session_id_json_type,
              CASE
                WHEN COALESCE(frontmatter->>'captured_at', '') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                  THEN (frontmatter->>'captured_at')::timestamptz
                ELSE updated_at
              END AS captured_at,
              updated_at
         FROM pages
        WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE 'capture/%'
          AND id > $2 AND id <= $3
        ORDER BY id ASC
        LIMIT $4`,
      [opts.sourceId, cursorPageId, upperPageId, batchSize],
    );
    const membershipInput = rows.map((row) => {
      const identity = sessionIdFor(row);
      const capturedAt = new Date(row.captured_at);
      const validCapturedAt = Number.isFinite(capturedAt.getTime()) ? capturedAt : new Date(row.updated_at);
      return identity?.status === 'resolved'
        ? {
            page_id: Number(row.id), page_slug: row.slug, identity_status: 'resolved',
            session_id: identity.sessionId, capture_slug_prefix: identity.prefix,
            captured_at: validCapturedAt.toISOString(),
          }
        : {
            page_id: Number(row.id), page_slug: row.slug, identity_status: 'ambiguous',
            session_id: null, capture_slug_prefix: capturePrefixFor(row),
            captured_at: validCapturedAt.toISOString(),
          };
    });
    const inserted = membershipInput.length === 0
      ? []
      : await executeRawJsonb<{ page_id: number | string }>(
          tx,
          `WITH incoming AS (
             SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
               page_id bigint, page_slug text, identity_status text,
               session_id text, capture_slug_prefix text, captured_at timestamptz
             )
           )
           INSERT INTO context_mirror_capture_membership (
             source_id, page_id, page_slug, identity_status,
             session_id, capture_slug_prefix, captured_at
           )
           SELECT $1, page_id, page_slug, identity_status,
                  session_id, capture_slug_prefix, captured_at
             FROM incoming
           ON CONFLICT (source_id, page_id) DO NOTHING
           RETURNING page_id`,
          [opts.sourceId],
          [membershipInput],
        );

    const sessionIds = [...new Set([
      ...recoveredMembership.map((item) => item.session_id),
      ...membershipInput
        .filter((item) => item.identity_status === 'resolved' && item.session_id)
        .map((item) => item.session_id as string),
    ])];
    const aggregates = sessionIds.length === 0
      ? []
      : await tx.executeRaw<{
          session_id: string;
          capture_slug_prefix: string;
          turn_count: number | string;
          newest_capture_at: Date | string;
        }>(
          `SELECT session_id,
                  min(capture_slug_prefix) AS capture_slug_prefix,
                  count(*) AS turn_count,
                  max(captured_at) AS newest_capture_at
             FROM context_mirror_capture_membership
            WHERE source_id = $1 AND identity_status = 'resolved'
              AND session_id = ANY($2::text[])
            GROUP BY session_id`,
          [opts.sourceId, sessionIds],
        );
    const candidateSlugs = [...new Set(aggregates.flatMap((head) => {
      const legacy = opts.sessionSlug(head.session_id);
      return [legacy, collisionSessionSlug(legacy, head.session_id)];
    }))];
    const existingHeads = sessionIds.length === 0
      ? []
      : await tx.executeRaw<{ session_id: string; session_slug: string }>(
          `SELECT DISTINCT session_id, session_slug FROM (
             SELECT session_id, session_slug FROM context_mirror_session_heads
              WHERE source_id = $1
                AND (session_id = ANY($2::text[]) OR session_slug = ANY($3::text[]))
             UNION ALL
             SELECT session_id, session_slug FROM context_mirror_reconciliation_heads
              WHERE source_id = $1
                AND (session_id = ANY($2::text[]) OR session_slug = ANY($3::text[]))
           ) owned`,
          [opts.sourceId, sessionIds, candidateSlugs],
        );
    const artifactRows = candidateSlugs.length === 0
      ? []
      : await tx.executeRaw<{ session_slug: string; session_id: string | null }>(
          `SELECT CASE
                    WHEN slug LIKE 'distill-state/%' THEN substr(slug, length('distill-state/') + 1)
                    ELSE split_part(slug, '/', 2)
                  END AS session_slug,
                  NULLIF(frontmatter->>'session_id', '') AS session_id
             FROM pages
            WHERE source_id = $1 AND deleted_at IS NULL
              AND ((slug LIKE 'distill-state/%' AND substr(slug, length('distill-state/') + 1) = ANY($2::text[]))
                OR (slug LIKE 'distilled/%' AND split_part(slug, '/', 2) = ANY($2::text[])))`,
          [opts.sourceId, candidateSlugs],
        );
    const existingSlugBySession = new Map(existingHeads.map((row) => [row.session_id, row.session_slug]));
    const ownershipBySlug = new Map<string, SessionLocatorOwnership>();
    for (const row of existingHeads) locatorOwnership(ownershipBySlug, row.session_slug).headOwners.add(row.session_id);
    for (const row of artifactRows) locatorOwnership(ownershipBySlug, row.session_slug).artifactOwners.push(row.session_id);

    const headInput = aggregates.map((head) => {
      const legacySlug = opts.sessionSlug(head.session_id);
      const locator = resolveStoredSessionSlug(
        head.session_id,
        legacySlug,
        existingSlugBySession.get(head.session_id),
        ownershipBySlug,
      );
      locatorOwnership(ownershipBySlug, locator.sessionSlug).headOwners.add(head.session_id);
      return {
        session_id: head.session_id,
        session_slug: locator.sessionSlug,
        capture_slug_prefix: head.capture_slug_prefix,
        newest_capture_at: new Date(head.newest_capture_at).toISOString(),
        turn_count: Number(head.turn_count),
        ownership_conflict: locator.ownershipConflict,
      };
    });
    if (headInput.length > 0) {
      await executeRawJsonb(
        tx,
        `WITH incoming AS (
           SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(
             session_id text, session_slug text, capture_slug_prefix text,
             newest_capture_at timestamptz, turn_count integer, ownership_conflict boolean
           )
         )
         INSERT INTO context_mirror_reconciliation_heads (
           source_id, session_id, session_slug, capture_slug_prefix,
           newest_capture_at, turn_count, state, disposition
         )
         SELECT $1, session_id, session_slug, capture_slug_prefix,
                newest_capture_at, turn_count,
                CASE WHEN ownership_conflict THEN 'quarantined' ELSE 'ready' END,
                CASE WHEN ownership_conflict THEN 'locator_ownership_conflict' ELSE NULL END
           FROM incoming
         ON CONFLICT (source_id, session_id) DO UPDATE SET
           session_slug = EXCLUDED.session_slug,
           capture_slug_prefix = EXCLUDED.capture_slug_prefix,
           newest_capture_at = EXCLUDED.newest_capture_at,
           turn_count = EXCLUDED.turn_count,
           state = EXCLUDED.state,
           disposition = EXCLUDED.disposition,
           updated_at = now()`,
        [opts.sourceId],
        [headInput],
      );
    }

    const last = rows.at(-1);
    const nextCursor = last ? Number(last.id) : cursorPageId;
    const reachedUpper = nextCursor >= upperPageId;
    const ambiguousRows = await tx.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count
         FROM context_mirror_capture_membership m
         JOIN pages p ON p.source_id = m.source_id AND p.id = m.page_id
        WHERE m.source_id = $1 AND m.identity_status = 'ambiguous'
          AND p.deleted_at IS NULL`,
      [opts.sourceId],
    );
    const ambiguousCount = Number(ambiguousRows[0]?.count ?? 0);
    const initialActivation = reachedUpper && state.phase !== 'tailing' && ambiguousCount === 0;
    const updateLiveHeads = initialActivation || state.phase === 'tailing';
    if (updateLiveHeads) {
      await tx.executeRaw(
        `WITH active AS (
           SELECT m.session_id,
                  min(m.capture_slug_prefix) AS capture_slug_prefix,
                  max(m.captured_at) AS newest_capture_at,
                  count(*)::integer AS turn_count
             FROM context_mirror_capture_membership m
             JOIN pages p ON p.source_id = m.source_id AND p.id = m.page_id
            WHERE m.source_id = $1 AND m.identity_status = 'resolved'
              AND p.deleted_at IS NULL
            GROUP BY m.session_id
         )
         UPDATE context_mirror_reconciliation_heads h
            SET capture_slug_prefix = active.capture_slug_prefix,
                newest_capture_at = active.newest_capture_at,
                turn_count = active.turn_count,
                state = CASE WHEN h.disposition = 'v2_membership_missing' THEN 'ready' ELSE h.state END,
                disposition = CASE WHEN h.disposition = 'v2_membership_missing' THEN NULL ELSE h.disposition END,
                updated_at = now()
           FROM active
          WHERE h.source_id = $1 AND h.session_id = active.session_id
            AND (h.capture_slug_prefix, h.newest_capture_at, h.turn_count, h.state, h.disposition)
              IS DISTINCT FROM (
                active.capture_slug_prefix, active.newest_capture_at, active.turn_count,
                CASE WHEN h.disposition = 'v2_membership_missing' THEN 'ready' ELSE h.state END,
                CASE WHEN h.disposition = 'v2_membership_missing' THEN NULL ELSE h.disposition END
              )`,
        [opts.sourceId],
      );
      await tx.executeRaw(
        `UPDATE context_mirror_reconciliation_heads h
            SET state = 'quarantined', disposition = 'v2_membership_missing', updated_at = now()
          WHERE h.source_id = $1 AND h.disposition IS DISTINCT FROM 'v2_membership_missing'
            AND NOT EXISTS (
              SELECT 1
                FROM context_mirror_capture_membership m
                JOIN pages p ON p.source_id = m.source_id AND p.id = m.page_id
               WHERE m.source_id = h.source_id AND m.session_id = h.session_id
                 AND m.identity_status = 'resolved' AND p.deleted_at IS NULL
            )`,
        [opts.sourceId],
      );
      await tx.executeRaw(
        `INSERT INTO context_mirror_session_heads (
           source_id, session_id, session_slug, capture_slug_prefix,
           newest_capture_at, turn_count, state, disposition
         )
         SELECT source_id, session_id, session_slug, capture_slug_prefix,
                newest_capture_at, turn_count,
                CASE WHEN state = 'quarantined' THEN 'quarantined' ELSE 'pending' END,
                disposition
           FROM context_mirror_reconciliation_heads
          WHERE source_id = $1
            AND ($2::boolean OR session_id = ANY($3::text[]))
         ON CONFLICT (source_id, session_id) DO UPDATE SET
           capture_slug_prefix = EXCLUDED.capture_slug_prefix,
           newest_capture_at = EXCLUDED.newest_capture_at,
           turn_count = EXCLUDED.turn_count,
           state = CASE
             WHEN EXCLUDED.disposition = 'locator_ownership_conflict' THEN 'quarantined'
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined') THEN 'pending'
             ELSE context_mirror_session_heads.state
           END,
           disposition = CASE
             WHEN EXCLUDED.disposition = 'locator_ownership_conflict' THEN EXCLUDED.disposition
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined') THEN NULL
             ELSE context_mirror_session_heads.disposition
           END,
           current_eligible_at = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined') THEN NULL
             ELSE context_mirror_session_heads.current_eligible_at
           END,
           current_cohort_at = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined') THEN NULL
             ELSE context_mirror_session_heads.current_cohort_at
           END,
           current_generation = CASE
             WHEN EXCLUDED.newest_capture_at > context_mirror_session_heads.newest_capture_at
              AND context_mirror_session_heads.state IN ('complete','quarantined')
                THEN context_mirror_session_heads.current_generation + 1
             ELSE context_mirror_session_heads.current_generation
           END,
           claim_id = CASE WHEN EXCLUDED.disposition = 'locator_ownership_conflict' THEN NULL
                           ELSE context_mirror_session_heads.claim_id END,
           lease_expires_at = CASE WHEN EXCLUDED.disposition = 'locator_ownership_conflict' THEN NULL
                                   ELSE context_mirror_session_heads.lease_expires_at END,
           updated_at = now()`,
        [opts.sourceId, initialActivation, sessionIds],
      );
      await tx.executeRaw(
        `UPDATE context_mirror_session_heads h
            SET capture_slug_prefix = shadow.capture_slug_prefix,
                newest_capture_at = shadow.newest_capture_at,
                turn_count = shadow.turn_count,
                state = CASE
                  WHEN shadow.state = 'quarantined' THEN 'quarantined'
                  WHEN h.state IN ('claimed','result_persisted','complete','quarantined') THEN 'pending'
                  ELSE h.state
                END,
                disposition = CASE
                  WHEN shadow.state = 'quarantined' THEN shadow.disposition
                  WHEN h.state IN ('claimed','result_persisted','complete','quarantined') THEN NULL
                  ELSE h.disposition
                END,
                current_generation = CASE
                  WHEN shadow.state <> 'quarantined'
                    AND h.state IN ('claimed','result_persisted','complete','quarantined')
                    THEN h.current_generation + 1
                  ELSE h.current_generation
                END,
                claim_id = NULL, lease_expires_at = NULL,
                current_eligible_at = NULL, current_cohort_at = NULL,
                updated_at = now()
           FROM context_mirror_reconciliation_heads shadow
          WHERE h.source_id = $1 AND shadow.source_id = h.source_id
            AND shadow.session_id = h.session_id
            AND (
              (h.capture_slug_prefix, h.newest_capture_at, h.turn_count)
                IS DISTINCT FROM (
                  shadow.capture_slug_prefix, shadow.newest_capture_at, shadow.turn_count
                )
              OR (
                shadow.state = 'quarantined'
                AND (h.state, h.disposition)
                  IS DISTINCT FROM ('quarantined', shadow.disposition)
              )
              OR (shadow.state <> 'quarantined' AND h.state = 'quarantined')
            )`,
        [opts.sourceId],
      );
      await tx.executeRaw(
        `UPDATE context_mirror_session_heads h
            SET state = 'quarantined', disposition = 'v2_membership_missing',
                claim_id = NULL, lease_expires_at = NULL,
                current_eligible_at = NULL, current_cohort_at = NULL, updated_at = now()
          WHERE h.source_id = $1
            AND NOT EXISTS (
              SELECT 1 FROM context_mirror_reconciliation_heads shadow
               WHERE shadow.source_id = h.source_id AND shadow.session_id = h.session_id
            )`,
        [opts.sourceId],
      );
    }

    const threshold = new Date(opts.now.getTime() - opts.idleHours * 3_600_000).toISOString();
    if (updateLiveHeads) await tx.executeRaw(
      `UPDATE context_mirror_session_heads
          SET first_eligible_at = COALESCE(first_eligible_at, $2::timestamptz),
              cohort_at = COALESCE(cohort_at, $2::timestamptz),
              current_eligible_at = COALESCE(current_eligible_at, $2::timestamptz),
              current_cohort_at = COALESCE(current_cohort_at, $2::timestamptz),
              updated_at = now()
        WHERE source_id = $1 AND state = 'pending'
          AND newest_capture_at <= $3::timestamptz`,
      [opts.sourceId, opts.now.toISOString(), threshold],
    );
    if (updateLiveHeads) await tx.executeRaw(
      `UPDATE context_mirror_session_heads h
          SET state = 'complete', disposition = COALESCE(disposition, 'legacy_marker'), updated_at = now()
        WHERE h.source_id = $1 AND h.state IN ('pending','claimed','result_persisted')
          AND EXISTS (
            SELECT 1 FROM pages p
             WHERE p.source_id = h.source_id AND p.slug = 'distill-state/' || h.session_slug
               AND p.deleted_at IS NULL
               AND NULLIF(p.frontmatter->>'session_id', '') = h.session_id
               AND COALESCE(
                 CASE WHEN COALESCE(p.frontmatter->>'generation', '') ~ '^\\d+$'
                   THEN (p.frontmatter->>'generation')::integer END, 1
               ) = h.current_generation
          )`,
      [opts.sourceId],
    );

    const counts = await reconciliationCounts(tx, opts.sourceId);
    const phase: ReconciliationStateRow['phase'] = counts.ambiguous > 0
      ? 'blocked'
      : reachedUpper ? 'tailing' : 'rebuilding';
    const status: ReconciliationV2Result['status'] = counts.ambiguous > 0
      ? 'blocked'
      : reachedUpper ? 'complete' : 'partial';
    const nextStateRows = await tx.executeRaw<ReconciliationStateRow>(
      `UPDATE context_mirror_reconciliation_state
          SET phase = $4,
              cursor_page_id = $5,
              membership_count = $6,
              ambiguous_count = $7,
              head_count = $8,
              last_complete_at = CASE WHEN $4 = 'tailing' THEN now() ELSE last_complete_at END,
              last_tail_at = CASE WHEN $4 IN ('tailing','blocked') THEN now() ELSE last_tail_at END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = now()
        WHERE source_id = $1 AND lease_owner = $2 AND lease_generation = $3
      RETURNING phase, cursor_page_id, scan_upper_page_id, lease_generation,
                lease_owner, membership_count, ambiguous_count, head_count`,
      [
        opts.sourceId, owner, leaseGeneration, phase, nextCursor,
        counts.membership, counts.ambiguous, counts.heads,
      ],
    );
    const nextState = nextStateRows[0];
    if (!nextState) throw new Error('context mirror reconciliation lease lost');
    await executeRawJsonb(
      tx,
      `INSERT INTO context_mirror_admin_audit (
         source_id, operation, actor, reason, request_fingerprint,
         precondition_fingerprint, outcome, before_counts, after_counts, receipt_ref
       ) VALUES ($1, 'context_mirror_reconcile_v2_batch', $2, $3, $4, $5,
                 $6, $8::jsonb, $9::jsonb, $7)`,
      [
        opts.sourceId,
        actor,
        reason,
        requestFingerprint,
        reconciliationFingerprint({
          cursor_page_id: cursorPageId,
          scan_upper_page_id: upperPageId,
          lease_generation: leaseGeneration,
        }),
        status,
        `reconcile-v2:${leaseGeneration}`,
      ],
      [
        { cursor_page_id: cursorPageId, membership: Number(state.membership_count) },
        {
          cursor_page_id: nextCursor,
          membership: counts.membership,
          ambiguous: counts.ambiguous,
          heads: counts.heads,
          scanned: rows.length,
          inserted_membership: inserted.length,
        },
      ],
    );
    return reconciliationResult(nextState, counts, status, rows.length, inserted.length);
  });
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
  sessionIds?: string[],
): Promise<DurableSessionHead[]> {
  await engine.executeRaw(
    `UPDATE context_mirror_session_heads
        SET state = 'pending', claim_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE source_id = $1 AND state = 'claimed' AND lease_expires_at < $2::timestamptz`,
    [sourceId, now.toISOString()],
  );
  const selector = sessionIds && sessionIds.length > 0
    ? ' AND session_id = ANY($3::text[])'
    : '';
  const params: unknown[] = [sourceId, limit];
  if (selector) params.push(sessionIds);
  const candidates = await engine.executeRaw<{
    session_id: string;
    session_slug: string;
    capture_slug_prefix: string;
    turn_count: number | string;
    newest_capture_at: Date | string;
    current_eligible_at: Date | string;
    current_generation: number | string;
  }>(
    `SELECT session_id, session_slug, capture_slug_prefix, turn_count,
            newest_capture_at, current_eligible_at, current_generation
       FROM context_mirror_session_heads
      WHERE source_id = $1 AND state = 'pending' AND current_eligible_at IS NOT NULL${selector}
      ORDER BY current_eligible_at ASC, session_id ASC
      LIMIT $2`,
    params,
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
      firstEligibleMs: new Date(candidate.current_eligible_at).getTime(),
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
  _errorMessage: string,
): Promise<void> {
  const safeClass = normalizeProviderErrorClass(errorClass);
  await engine.executeRaw(
    `UPDATE context_mirror_provider_calls
        SET state = 'failed', error_class = $2, error_message = $3, updated_at = now()
      WHERE correlation_id = $1 AND state IN ('prepared','inflight')`,
    [correlationId, safeClass, 'provider failure details omitted; reconcile by correlation_id'],
  );
}

const PROVIDER_ERROR_CLASSES = new Set([
  'config',
  'transient',
  'budget',
  'content',
  'validation',
  'unknown',
]);

function normalizeProviderErrorClass(errorClass: string): string {
  return PROVIDER_ERROR_CLASSES.has(errorClass) ? errorClass : 'unknown';
}

/** A provider request left this process without a definitive response after the
 * send boundary. It may have been accepted or billed, so it is never safe to
 * replay automatically. Persist both the call and session stop state in one
 * transaction so a later poll cannot reclaim the session. */
export async function markProviderCallAmbiguous(
  engine: BrainEngine,
  args: { correlationId: string; sourceId: string; sessionId: string; generation: number; errorClass: string; errorMessage: string },
): Promise<void> {
  const safeClass = normalizeProviderErrorClass(args.errorClass);
  await engine.transaction(async (tx) => {
    const updated = await tx.executeRaw<{ one: number }>(
      `UPDATE context_mirror_provider_calls
          SET state = 'ambiguous_provider_outcome', error_class = $2,
              error_message = $3, updated_at = now()
        WHERE correlation_id = $1 AND state = 'inflight'
        RETURNING 1 AS one`,
      [
        args.correlationId,
        safeClass,
        'provider outcome ambiguous; details omitted; reconcile by correlation_id',
      ],
    );
    if (!updated[0]) {
      throw new Error('provider call is no longer inflight; ambiguous outcome was not recorded');
    }
    await tx.executeRaw(
      `UPDATE context_mirror_session_heads
          SET state = 'ambiguous', disposition = 'ambiguous_provider_outcome',
              claim_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND current_generation = $3`,
      [args.sourceId, args.sessionId, args.generation],
    );
  });
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

/** Create the current generation before any provider send. A changed input hash
 * can never be smuggled into the same generation identity. */
export async function ensureContextGeneration(
  engine: BrainEngine,
  input: ContextGenerationInput,
): Promise<void> {
  await engine.transaction(async (tx) => {
    const existing = await tx.executeRaw<{ input_hash: string }>(
      `SELECT input_hash FROM context_mirror_generations
        WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
      [input.sourceId, input.sessionId, input.generation],
    );
    if (existing[0] && existing[0].input_hash !== input.inputHash) {
      throw new Error('context mirror generation input hash changed without a generation increment');
    }
    await tx.executeRaw(
      `UPDATE context_mirror_generations
          SET is_current = false,
              state = CASE WHEN state = 'complete' THEN 'superseded' ELSE state END,
              superseded_at = COALESCE(superseded_at, now()), updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation <> $3 AND is_current`,
      [input.sourceId, input.sessionId, input.generation],
    );
    await tx.executeRaw(
      `UPDATE context_mirror_partitions
          SET state = 'superseded', claim_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation <> $3
          AND state IN ('pending','claimed','failed')`,
      [input.sourceId, input.sessionId, input.generation],
    );
    await tx.executeRaw(
      `UPDATE context_mirror_review_reservations
          SET state = 'released', updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation <> $3 AND state = 'active'`,
      [input.sourceId, input.sessionId, input.generation],
    );
    await tx.executeRaw(
      `INSERT INTO context_mirror_generations (
         source_id, session_id, generation, input_hash, originator, runtime,
         transform_version, model, state, is_current, requires_human_review
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'building',true,$9)
       ON CONFLICT (source_id, session_id, generation) DO UPDATE SET
         originator = COALESCE(EXCLUDED.originator, context_mirror_generations.originator),
         runtime = COALESCE(EXCLUDED.runtime, context_mirror_generations.runtime),
         transform_version = EXCLUDED.transform_version,
         model = EXCLUDED.model,
         is_current = true,
         requires_human_review = context_mirror_generations.requires_human_review OR EXCLUDED.requires_human_review,
         updated_at = now()`,
      [
        input.sourceId, input.sessionId, input.generation, input.inputHash,
        input.originator, input.runtime, input.transformVersion, input.model,
        input.requiresHumanReview ?? false,
      ],
    );
  });
}

/** Verify the materialized page/chunk manifest, then make the generation visible
 * to consolidation and seed one durable partition row per memory. */
export async function completeContextGeneration(
  engine: BrainEngine,
  input: ContextGenerationInput & { partitions: ContextGenerationPartition[] },
): Promise<void> {
  await engine.transaction(async (tx) => {
    const verified = input.partitions.length === 0
      ? 0
      : Number((await tx.executeRaw<{ count: number | string }>(
          `SELECT count(DISTINCT p.slug) AS count
             FROM pages p
             JOIN content_chunks c ON c.page_id = p.id
            WHERE p.source_id = $1 AND p.deleted_at IS NULL
              AND p.slug = ANY($2::text[])`,
          [input.sourceId, input.partitions.map((part) => part.distilledSlug)],
        ))[0]?.count ?? 0);
    if (verified !== input.partitions.length) {
      throw new Error(`context mirror generation manifest incomplete: ${verified}/${input.partitions.length} pages chunked`);
    }
    const generationRows = await tx.executeRaw<{ input_hash: string }>(
      `SELECT input_hash FROM context_mirror_generations
        WHERE source_id = $1 AND session_id = $2 AND generation = $3 FOR UPDATE`,
      [input.sourceId, input.sessionId, input.generation],
    );
    if (!generationRows[0] || generationRows[0].input_hash !== input.inputHash) {
      throw new Error('context mirror generation is missing or its input hash no longer matches');
    }
    for (const part of input.partitions) {
      const existing = await tx.executeRaw<{ content_hash: string }>(
        `SELECT content_hash FROM context_mirror_partitions
          WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND partition_key = $4`,
        [input.sourceId, input.sessionId, input.generation, part.partitionKey],
      );
      if (existing[0] && existing[0].content_hash !== part.contentHash) {
        throw new Error(`context mirror partition ${part.partitionKey} changed inside one generation`);
      }
      await tx.executeRaw(
        `INSERT INTO context_mirror_partitions (
           source_id, session_id, generation, partition_key, distilled_slug, content_hash
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (source_id, session_id, generation, partition_key) DO NOTHING`,
        [input.sourceId, input.sessionId, input.generation, part.partitionKey, part.distilledSlug, part.contentHash],
      );
    }
    const manifest = input.partitions.map((part) => ({
      partition: part.partitionKey,
      slug: part.distilledSlug,
      content_hash: part.contentHash,
    }));
    await tx.executeRaw(
      `UPDATE context_mirror_generations
          SET expected_manifest = $4::jsonb,
              expected_partitions = $5,
              materialized_partitions = $5,
              state = 'complete', is_current = true,
              completed_at = COALESCE(completed_at, now()), updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
      [input.sourceId, input.sessionId, input.generation, JSON.stringify(manifest), input.partitions.length],
    );
    // The moment a replacement generation is complete, an older unresolved
    // review candidate is no longer safe to approve. Reject it immediately;
    // the first candidate from this generation later fills superseded_by in the
    // same candidate+decision transaction. Accepted/indexed history is immutable.
    await tx.executeRaw(
      `UPDATE connector_candidates
          SET status = 'rejected', status_reason = 'superseded_generation_pending_replacement',
              acted_at = COALESCE(acted_at, now())
        WHERE source_id = $1 AND context_session_id = $2
          AND context_generation < $3
          AND status IN ('pending','needs_review','awaiting_review_capacity')`,
      [input.sourceId, input.sessionId, input.generation],
    );
  });
}

export async function markContextGenerationQuarantined(
  engine: BrainEngine,
  sourceId: string,
  sessionId: string,
  generation: number,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_generations
        SET state = 'quarantined', updated_at = now()
      WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
    [sourceId, sessionId, generation],
  );
}

/** Restore the immediately prior verified generation while preserving all raw,
 * distilled, provider, candidate, and decision evidence. This is deliberately
 * narrower than a generic generation switch: only a current human-review-only
 * correction may roll back, and accepted/promoted or ambiguous provider work
 * blocks the operation. */
export async function rollbackContextGeneration(
  engine: BrainEngine,
  input: {
    sourceId: string;
    sessionId: string;
    generation: number;
    rollbackGeneration: number;
    actor?: string;
    reason?: string;
  },
): Promise<ContextGenerationRollbackReport> {
  if (!Number.isInteger(input.generation) || input.generation <= 1) {
    throw new Error('rollback generation must be greater than one');
  }
  if (!Number.isInteger(input.rollbackGeneration)
      || input.rollbackGeneration !== input.generation - 1) {
    throw new Error('rollback target must be the immediately prior generation');
  }
  const actor = (input.actor ?? 'system').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 120) || 'system';
  const reason = (input.reason ?? 'legacy_operator_request').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 240);
  if (!reason) throw new Error('generation rollback requires a reason');
  return await engine.transaction(async (tx) => {
    await tx.executeRaw(`SELECT id FROM sources WHERE id = $1 FOR UPDATE`, [input.sourceId]);
    const heads = await tx.executeRaw<{ current_generation: number | string }>(
      `SELECT current_generation FROM context_mirror_session_heads
        WHERE source_id = $1 AND session_id = $2 FOR UPDATE`,
      [input.sourceId, input.sessionId],
    );
    if (!heads[0]) {
      throw new Error('rollback source generation is not the current session head');
    }
    if (Number(heads[0].current_generation) === input.rollbackGeneration) {
      const prior = await tx.executeRaw<{
        state: string;
        rollback_actor: string | null;
        rollback_reason: string | null;
        rollback_rejected_candidates: number | string | null;
        rolled_back_at: Date | string | null;
      }>(
        `SELECT state, rollback_actor, rollback_reason, rollback_rejected_candidates, rolled_back_at
           FROM context_mirror_generations
          WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
        [input.sourceId, input.sessionId, input.generation],
      );
      const already = prior[0];
      if (already?.state === 'superseded'
          && already.rollback_actor === actor
          && already.rollback_reason === reason
          && already.rolled_back_at) {
        const rolledBackAt = new Date(already.rolled_back_at).toISOString();
        return {
          status: 'already_rolled_back',
          source_id: input.sourceId,
          session_id: input.sessionId,
          generation: input.generation,
          rollback_generation: input.rollbackGeneration,
          rejected_candidates: Number(already.rollback_rejected_candidates ?? 0),
          actor,
          reason,
          rolled_back_at: rolledBackAt,
          verification: {
            current_generation: input.rollbackGeneration,
            rolled_back_generation_state: 'superseded',
            restored_generation_state: 'complete',
          },
        };
      }
      throw new Error('rollback source generation is not the current session head');
    }
    if (Number(heads[0].current_generation) !== input.generation) {
      throw new Error('rollback source generation is not the current session head');
    }
    const generations = await tx.executeRaw<{
      generation: number | string;
      state: string;
      is_current: boolean;
      requires_human_review: boolean;
    }>(
      `SELECT generation,state,is_current,requires_human_review
         FROM context_mirror_generations
        WHERE source_id = $1 AND session_id = $2 AND generation IN ($3,$4)
        ORDER BY generation FOR UPDATE`,
      [input.sourceId, input.sessionId, input.rollbackGeneration, input.generation],
    );
    const previous = generations.find((row) => Number(row.generation) === input.rollbackGeneration);
    const current = generations.find((row) => Number(row.generation) === input.generation);
    if (!previous || !current || !current.is_current) {
      throw new Error('rollback generations are missing or current pointer is inconsistent');
    }
    if (!current.requires_human_review) {
      throw new Error('ordinary generation rollback is forbidden');
    }
    if (!['complete', 'quarantined', 'building'].includes(current.state)) {
      throw new Error(`generation state ${current.state} cannot be rolled back safely`);
    }
    if (!['complete', 'superseded'].includes(previous.state)) {
      throw new Error('rollback target is not a previously completed generation');
    }
    const [unsafeProvider] = await tx.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM context_mirror_provider_calls
        WHERE source_id = $1 AND session_id = $2 AND generation = $3
          AND state IN ('prepared','inflight','ambiguous_provider_outcome')`,
      [input.sourceId, input.sessionId, input.generation],
    );
    if (Number(unsafeProvider?.count ?? 0) > 0) {
      throw new Error('generation has ambiguous or in-flight provider work');
    }
    const [unsafeCandidate] = await tx.executeRaw<{ count: number | string }>(
      `SELECT count(*) AS count FROM connector_candidates
        WHERE source_id = $1 AND context_session_id = $2 AND context_generation = $3
          AND (status = 'accepted' OR promotion_status IS NOT NULL)`,
      [input.sourceId, input.sessionId, input.generation],
    );
    if (Number(unsafeCandidate?.count ?? 0) > 0) {
      throw new Error('generation has accepted or promoted candidate evidence');
    }
    await tx.executeRaw(
      `UPDATE context_mirror_generations
          SET is_current = false, state = 'superseded',
              superseded_at = COALESCE(superseded_at, now()), updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
      [input.sourceId, input.sessionId, input.generation],
    );
    await tx.executeRaw(
      `UPDATE context_mirror_generations
          SET is_current = true, state = 'complete', updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
      [input.sourceId, input.sessionId, input.rollbackGeneration],
    );
    await tx.executeRaw(
      `UPDATE context_mirror_partitions
          SET state = 'superseded', claim_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3
          AND state <> 'superseded'`,
      [input.sourceId, input.sessionId, input.generation],
    );
    const rejected = await tx.executeRaw<{ one: number }>(
      `UPDATE connector_candidates
          SET status = 'rejected', status_reason = 'historical_generation_rolled_back',
              acted_by = COALESCE(acted_by, $4), acted_at = COALESCE(acted_at, now())
        WHERE source_id = $1 AND context_session_id = $2 AND context_generation = $3
          AND status IN ('pending','needs_review','awaiting_review_capacity')
        RETURNING 1 AS one`,
      [input.sourceId, input.sessionId, input.generation, actor],
    );
    const audit = await tx.executeRaw<{ rolled_back_at: Date | string }>(
      `UPDATE context_mirror_generations
          SET rollback_actor = $4, rollback_reason = $5,
              rollback_rejected_candidates = $6, rolled_back_at = now(), updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3
        RETURNING rolled_back_at`,
      [input.sourceId, input.sessionId, input.generation, actor, reason, rejected.length],
    );
    await tx.executeRaw(
      `UPDATE context_mirror_review_reservations
          SET state = 'released', updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND state = 'active'`,
      [input.sourceId, input.sessionId, input.generation],
    );
    await tx.executeRaw(
      `UPDATE context_mirror_session_heads
          SET current_generation = $3, state = 'complete', disposition = 'generation_rollback',
              claim_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE source_id = $1 AND session_id = $2`,
      [input.sourceId, input.sessionId, input.rollbackGeneration],
    );
    const verified = await tx.executeRaw<{
      current_generation: number | string;
      rolled_back_state: string;
      restored_state: string;
    }>(
      `SELECT h.current_generation,
              rolled.state AS rolled_back_state,
              restored.state AS restored_state
         FROM context_mirror_session_heads h
         JOIN context_mirror_generations rolled
           ON rolled.source_id = h.source_id AND rolled.session_id = h.session_id
          AND rolled.generation = $3
         JOIN context_mirror_generations restored
           ON restored.source_id = h.source_id AND restored.session_id = h.session_id
          AND restored.generation = $4
        WHERE h.source_id = $1 AND h.session_id = $2`,
      [input.sourceId, input.sessionId, input.generation, input.rollbackGeneration],
    );
    const proof = verified[0];
    if (!proof
        || Number(proof.current_generation) !== input.rollbackGeneration
        || proof.rolled_back_state !== 'superseded'
        || proof.restored_state !== 'complete'
        || !audit[0]?.rolled_back_at) {
      throw new Error('generation rollback durable verification failed');
    }
    return {
      status: 'rolled_back',
      source_id: input.sourceId,
      session_id: input.sessionId,
      generation: input.generation,
      rollback_generation: input.rollbackGeneration,
      rejected_candidates: rejected.length,
      actor,
      reason,
      rolled_back_at: new Date(audit[0].rolled_back_at).toISOString(),
      verification: {
        current_generation: Number(proof.current_generation),
        rolled_back_generation_state: 'superseded',
        restored_generation_state: 'complete',
      },
    };
  });
}

/** Source-serialized capacity reservation. Provider work may start only after
 * its worst-case six-output footprint fits the human+staging envelope. */
export async function reserveReviewCapacity(
  engine: BrainEngine,
  input: { sourceId: string; sessionId: string; generation: number; slots: number; bytes: number; now: Date; cohortKind?: 'fresh' | 'historical' },
): Promise<string | null> {
  if (!Number.isInteger(input.slots) || input.slots < 1 || !Number.isInteger(input.bytes) || input.bytes < 1) {
    throw new Error('context mirror review reservation must use positive finite slots and bytes');
  }
  return await engine.transaction(async (tx) => {
    await tx.executeRaw(`SELECT id FROM sources WHERE id = $1 FOR UPDATE`, [input.sourceId]);
    await tx.executeRaw(
      `UPDATE context_mirror_review_reservations
          SET state = 'expired', updated_at = now()
        WHERE source_id = $1 AND state = 'active' AND expires_at <= $2::timestamptz`,
      [input.sourceId, input.now.toISOString()],
    );
    const existing = await tx.executeRaw<{ reservation_id: string; state: string }>(
      `SELECT reservation_id, state FROM context_mirror_review_reservations
        WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
      [input.sourceId, input.sessionId, input.generation],
    );
    if (existing[0]?.state === 'active') return existing[0].reservation_id;
    const snapshot = await reviewCapacitySnapshot(tx, input.sourceId);
    if (snapshot.humanAgeExceeded || snapshot.stagingAgeExceeded) return null;
    const occupiedSlots = snapshot.humanPending + snapshot.staged + snapshot.reservedSlots;
    const slotsLimit = snapshot.pendingLimit + snapshot.stagingLimit;
    if (occupiedSlots + input.slots > slotsLimit) return null;
    if (input.cohortKind === 'historical') {
      const historicalOccupied = snapshot.historicalHuman + snapshot.historicalStaged +
        snapshot.historicalReservedSlots;
      if (historicalOccupied + input.slots > Math.max(0, slotsLimit - snapshot.freshQuota)) return null;
    }
    if (snapshot.stagedBytes + snapshot.reservedBytes + input.bytes > snapshot.stagingBytesLimit) return null;
    const reservationId = existing[0]?.reservation_id ?? randomUUID();
    if (existing[0]) {
      await tx.executeRaw(
        `UPDATE context_mirror_review_reservations
            SET cohort_kind = $4, reserved_slots = $5, reserved_bytes = $6,
                state = 'active', expires_at = $7::timestamptz, updated_at = now()
          WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
        [
          input.sourceId, input.sessionId, input.generation, input.cohortKind ?? 'fresh',
          input.slots, input.bytes,
          new Date(input.now.getTime() + REVIEW_RESERVATION_MS).toISOString(),
        ],
      );
    } else {
      await tx.executeRaw(
        `INSERT INTO context_mirror_review_reservations (
           reservation_id, source_id, session_id, generation, cohort_kind,
           reserved_slots, reserved_bytes, state, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8::timestamptz)`,
        [
          reservationId, input.sourceId, input.sessionId, input.generation,
          input.cohortKind ?? 'fresh', input.slots, input.bytes,
          new Date(input.now.getTime() + REVIEW_RESERVATION_MS).toISOString(),
        ],
      );
    }
    return reservationId;
  });
}

export async function releaseReviewReservation(
  engine: BrainEngine,
  sourceId: string,
  sessionId: string,
  generation: number,
  state: 'consumed' | 'released' = 'consumed',
): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_review_reservations
        SET state = $4, updated_at = now()
      WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND state = 'active'`,
    [sourceId, sessionId, generation, state],
  );
}

/** Replace a pre-provider worst-case reservation with the exact number of
 * materialized memory partitions. The per-partition byte bound remains
 * conservative until each partition reaches a terminal decision. */
export async function resizeReviewReservation(
  engine: BrainEngine,
  sourceId: string,
  sessionId: string,
  generation: number,
  slots: number,
  bytesPerSlot: number,
): Promise<void> {
  if (!Number.isInteger(slots) || slots < 0 || !Number.isInteger(bytesPerSlot) || bytesPerSlot < 1) {
    throw new Error('context mirror reservation resize requires finite non-negative slots and positive bytes');
  }
  await engine.executeRaw(
    `UPDATE context_mirror_review_reservations
        SET reserved_slots = $4,
            reserved_bytes = $4::integer * $5::bigint,
            state = CASE WHEN $4 = 0 THEN 'consumed' ELSE 'active' END,
            updated_at = now()
      WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND state = 'active'`,
    [sourceId, sessionId, generation, slots, bytesPerSlot],
  );
}

export async function reviewCapacitySnapshot(
  engine: BrainEngine,
  sourceId: string,
): Promise<ReviewCapacitySnapshot> {
  const sourceRows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1`,
    [sourceId],
  );
  const root = parseJsonObject(sourceRows[0]?.config);
  const connectors = parseJsonObject(root.connectors);
  const config = parseJsonObject(connectors.context_mirror);
  const pendingLimit = boundedConfigInt(config.pending_review_limit, DEFAULT_PENDING_REVIEW_LIMIT, 0, 25);
  const stagingLimit = boundedConfigInt(config.staging_review_limit, DEFAULT_STAGING_LIMIT, 0, 50);
  const stagingBytesLimit = boundedConfigInt(config.staging_review_bytes, DEFAULT_STAGING_BYTES, 1, DEFAULT_STAGING_BYTES);
  const humanMaxAgeHours = boundedConfigInt(
    config.pending_review_max_age_hours,
    DEFAULT_REVIEW_MAX_AGE_HOURS,
    1,
    30 * 24,
  );
  const stagingMaxAgeHours = boundedConfigInt(
    config.staging_review_max_age_hours,
    DEFAULT_REVIEW_MAX_AGE_HOURS,
    1,
    30 * 24,
  );
  const rows = await engine.executeRaw<{
    human_pending: number | string;
    human_bytes: number | string;
    staged: number | string;
    staged_bytes: number | string;
    reserved_slots: number | string;
    reserved_bytes: number | string;
    human_oldest_at: Date | string | null;
    staged_oldest_at: Date | string | null;
    historical_human: number | string;
    historical_staged: number | string;
    historical_reserved_slots: number | string;
  }>(
    `SELECT
       (SELECT count(*) FROM connector_candidates
         WHERE source_id = $1 AND status IN ('pending','needs_review')) AS human_pending,
       (SELECT COALESCE(sum(octet_length(COALESCE(proposed_markdown,''))),0) FROM connector_candidates
         WHERE source_id = $1 AND status IN ('pending','needs_review')) AS human_bytes,
       (SELECT count(*) FROM connector_candidates
         WHERE source_id = $1 AND status = 'awaiting_review_capacity') AS staged,
       (SELECT COALESCE(sum(octet_length(COALESCE(proposed_markdown,''))),0) FROM connector_candidates
         WHERE source_id = $1 AND status = 'awaiting_review_capacity') AS staged_bytes,
       (SELECT COALESCE(sum(reserved_slots),0) FROM context_mirror_review_reservations
         WHERE source_id = $1 AND state = 'active' AND expires_at > now()) AS reserved_slots,
       (SELECT COALESCE(sum(reserved_bytes),0) FROM context_mirror_review_reservations
         WHERE source_id = $1 AND state = 'active' AND expires_at > now()) AS reserved_bytes,
       (SELECT min(proposed_at) FROM connector_candidates
         WHERE source_id = $1 AND status IN ('pending','needs_review')) AS human_oldest_at,
       (SELECT min(proposed_at) FROM connector_candidates
         WHERE source_id = $1 AND status = 'awaiting_review_capacity') AS staged_oldest_at,
       (SELECT count(*) FROM connector_candidates
         WHERE source_id = $1 AND status IN ('pending','needs_review') AND requires_human_review) AS historical_human,
       (SELECT count(*) FROM connector_candidates
         WHERE source_id = $1 AND status = 'awaiting_review_capacity' AND requires_human_review) AS historical_staged,
       (SELECT COALESCE(sum(reserved_slots),0) FROM context_mirror_review_reservations
         WHERE source_id = $1 AND state = 'active' AND expires_at > now()
           AND cohort_kind = 'historical') AS historical_reserved_slots`,
    [sourceId],
  );
  const row = rows[0];
  const humanOldestAt = row?.human_oldest_at ? new Date(row.human_oldest_at) : null;
  const stagedOldestAt = row?.staged_oldest_at ? new Date(row.staged_oldest_at) : null;
  const nowMs = Date.now();
  return {
    pendingLimit,
    stagingLimit,
    stagingBytesLimit,
    humanPending: Number(row?.human_pending ?? 0),
    humanBytes: Number(row?.human_bytes ?? 0),
    staged: Number(row?.staged ?? 0),
    stagedBytes: Number(row?.staged_bytes ?? 0),
    reservedSlots: Number(row?.reserved_slots ?? 0),
    reservedBytes: Number(row?.reserved_bytes ?? 0),
    freshQuota: pendingLimit === 0 ? 0 : Math.min(pendingLimit, Math.max(1, Math.ceil(0.2 * pendingLimit))),
    humanOldestAt,
    stagedOldestAt,
    humanMaxAgeHours,
    stagingMaxAgeHours,
    humanAgeExceeded: humanOldestAt != null && nowMs - humanOldestAt.getTime() > humanMaxAgeHours * 3_600_000,
    stagingAgeExceeded: stagedOldestAt != null && nowMs - stagedOldestAt.getTime() > stagingMaxAgeHours * 3_600_000,
    historicalHuman: Number(row?.historical_human ?? 0),
    historicalStaged: Number(row?.historical_staged ?? 0),
    historicalReservedSlots: Number(row?.historical_reserved_slots ?? 0),
  };
}

export async function chooseReviewAdmissionStatus(
  engine: BrainEngine,
  sourceId: string,
  preferred: 'pending' | 'needs_review',
  candidateBytes: number,
  historical: boolean,
): Promise<'pending' | 'needs_review' | 'awaiting_review_capacity'> {
  if (!Number.isInteger(candidateBytes) || candidateBytes < 0) {
    throw new Error('context mirror candidate bytes must be a finite non-negative integer');
  }
  await engine.executeRaw(`SELECT id FROM sources WHERE id = $1 FOR UPDATE`, [sourceId]);
  const snapshot = await reviewCapacitySnapshot(engine, sourceId);
  if (snapshot.humanAgeExceeded || snapshot.stagingAgeExceeded) {
    throw new Error('context mirror review capacity age limit exceeded');
  }
  const historicalHumanLimit = Math.max(0, snapshot.pendingLimit - snapshot.freshQuota);
  if (
    snapshot.humanPending < snapshot.pendingLimit &&
    (!historical || snapshot.historicalHuman < historicalHumanLimit)
  ) return preferred;
  if (
    snapshot.staged < snapshot.stagingLimit &&
    snapshot.stagedBytes + candidateBytes <= snapshot.stagingBytesLimit
  ) {
    return 'awaiting_review_capacity';
  }
  throw new Error('context mirror review capacity exhausted after reservation');
}

/** Move staged candidates into the human queue in stable oldest-first order.
 * Source locking makes concurrent admissions conserve the configured WIP cap. */
export async function admitWaitingCandidates(engine: BrainEngine, sourceId: string): Promise<number> {
  return await engine.transaction(async (tx) => {
    await tx.executeRaw(`SELECT id FROM sources WHERE id = $1 FOR UPDATE`, [sourceId]);
    const snapshot = await reviewCapacitySnapshot(tx, sourceId);
    const available = Math.max(0, snapshot.pendingLimit - snapshot.humanPending);
    if (available === 0) return 0;
    const rows = await tx.executeRaw<{ id: number | string }>(
      `WITH next AS (
         SELECT id
           FROM connector_candidates
          WHERE source_id = $1 AND status = 'awaiting_review_capacity'
          ORDER BY proposed_at ASC, id ASC
          LIMIT $2
          FOR UPDATE
       )
       UPDATE connector_candidates c
          SET status = CASE WHEN c.classification = 'NEEDS_REVIEW' THEN 'needs_review' ELSE 'pending' END,
              status_reason = NULL
         FROM next
        WHERE c.id = next.id
       RETURNING c.id`,
      [sourceId, available],
    );
    return rows.length;
  });
}

export async function claimContextPartitions(
  engine: BrainEngine,
  sourceId: string,
  limit: number,
  now: Date,
  selector?: { sessionId: string; generation: number },
): Promise<ClaimedContextPartition[]> {
  await engine.executeRaw(
    `UPDATE context_mirror_partitions
        SET state = 'pending', claim_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE source_id = $1 AND state = 'claimed' AND lease_expires_at < $2::timestamptz`,
    [sourceId, now.toISOString()],
  );
  const selectorSql = selector
    ? ' AND p.session_id = $3 AND p.generation = $4'
    : '';
  const params: unknown[] = [sourceId, limit];
  if (selector) params.push(selector.sessionId, selector.generation);
  const candidates = await engine.executeRaw<{
    session_id: string; generation: number | string; partition_key: string;
    distilled_slug: string; content_hash: string; requires_human_review: boolean;
  }>(
    `SELECT p.session_id, p.generation, p.partition_key, p.distilled_slug,
            p.content_hash, g.requires_human_review
       FROM context_mirror_partitions p
       JOIN context_mirror_generations g
         ON g.source_id = p.source_id AND g.session_id = p.session_id AND g.generation = p.generation
      WHERE p.source_id = $1 AND p.state IN ('pending','failed')
        AND g.is_current AND g.state = 'complete'
        ${selectorSql}
      ORDER BY g.completed_at ASC, p.session_id ASC, p.generation ASC, p.partition_key ASC
      LIMIT $2`,
    params,
  );
  const claimed: ClaimedContextPartition[] = [];
  for (const candidate of candidates) {
    const claimId = randomUUID();
    const rows = await engine.executeRaw<{ one: number }>(
      `UPDATE context_mirror_partitions
          SET state = 'claimed', claim_id = $5, lease_expires_at = $6::timestamptz,
              attempt_count = attempt_count + 1, updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND partition_key = $4
          AND state IN ('pending','failed')
        RETURNING 1 AS one`,
      [
        sourceId, candidate.session_id, Number(candidate.generation), candidate.partition_key,
        claimId, new Date(now.getTime() + PARTITION_LEASE_MS).toISOString(),
      ],
    );
    if (!rows[0]) continue;
    claimed.push({
      sourceId,
      sessionId: candidate.session_id,
      generation: Number(candidate.generation),
      partitionKey: candidate.partition_key,
      distilledSlug: candidate.distilled_slug,
      contentHash: candidate.content_hash,
      claimId,
      requiresHumanReview: candidate.requires_human_review,
    });
  }
  return claimed;
}

export async function finishContextPartition(
  engine: BrainEngine,
  input: ClaimedContextPartition & {
    state: 'decided' | 'degraded' | 'failed';
    candidateId?: number | null;
    classification?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<boolean> {
  return await engine.transaction(async (tx) => {
    const rows = await tx.executeRaw<{ one: number }>(
      `UPDATE context_mirror_partitions
          SET state = $6, candidate_id = $7, decision_classification = $8,
              last_error_code = $9, last_error_message = $10,
              decided_at = CASE WHEN $6 IN ('decided','degraded') THEN now() ELSE decided_at END,
              claim_id = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND partition_key = $4
          AND claim_id = $5 AND state = 'claimed'
        RETURNING 1 AS one`,
      [
        input.sourceId, input.sessionId, input.generation, input.partitionKey, input.claimId,
        input.state, input.candidateId ?? null, input.classification ?? null,
        input.errorCode ?? null, input.errorMessage?.slice(0, 500) ?? null,
      ],
    );
    if (!rows[0]) return false;
    if (input.state === 'decided' || input.state === 'degraded') {
      await tx.executeRaw(
        `UPDATE context_mirror_review_reservations
            SET reserved_bytes = CASE
                  WHEN reserved_slots <= 1 THEN 0
                  ELSE greatest(0, reserved_bytes - ceil(reserved_bytes::numeric / reserved_slots)::bigint)
                END,
                reserved_slots = greatest(0, reserved_slots - 1),
                state = CASE WHEN reserved_slots <= 1 THEN 'consumed' ELSE state END,
                updated_at = now()
          WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND state = 'active'`,
        [input.sourceId, input.sessionId, input.generation],
      );
    }
    return true;
  });
}

export async function releaseContextPartition(engine: BrainEngine, input: ClaimedContextPartition): Promise<void> {
  await engine.executeRaw(
    `UPDATE context_mirror_partitions
        SET state = 'pending', claim_id = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE source_id = $1 AND session_id = $2 AND generation = $3 AND partition_key = $4
        AND claim_id = $5 AND state = 'claimed'`,
    [input.sourceId, input.sessionId, input.generation, input.partitionKey, input.claimId],
  );
}

export async function releaseReservationWhenGenerationResolved(
  engine: BrainEngine,
  sourceId: string,
  sessionId: string,
  generation: number,
): Promise<void> {
  const rows = await engine.executeRaw<{ unresolved: number | string }>(
    `SELECT count(*) FILTER (WHERE state IN ('pending','claimed','failed')) AS unresolved
       FROM context_mirror_partitions
      WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
    [sourceId, sessionId, generation],
  );
  if (Number(rows[0]?.unresolved ?? 0) === 0) {
    await releaseReviewReservation(engine, sourceId, sessionId, generation, 'consumed');
  }
}

function boundedConfigInt(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}
