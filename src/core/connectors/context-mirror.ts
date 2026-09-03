/**
 * context-mirror.ts — the Context Mirror SaaSConnector.
 *
 * POLL-ONLY, INTERNAL. This connector has no external API and no webhook: it feeds the
 * Brain's OWN `capture-events` source pages back into the Memory Consolidation pipeline.
 * The periodic poll job (poll.ts) drives backfill() on a schedule; there is no inbound
 * trigger, no auth, and no custody registration. verifyWebhook always fails closed and
 * accountFromPayload returns null (the generic /webhooks/:provider receiver must never
 * drive this connector) — exactly like the Granola connector it mirrors.
 *
 * ── What it reads, what it lands ─────────────────────────────────────────────────────
 *
 * Raw `capture/` pages are evidence only. The bounded distiller materializes a
 * source-scoped, chunk-verified generation under `distilled/`; one durable partition
 * ledger row then owns each distilled memory until candidate + decision persistence is
 * complete. Raw captures and unverified legacy pages never enter the review queue.
 *
 * ── Consolidation (default OFF) ──────────────────────────────────────────────────────
 *
 * When config.connectors.context_mirror.consolidation_enabled is true, claimed current
 * generation partitions run through landRecords(..., { consolidate: true }). Candidate
 * and decision persistence is transactional. When the flag is false, actionable
 * partitions remain pending and isolated so a later enable can process them; disabling
 * consolidation can never turn unfinished work into a terminal success.
 *
 * ── Incremental cursor ───────────────────────────────────────────────────────────────
 *
 * Current work is driven by the generation and partition ledgers, not a timestamp
 * watermark. A separate composite `(updated_at, slug)` checkpoint inventories pre-ledger
 * `distilled/` pages as unverified legacy evidence. The old watermark path remains only
 * for lightweight engines that cannot host the operational tables.
 */

import {
  registerConnector,
  type SaaSConnector,
  type NormalizedRecord,
  type ConnectorSource,
  type ConnectorBackfillResult,
  type ConnectorDiagnostic,
} from './base.ts';
import type { ConnectorCandidateItem } from './candidate.ts';
import type { BrainEngine } from '../engine.ts';
import type { Page } from '../types.ts';
import { computeContentHash } from '../ingestion/types.ts';
import { withBudgetTracker } from '../ai/gateway.ts';
import { BudgetTracker } from '../budget/budget-tracker.ts';
import {
  admitWaitingCandidates,
  claimContextPartitions,
  finishContextPartition,
  releaseContextPartition,
  releaseReservationWhenGenerationResolved,
  supportsContextMirrorOperationalState,
  type ClaimedContextPartition,
} from './context-mirror-state.ts';

// ── Constants ────────────────────────────────────────────────────────────────────

const PROVIDER = 'context_mirror';
/** Poll-only: no inbound webhook. A sentinel header so the SaaSConnector shape is satisfied;
 *  the generic receiver never drives this connector (verifyWebhook fails closed). */
export const CONTEXT_MIRROR_SIGNATURE_HEADER = 'x-context-mirror-unused';
const CONSOLIDATION_CHECKPOINT = 'distilled_legacy_import_v1';
const CONSOLIDATION_BATCH_SIZE = 100;

export interface ContextMirrorCursor {
  updatedAt: string;
  slug: string;
}

function parseCursor(value: unknown, legacyTimestamp: string | null): ContextMirrorCursor {
  let row: Record<string, unknown> | null = null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      row = asRecord(parsed);
    } catch {
      row = null;
    }
  } else {
    row = asRecord(value);
  }
  const updatedAt = str(row?.updated_at) ?? legacyTimestamp ?? '1970-01-01T00:00:00.000Z';
  return { updatedAt: new Date(updatedAt).toISOString(), slug: str(row?.slug) ?? '' };
}

async function readOperationalCursor(
  engine: BrainEngine,
  source: ConnectorSource,
): Promise<ContextMirrorCursor> {
  const rows = await engine.executeRaw<{ cursor: unknown }>(
    `SELECT cursor FROM context_mirror_checkpoints
      WHERE source_id = $1 AND checkpoint_kind = $2`,
    [source.id, CONSOLIDATION_CHECKPOINT],
  );
  return parseCursor(rows[0]?.cursor, readWatermark(source));
}

async function listPageBatchAfterCursor(
  engine: BrainEngine,
  sourceId: string,
  cursor: ContextMirrorCursor,
  slugPrefix: string | undefined,
): Promise<Page[]> {
  return await engine.executeRaw<Page>(
    `SELECT id, source_id, slug, type, page_kind, title, compiled_truth, timeline,
            frontmatter, content_hash, created_at, updated_at, deleted_at
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND ($4::text IS NULL OR slug LIKE $4::text || '%')
        AND (updated_at > $2::timestamptz OR (updated_at = $2::timestamptz AND slug > $3))
      ORDER BY updated_at ASC, slug ASC
      LIMIT $5`,
    [sourceId, cursor.updatedAt, cursor.slug, slugPrefix ?? null, CONSOLIDATION_BATCH_SIZE],
  );
}

async function writeOperationalCursor(
  engine: BrainEngine,
  sourceId: string,
  cursor: ContextMirrorCursor,
  complete: boolean,
): Promise<void> {
  await engine.transaction(async (tx) => {
    await tx.executeRaw(
      `INSERT INTO context_mirror_checkpoints (
         source_id, checkpoint_kind, cursor, completed, updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, now())
       ON CONFLICT (source_id, checkpoint_kind) DO UPDATE SET
         cursor = EXCLUDED.cursor, completed = EXCLUDED.completed, updated_at = now()`,
      [sourceId, CONSOLIDATION_CHECKPOINT, JSON.stringify({ updated_at: cursor.updatedAt, slug: cursor.slug }), complete],
    );
    // Keep the old timestamp field current for rollback/read compatibility. The
    // v2 reader never relies on it for same-timestamp ordering.
    await tx.executeRaw(
      `UPDATE sources
          SET config = jsonb_set(
                COALESCE(config, '{}'::jsonb),
                '{connectors,context_mirror,watermark}',
                to_jsonb($1::text),
                true)
        WHERE id = $2`,
      [cursor.updatedAt, sourceId],
    );
  });
}

/** Inventory pre-ledger distilled pages without making them actionable. Legacy
 * pages remain source-scoped, human-review-only evidence until an explicit
 * reconciliation maps them to raw inputs and a verified generation. */
async function importLegacyDistilledBatch(
  engine: BrainEngine,
  source: ConnectorSource,
): Promise<{ scanned: number; imported: number; complete: boolean }> {
  const cursor = await readOperationalCursor(engine, source);
  const pages = await listPageBatchAfterCursor(engine, source.id, cursor, 'distilled/');
  let imported = 0;
  for (const page of pages) {
    const fm = asRecord(page.frontmatter);
    const slugParts = page.slug.split('/');
    const sessionId = str(fm?.session_id) ?? (slugParts[1] ? `legacy:${slugParts[1]}` : null);
    const generationValue = Number(fm?.generation ?? 1);
    const generation = Number.isInteger(generationValue) && generationValue >= 1 ? generationValue : 1;
    const partitionKey = str(fm?.partition) ?? slugParts.at(-1) ?? 'memory';
    if (!sessionId || !partitionKey) continue;
    const contentHash = page.content_hash || computeContentHash(captureText(page));
    const inputHash = computeContentHash(`unverified-legacy\n${source.id}\n${sessionId}\n${generation}`);
    imported += await engine.transaction(async (tx) => {
      await tx.executeRaw(
        `INSERT INTO context_mirror_session_heads (
           source_id, session_id, session_slug, capture_slug_prefix,
           newest_capture_at, turn_count, state, disposition, current_generation
         ) VALUES ($1,$2,$3,$4,'1970-01-01T00:00:00.000Z',0,'complete','unverified_legacy',$5)
         ON CONFLICT (source_id, session_id) DO NOTHING`,
        [source.id, sessionId, slugParts[1] ?? sessionId, `capture/${slugParts[1] ?? sessionId}/`, generation],
      );
      const generations = await tx.executeRaw<{ state: string }>(
        `SELECT state FROM context_mirror_generations
          WHERE source_id = $1 AND session_id = $2 AND generation = $3`,
        [source.id, sessionId, generation],
      );
      if (!generations[0]) {
        await tx.executeRaw(
          `INSERT INTO context_mirror_generations (
             source_id, session_id, generation, input_hash, originator, runtime,
             transform_version, model, state, is_current, requires_human_review,
             recovery_hold, completed_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'unverified_legacy',false,true,true,now())`,
          [
            source.id, sessionId, generation, inputHash,
            str(fm?.originator) ?? null, str(fm?.runtime) ?? null,
            str(fm?.transform_version) ?? 'unverified-legacy',
            str(fm?.model) ?? 'unknown',
          ],
        );
      } else if (generations[0].state !== 'unverified_legacy') {
        return 0;
      }
      const inserted = await tx.executeRaw<{ one: number }>(
        `INSERT INTO context_mirror_partitions (
           source_id, session_id, generation, partition_key, distilled_slug, content_hash, state
         ) VALUES ($1,$2,$3,$4,$5,$6,'unverified_legacy')
         ON CONFLICT (source_id, session_id, generation, partition_key) DO NOTHING
         RETURNING 1 AS one`,
        [source.id, sessionId, generation, partitionKey, page.slug, contentHash],
      );
      if (!inserted[0]) return 0;
      const manifestEntry = JSON.stringify([{ partition: partitionKey, slug: page.slug, content_hash: contentHash }]);
      await tx.executeRaw(
        `UPDATE context_mirror_generations
            SET expected_manifest = expected_manifest || $4::jsonb,
                expected_partitions = expected_partitions + 1,
                materialized_partitions = materialized_partitions + 1,
                updated_at = now()
          WHERE source_id = $1 AND session_id = $2 AND generation = $3
            AND state = 'unverified_legacy'`,
        [source.id, sessionId, generation, manifestEntry],
      );
      return 1;
    });
  }
  const complete = pages.length < CONSOLIDATION_BATCH_SIZE;
  const last = pages.at(-1);
  const next = last
    ? { updatedAt: new Date(last.updated_at).toISOString(), slug: last.slug }
    : cursor;
  await writeOperationalCursor(engine, source.id, next, complete);
  return { scanned: pages.length, imported, complete };
}

// ── Helpers: defensive payload access ────────────────────────────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/**
 * The capture text that becomes the candidate body: the page's compiled truth, plus the
 * timeline (separated by a blank line) ONLY when the timeline is non-empty. Defensive
 * against a non-string / absent compiled_truth or timeline (the runtime Page is `as`-cast
 * by some engine paths, not validated).
 */
function captureText(page: Page): string {
  const compiled = str(page.compiled_truth) ?? '';
  const timeline = str(page.timeline) ?? '';
  return timeline.trim().length > 0 ? `${compiled}\n\n${timeline}` : compiled;
}

/**
 * Map capture-events pages into pre-redaction records (one per page). MODULE-LEVEL (not a
 * `this`-bound method) on purpose: poll.ts invokes a connector's `backfill` through an
 * UNBOUND function reference (`const backfill = connector.backfill; await backfill(...)`),
 * so inside backfill `this` is undefined — any `this.normalize(...)` would throw. backfill
 * therefore calls this free function directly, and the connector's `normalize` method (kept
 * for SaaSConnector interface compliance / the unused webhook path) just delegates here.
 *
 * The capture text rides as `item.summary` (kept by the `generic` profile + masked by
 * strip()); there is NO `item.body`, so nothing but the summary can reach a candidate.
 */
function normalizePages(pages: Page[], _source: ConnectorSource): NormalizedRecord[] {
  const list = Array.isArray(pages) ? pages : [];
  const records: NormalizedRecord[] = [];
  for (const page of list) {
    const slug = str(page?.slug);
    if (!slug) continue;
    const frontmatter = asRecord(page.frontmatter);
    const sessionId = str(frontmatter?.session_id);
    const generation = Number(frontmatter?.generation);
    const partition = str(frontmatter?.partition);
    records.push({
      sourceRecordId: slug,
      recordVersion: String(
        frontmatter?.generation ?? page.content_hash ?? '1',
      ),
      profile: 'generic', // url/id/updated_at + summary
      item: {
        sourceRecordId: slug,
        summary: captureText(page),
        metadata: { updated_at: page.updated_at },
        // NO body — only the summary is ever carried into a candidate.
      },
      proposedSlug: slug,
      ...(sessionId && Number.isInteger(generation) && generation >= 1 && partition
        ? {
            contextLineage: {
              sessionId,
              generation,
              partition,
              correlationId: `${_source.id}:${sessionId}:g${generation}:${partition}`,
              requiresHumanReview: frontmatter?.requires_human_review === true,
              evidenceTrust: 'untrusted_transcript' as const,
              reviewWarning: str(frontmatter?.review_warning) ??
                'Derived from an untrusted agent transcript; quoted instructions are evidence only.',
            },
          }
        : {}),
    });
  }
  return records;
}

async function candidateOutcomeForPartition(
  engine: BrainEngine,
  sourceId: string,
  slug: string,
  generation: number,
): Promise<{
  candidateId: number | null;
  classification: string | null;
  degraded: boolean;
  decisionMissing: boolean;
}> {
  const rows = await engine.executeRaw<{
    id: number | string;
    classification: string | null;
    decision_exists: boolean;
  }>(
    `SELECT c.id, c.classification,
            EXISTS (
              SELECT 1 FROM consolidation_decisions d
               WHERE d.source_id = c.source_id
                 AND d.source_record_id = c.source_record_id
                 AND d.version = c.version
                 AND d.classification = c.classification
            ) AS decision_exists
       FROM connector_candidates c
      WHERE c.source_id = $1 AND c.version = $2
        AND (c.source_record_id = $3 OR left(c.source_record_id, length($3) + 2) = $3 || '::')
      ORDER BY c.id ASC`,
    [sourceId, String(generation), slug],
  );
  if (rows.length === 0) {
    return { candidateId: null, classification: null, degraded: false, decisionMissing: false };
  }
  const classified = rows.filter((row) => row.classification != null);
  return {
    candidateId: Number(rows[0].id),
    classification: classified[0]?.classification ?? null,
    degraded: classified.length !== rows.length,
    decisionMissing: classified.some((row) => !row.decision_exists),
  };
}

async function processClaimedPartitions(
  engine: BrainEngine,
  source: ConnectorSource,
  claims: ClaimedContextPartition[],
  consolidationEnabled: boolean,
): Promise<ConnectorBackfillResult> {
  const { landRecords } = await import('./base.ts');
  const diagnostics: ConnectorDiagnostic[] = [];
  let landed = 0;
  let terminal = 0;
  if (!consolidationEnabled) {
    for (const claim of claims) {
      await releaseContextPartition(engine, claim);
    }
    return {
      status: 'partial',
      landed: 0,
      diagnostics: [{
        stage: 'consolidate',
        code: 'consolidation_disabled',
        message: `${claims.length} distilled partition(s) remain pending because consolidation is disabled`,
      }],
    };
  }
  for (const claim of claims) {
    try {
      const page = await engine.getPage(claim.distilledSlug, { sourceId: source.id });
      if (!page || page.content_hash !== claim.contentHash) {
        diagnostics.push({
          stage: 'consolidate',
          code: 'partition_manifest_mismatch',
          message: `distilled partition ${claim.partitionKey} is missing or changed`,
        });
        await finishContextPartition(engine, {
          ...claim,
          state: 'failed',
          errorCode: 'partition_manifest_mismatch',
          errorMessage: 'distilled page is missing or its content hash changed',
        });
        continue;
      }
      const records = normalizePages([page], source);
      const result = await landRecords(engine, source.id, contextMirrorConnector, records, {
        consolidate: consolidationEnabled,
      });
      landed += result.written;
      diagnostics.push(...(result.diagnostics ?? []));
      const outcome = await candidateOutcomeForPartition(
        engine,
        source.id,
        claim.distilledSlug,
        claim.generation,
      );
      let state: 'decided' | 'degraded' | 'failed' = 'decided';
      let errorCode: string | null = null;
      let errorMessage: string | null = null;
      if (outcome.candidateId == null) {
        state = 'failed';
        errorCode = 'candidate_not_created';
        errorMessage = 'no candidate or terminal decision was persisted for this partition';
      } else if (outcome.decisionMissing) {
        state = 'failed';
        errorCode = 'decision_missing';
        errorMessage = 'candidate exists without its transactional decision record';
      } else if (result.status === 'partial' || outcome.degraded) {
        state = 'degraded';
        errorCode = result.diagnostics?.[0]?.code ??
          'raw_passthrough';
        errorMessage = result.diagnostics?.[0]?.message ??
          'consolidation degraded without a governed decision';
      }
      if (state === 'degraded' && errorCode && errorMessage) {
        diagnostics.push({ stage: 'consolidate', code: errorCode, message: errorMessage });
      }
      const finished = await finishContextPartition(engine, {
        ...claim,
        state,
        candidateId: outcome.candidateId,
        classification: outcome.classification,
        errorCode,
        errorMessage,
      });
      if (!finished) {
        diagnostics.push({
          stage: 'consolidate',
          code: 'partition_claim_lost',
          message: `partition claim expired before ${claim.partitionKey} could commit`,
        });
        continue;
      }
      if (state === 'decided' || state === 'degraded') {
        terminal += 1;
        await releaseReservationWhenGenerationResolved(
          engine,
          source.id,
          claim.sessionId,
          claim.generation,
        );
      } else if (errorCode && errorMessage) {
        diagnostics.push({ stage: 'consolidate', code: errorCode, message: errorMessage });
      }
    } catch (err) {
      await releaseContextPartition(engine, claim);
      diagnostics.push({
        stage: 'consolidate',
        code: 'partition_exception',
        message: safeDiagnosticMessage(err),
      });
    }
  }
  const status: ConnectorBackfillResult['status'] = diagnostics.length === 0
    ? 'ok'
    : terminal === 0 ? 'failed' : 'partial';
  return { status, landed, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
}

// ── The connector ─────────────────────────────────────────────────────────────────

export interface TargetedConsolidationOptions {
  sessionId: string;
  generation: number;
  maxPartitions: number;
  maxCalls: number;
  maxCostUsd: number;
  maxRuntimeMs: number;
  budgetAuditPath?: string;
  now?: Date;
}

export interface TargetedConsolidationReport {
  status: 'ok' | 'failed';
  stop_reason: 'completed' | 'target_unavailable' | 'partition_limit' | 'consolidation_disabled' | 'processing_failed';
  source_id: string;
  session_id: string;
  generation: number;
  eligible_partitions: number;
  selected_partitions: number;
  partition_keys: string[];
  landed: number;
  provider_calls_reserved: number;
  provider_calls_recorded: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  elapsed_ms: number;
  diagnostics: ConnectorDiagnostic[];
}

function targetedFailure(
  source: ConnectorSource,
  options: TargetedConsolidationOptions,
  stopReason: TargetedConsolidationReport['stop_reason'],
  code: string,
  message: string,
  eligiblePartitions = 0,
): TargetedConsolidationReport {
  return {
    status: 'failed',
    stop_reason: stopReason,
    source_id: source.id,
    session_id: options.sessionId,
    generation: options.generation,
    eligible_partitions: eligiblePartitions,
    selected_partitions: 0,
    partition_keys: [],
    landed: 0,
    provider_calls_reserved: 0,
    provider_calls_recorded: 0,
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    elapsed_ms: 0,
    diagnostics: [{ stage: 'consolidate', code, message }],
  };
}

/** Process exactly one current generation through the ordinary partition and
 * candidate path. This is a one-off canary seam, not a scheduler bypass: the
 * source must explicitly enable Context Mirror consolidation, and the caller
 * supplies independent provider call, cost, and runtime ceilings. */
export async function consolidateContextMirrorGeneration(
  engine: BrainEngine,
  source: ConnectorSource,
  options: TargetedConsolidationOptions,
): Promise<TargetedConsolidationReport> {
  const startedAt = Date.now();
  if (!supportsContextMirrorOperationalState(engine)) {
    return targetedFailure(source, options, 'processing_failed', 'operational_state_unavailable', 'durable operational state is required');
  }
  const cfg = contextMirrorConfig(source);
  if (cfg?.enabled !== true || cfg.consolidation_enabled !== true) {
    return targetedFailure(
      source,
      options,
      'consolidation_disabled',
      'consolidation_disabled',
      'the exact source must explicitly enable Context Mirror consolidation for the one-off process',
    );
  }
  const rows = await engine.executeRaw<{ count: number | string }>(
    `SELECT count(*) AS count
       FROM context_mirror_partitions p
       JOIN context_mirror_generations g
         ON g.source_id = p.source_id AND g.session_id = p.session_id AND g.generation = p.generation
      WHERE p.source_id = $1 AND p.session_id = $2 AND p.generation = $3
        AND p.state IN ('pending','failed') AND g.is_current AND g.state = 'complete'`,
    [source.id, options.sessionId, options.generation],
  );
  const eligible = Number(rows[0]?.count ?? 0);
  if (eligible === 0) {
    return targetedFailure(
      source,
      options,
      'target_unavailable',
      'target_unavailable',
      'the named current generation has no eligible partitions',
    );
  }
  if (eligible > options.maxPartitions) {
    return targetedFailure(
      source,
      options,
      'partition_limit',
      'partition_limit',
      `${eligible} eligible partitions exceed the declared limit ${options.maxPartitions}`,
      eligible,
    );
  }
  const claims = await claimContextPartitions(
    engine,
    source.id,
    eligible,
    options.now ?? new Date(),
    { sessionId: options.sessionId, generation: options.generation },
  );
  if (claims.length !== eligible) {
    await Promise.all(claims.map((claim) => releaseContextPartition(engine, claim)));
    return targetedFailure(
      source,
      options,
      'target_unavailable',
      'target_claim_incomplete',
      `claimed ${claims.length} of ${eligible} named partitions`,
      eligible,
    );
  }
  const tracker = new BudgetTracker({
    maxCalls: options.maxCalls,
    maxCostUsd: options.maxCostUsd,
    maxRuntimeMs: options.maxRuntimeMs,
    label: 'context-mirror-targeted-consolidation',
    ...(options.budgetAuditPath ? { auditPath: options.budgetAuditPath } : {}),
  });
  let result: ConnectorBackfillResult;
  try {
    result = await withBudgetTracker(
      tracker,
      async () => await processClaimedPartitions(engine, source, claims, true),
    );
  } catch (err) {
    await Promise.all(claims.map((claim) => releaseContextPartition(engine, claim)));
    result = {
      status: 'failed',
      landed: 0,
      diagnostics: [{ stage: 'consolidate', code: 'targeted_exception', message: safeDiagnosticMessage(err) }],
    };
  }
  const budget = tracker.snapshot();
  return {
    status: result.status === 'ok' ? 'ok' : 'failed',
    stop_reason: result.status === 'ok' ? 'completed' : 'processing_failed',
    source_id: source.id,
    session_id: options.sessionId,
    generation: options.generation,
    eligible_partitions: eligible,
    selected_partitions: claims.length,
    partition_keys: claims.map((claim) => claim.partitionKey),
    landed: result.landed,
    provider_calls_reserved: budget.callsReserved,
    provider_calls_recorded: budget.callsRecorded,
    input_tokens: budget.inputTokensRecorded,
    output_tokens: budget.outputTokensRecorded,
    estimated_cost_usd: budget.cumulativeCostUsd,
    elapsed_ms: Date.now() - startedAt,
    diagnostics: result.diagnostics ?? [],
  };
}

export const contextMirrorConnector: SaaSConnector = {
  provider: PROVIDER,
  signatureHeader: CONTEXT_MIRROR_SIGNATURE_HEADER,

  /** Poll-only/internal: nothing sends a webhook, so there is no inbound delivery to
   *  verify. Fail closed unconditionally. */
  verifyWebhook(): boolean {
    return false;
  },

  /** No webhook payload → no account to resolve. The generic receiver would 400; correct,
   *  because Context Mirror is poll-only and must not use it. */
  accountFromPayload(): string | null {
    return null;
  },

  /**
   * SaaSConnector interface compliance. Unlike a webhook connector, the input is the `Page[]`
   * backfill fetched from the source (NOT a webhook payload). Delegates to the module-level
   * {@link normalizePages} (see its note on why the real logic is not a `this`-bound method).
   * The poll-only receiver never calls this; backfill uses normalizePages directly.
   */
  normalize(pages: Page[], source: ConnectorSource): NormalizedRecord[] {
    return normalizePages(pages, source);
  },

  /** Map a (minimized) record to a candidate. version is fixed at '1' — capture pages are
   *  immutable (one per message, never rewritten), so the (source_id, source_record_id,
   *  version) idempotency key is stable. proposed_markdown is the redacted capture text. */
  toCandidate(record, sourceId): ConnectorCandidateItem {
    const lineage = record.contextLineage;
    return {
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      version: record.recordVersion ?? '1',
      provider: PROVIDER,
      proposed_slug: record.proposedSlug,
      proposed_markdown: record.item.summary,
      confidence: 0.9,
      context_session_id: lineage?.sessionId ?? null,
      context_generation: lineage?.generation ?? null,
      context_partition: lineage?.partition ?? null,
      correlation_id: lineage?.correlationId ?? null,
      requires_human_review: lineage?.requiresHumanReview ?? false,
      evidence_trust: lineage?.evidenceTrust ?? null,
      review_warning: lineage?.reviewWarning ?? null,
    };
  },

  /**
   * Poll backfill: distill bounded raw sessions, import unverified legacy evidence,
   * admit waiting review work, then claim durable current-generation partitions.
   * Lightweight test engines retain the legacy timestamp-watermark compatibility path.
   */
  async backfill(engine: BrainEngine, source: ConnectorSource): Promise<number | ConnectorBackfillResult> {
    const { landRecords } = await import('./base.ts');

    // Live scheduling: when config.connectors.context_mirror.distill_before_poll is true,
    // distill COMPLETED raw sessions into distilled/ pages BEFORE consolidating, so the
    // scheduled connector poll runs the full live pipeline (distill → consolidate). A
    // distillation failure must NOT block consolidating distilled/ pages that already exist;
    // an AbortError (shutdown) propagates.
    const cmCfg = contextMirrorConfig(source);
    let distillStatus: ConnectorBackfillResult['status'] = 'ok';
    const diagnostics: ConnectorDiagnostic[] = [];
    if (cmCfg?.distill_before_poll === true) {
      try {
        const { distillCaptureSessions } = await import('./distill.ts');
        const distill = await distillCaptureSessions(engine, {
          sourceId: source.id,
          idleHours: typeof cmCfg.distill_idle_hours === 'number' ? cmCfg.distill_idle_hours : 6,
          maxSessions: typeof cmCfg.distill_max_sessions === 'number' ? cmCfg.distill_max_sessions : 5,
          maxCalls: typeof cmCfg.distill_max_calls === 'number' ? cmCfg.distill_max_calls : 5,
          maxInputTokens: typeof cmCfg.distill_max_input_tokens === 'number' ? cmCfg.distill_max_input_tokens : 100_000,
          maxOutputTokens: typeof cmCfg.distill_max_output_tokens === 'number' ? cmCfg.distill_max_output_tokens : 20_000,
          maxCostUsd: typeof cmCfg.distill_max_cost_usd === 'number' ? cmCfg.distill_max_cost_usd : 0.25,
          maxRuntimeMs: typeof cmCfg.distill_max_runtime_ms === 'number' ? cmCfg.distill_max_runtime_ms : 600_000,
          maxMemoryBytes: typeof cmCfg.distill_max_memory_bytes === 'number' ? cmCfg.distill_max_memory_bytes : 67_108_864,
          requestTimeoutMs: typeof cmCfg.distill_request_timeout_ms === 'number' ? cmCfg.distill_request_timeout_ms : 60_000,
          maxRetries: typeof cmCfg.distill_max_retries === 'number' ? cmCfg.distill_max_retries : 0,
        });
        distillStatus = distill.status ?? 'ok';
        if (distillStatus !== 'ok') {
          const failedSession = distill.sessions?.find((session) => session.status === 'failed');
          diagnostics.push({
            stage: 'distill',
            code: failedSession?.error_class ?? distill.stop_reason ?? 'distill_incomplete',
            message: failedSession?.error ??
              `distillation stopped: ${distill.stop_reason ?? distillStatus} (${distill.deferred ?? 0} deferred)`,
          });
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') throw err;
        distillStatus = 'failed';
        diagnostics.push({
          stage: 'distill',
          code: 'distill_exception',
          message: safeDiagnosticMessage(err),
        });
      }
    }

    const operationalState = supportsContextMirrorOperationalState(engine);
    if (operationalState) {
      try {
        const legacy = await importLegacyDistilledBatch(engine, source);
        if (legacy.imported > 0) {
          distillStatus = combineConnectorStatus(distillStatus, 'partial');
          diagnostics.push({
            stage: 'consolidate',
            code: 'unverified_legacy_imported',
            message: `${legacy.imported} legacy distilled partition(s) are held for explicit reconciliation`,
          });
        }
      } catch (err) {
        distillStatus = 'failed';
        diagnostics.push({
          stage: 'consolidate',
          code: 'legacy_import_failed',
          message: safeDiagnosticMessage(err),
        });
      }
      await admitWaitingCandidates(engine, source.id);
      if (cmCfg?.consolidation_enabled !== true) {
        const pendingRows = await engine.executeRaw<{ count: number | string }>(
          `SELECT count(*) AS count
             FROM context_mirror_partitions p
             JOIN context_mirror_generations g
               ON g.source_id = p.source_id
              AND g.session_id = p.session_id
              AND g.generation = p.generation
            WHERE p.source_id = $1 AND p.state IN ('pending','failed')
              AND g.is_current AND g.state = 'complete'`,
          [source.id],
        );
        const pending = Number(pendingRows[0]?.count ?? 0);
        if (pending > 0) {
          diagnostics.push({
            stage: 'consolidate',
            code: 'consolidation_disabled',
            message: `${pending} distilled partition(s) remain pending because consolidation is disabled`,
          });
          return {
            status: combineConnectorStatus(distillStatus, 'partial'),
            landed: 0,
            diagnostics,
          };
        }
      }
      const claims = await claimContextPartitions(engine, source.id, CONSOLIDATION_BATCH_SIZE, new Date());
      if (claims.length > 0) {
        const partitionResult = await processClaimedPartitions(
          engine,
          source,
          claims,
          cmCfg?.consolidation_enabled === true,
        );
        diagnostics.push(...(partitionResult.diagnostics ?? []));
        return {
          status: combineConnectorStatus(distillStatus, partitionResult.status),
          landed: partitionResult.landed,
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
        };
      }
      return {
        status: distillStatus,
        landed: 0,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    }

    const since = readWatermark(source);
    const slugPrefix = readSlugPrefix(source);
    const pages = await engine.listPages({
      sourceId: source.id,
      updated_after: since ?? undefined,
      // When set (e.g. 'distilled/'), consolidate ONLY distilled session memories — never
      // raw per-turn captures (which would flood the review queue one-candidate-per-turn).
      slugPrefix,
      sort: 'updated_asc',
    });
    if (!pages.length) {
      return cmCfg?.distill_before_poll === true
        ? { status: distillStatus, landed: 0, ...(diagnostics.length > 0 ? { diagnostics } : {}) }
        : 0;
    }

    // NOTE: poll.ts calls backfill through an UNBOUND reference, so `this` is undefined here.
    // Use the module-level normalizePages + the named connector const (NOT `this`).
    const records = normalizePages(pages, source);
    // POLL-only consolidation (KTD4): backfill is the latency-tolerant poll path, so it
    // opts in via `consolidate: true`. The Memory Consolidation Engine then runs per record
    // IFF config.connectors.context_mirror.consolidation_enabled is set (default OFF). This
    // is the connector's only landRecords call site (poll-only, no webhook path).
    const landing = await landRecords(engine, source.id, contextMirrorConnector, records, {
      consolidate: cmCfg?.consolidation_enabled === true,
    });
    diagnostics.push(...(landing.diagnostics ?? []));
    const finalStatus = combineConnectorStatus(distillStatus, landing.status ?? 'ok');

    // pages are sorted updated_asc, so the last is the newest; persist a normalized UTC ISO
    // string. `updated_after` is strict, so newest is strictly > `since` — never a regression.
    const newestPage = pages[pages.length - 1];
    const newest = new Date(newestPage.updated_at).toISOString();
    await writeWatermark(engine, source, newest);
    return cmCfg?.distill_before_poll === true
      || landing.status != null
      ? { status: finalStatus, landed: landing.written, ...(diagnostics.length > 0 ? { diagnostics } : {}) }
      : landing.written;
  },
};

function combineConnectorStatus(
  first: ConnectorBackfillResult['status'],
  second: ConnectorBackfillResult['status'],
): ConnectorBackfillResult['status'] {
  if (first === 'failed' || second === 'failed') return 'failed';
  if (first === 'partial' || second === 'partial') return 'partial';
  return 'ok';
}

function safeDiagnosticMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240) || 'unknown distillation failure';
}

// ── Per-source config (sources.config.connectors.context_mirror.*) ───────────────

function safeParseConfig(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function contextMirrorConfig(source: ConnectorSource): Record<string, unknown> | null {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  return asRecord(connectors?.[PROVIDER]);
}

/** The persisted watermark (newest page updated_at landed), or null on first run. */
export function readWatermark(source: ConnectorSource): string | null {
  return str(contextMirrorConfig(source)?.watermark) ?? null;
}

/** Optional slug-prefix filter. When set (e.g. 'distilled/'), backfill lists ONLY pages whose
 *  slug starts with it, so the connector consolidates distilled session memories and NEVER raw
 *  per-turn captures (one-candidate-per-turn flood). Unset → all pages in the source (back-compat). */
export function readSlugPrefix(source: ConnectorSource): string | undefined {
  return str(contextMirrorConfig(source)?.read_slug_prefix) ?? undefined;
}

/**
 * Persist ONLY the watermark via a surgical jsonb_set, leaving sibling config keys intact
 * (lost-update-safe, same pattern as granola's writeWatermark). A COALESCE guarantees the
 * connectors.context_mirror path is created if absent.
 */
export async function writeWatermark(
  engine: BrainEngine,
  source: ConnectorSource,
  watermark: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET config = jsonb_set(
              COALESCE(config, '{}'::jsonb),
              '{connectors,context_mirror,watermark}',
              to_jsonb($1::text),
              true)
      WHERE id = $2`,
    [watermark, source.id],
  );
}

// ── Registration (side-effecting at module load) ─────────────────────────────────

registerConnector(contextMirrorConnector);
