/**
 * connector_candidates — table-only store for connector output.
 *
 * Candidates are NEVER written as `pages` or `content_chunks` rows.
 * Because gbrain's search paths (searchKeyword, searchVector,
 * searchKeywordChunks) query only `pages`, a row that only exists in
 * `connector_candidates` is structurally unreachable by every search
 * variant, including explicit-source and __all__ federated-read searches.
 *
 * Idempotency: the INSERT uses ON CONFLICT (source_id, source_record_id,
 * version) DO NOTHING, backed by the UNIQUE constraint added in T1/T2.
 * Calling toRow twice with the same key is a safe no-op.
 *
 * TECH-2031 — greenfield addition. No page-writing code in this module.
 */

import type { BrainEngine } from '../engine.ts';
import { strip } from './redact.ts';
import {
  buildPromotionArtifact,
  canonicalizeArtifactForSigning,
  artifactHash,
  type PromotionTarget,
} from './promotion.ts';

// ── Input type ────────────────────────────────────────────────────────────────

/**
 * Input supplied by the connector caller for a single candidate.
 */
export interface ConnectorCandidateItem {
  /** Which brain source this candidate belongs to. */
  source_id: string;
  /** Singular idempotency anchor — the upstream record's stable identifier. */
  source_record_id: string;
  /** Version string for this candidate (default '1'). */
  version?: string;
  /** Full set of upstream record IDs this candidate summarises. */
  source_record_ids?: readonly string[] | string[];
  /** Provider that produced this candidate (e.g. 'crunchbase', 'apollo'). */
  provider?: string;
  /** Proposed brain slug — never inserted into pages. */
  proposed_slug?: string;
  /** Markdown body this candidate would become if promoted — never chunked. */
  proposed_markdown?: string;
  /** LLM-assigned confidence score, 0..1. */
  confidence?: number;
  /** PII/field redaction tags (JSONB array). */
  redactions?: readonly unknown[] | unknown[];
  /** When this candidate should be considered stale. */
  expires_at?: Date;
  /** As-of timestamp for the upstream data. */
  as_of?: Date;
  /** Reference to a rationale document slug or URL. */
  rationale_ref?: string;
}

// ── Row type (what we insert / return) ────────────────────────────────────────

/**
 * Shape of a persisted connector_candidates row.
 * Mirrors the database columns; nullable fields use `null` at runtime.
 */
export interface ConnectorCandidateRow {
  id: number;
  source_id: string;
  source_record_id: string;
  version: string;
  source_record_ids: string[];
  provider: string | null;
  proposed_slug: string | null;
  proposed_markdown: string | null;
  confidence: number | null;
  redactions: unknown[];
  expires_at: Date | null;
  as_of: Date | null;
  rationale_ref: string | null;
  status: 'pending' | 'accepted' | 'rejected';
  status_reason: string | null;
  acted_by: string | null;
  acted_at: Date | null;
  superseded_by: number | null;
  // TECH-2109 promotion bridge columns — all nullable; pre-promotion rows read null.
  target_kind: 'existing_page' | 'inbox' | null;
  target_path: string | null;
  promotion_status: 'pr_opened' | 'indexed' | 'promoted_to_inbox' | 'needs_fix' | 'failed' | null;
  promotion_pr_url: string | null;
  promotion_branch: string | null;
  promoted_at: Date | null;
  artifact_hash: string | null;
  proposed_at: Date;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Render a deterministic markdown stub for a candidate that has no
 * caller-supplied proposed_markdown. Pure function; no I/O.
 */
function renderCandidateMarkdown(item: ConnectorCandidateItem): string {
  const lines: string[] = [];

  if (item.proposed_slug) {
    lines.push(`# ${item.proposed_slug}`);
    lines.push('');
  }

  if (item.provider) {
    lines.push(`**Provider:** ${item.provider}`);
  }
  lines.push(`**Source record:** ${item.source_record_id}`);
  if (item.version && item.version !== '1') {
    lines.push(`**Version:** ${item.version}`);
  }
  if (item.confidence !== undefined && item.confidence !== null) {
    lines.push(`**Confidence:** ${item.confidence.toFixed(2)}`);
  }
  if (item.as_of) {
    lines.push(`**As of:** ${item.as_of.toISOString()}`);
  }

  return lines.join('\n');
}

/**
 * Build a complete row shape from a ConnectorCandidateItem.
 * Pure function; assigns defaults and generates proposed_markdown. No I/O.
 */
function buildCandidateRow(
  item: ConnectorCandidateItem,
): Omit<
  ConnectorCandidateRow,
  // 'id' / 'proposed_at' are DB-generated; the TECH-2109 promotion columns are
  // written later (at approval) by approveCandidate / the promotion bridge, never
  // by the connector INSERT — they default to NULL here.
  | 'id'
  | 'proposed_at'
  | 'target_kind'
  | 'target_path'
  | 'promotion_status'
  | 'promotion_pr_url'
  | 'promotion_branch'
  | 'promoted_at'
  | 'artifact_hash'
> {
  // Redaction is ENFORCED HERE, at the write boundary — toRow is the last gate
  // before connector_candidates and must not trust its callers (the framework's
  // landRecords today, the future promotion bridge, or any other). The
  // page-body-bound string fields — the ones that can become a served page body,
  // a slug, or a citation — are stripped of PII/secrets. The stub is rendered
  // FIRST and then stripped, so a secret embedded in proposed_slug cannot survive
  // by being re-materialised into the generated markdown. strip() is idempotent,
  // so re-stripping already-redacted input (e.g. from landRecords) is a no-op.
  const proposedMarkdown = item.proposed_markdown ?? renderCandidateMarkdown(item);
  return {
    source_id: item.source_id,
    source_record_id: item.source_record_id,
    version: strip(item.version ?? '1'),
    source_record_ids: item.source_record_ids ? [...item.source_record_ids] : [],
    provider: item.provider != null ? strip(item.provider) : null,
    proposed_slug: item.proposed_slug != null ? strip(item.proposed_slug) : null,
    proposed_markdown: strip(proposedMarkdown),
    confidence: item.confidence ?? null,
    redactions: item.redactions ? [...item.redactions] : [],
    expires_at: item.expires_at ?? null,
    as_of: item.as_of ?? null,
    rationale_ref: item.rationale_ref != null ? strip(item.rationale_ref) : null,
    status: 'pending',
    status_reason: null,
    acted_by: null,
    acted_at: null,
    superseded_by: null,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Insert a connector candidate into the `connector_candidates` table.
 *
 * Returns `{ written: true, row }` when a new row was inserted, or
 * `{ written: false, row }` when the same (source_id, source_record_id,
 * version) already existed (ON CONFLICT DO NOTHING).
 *
 * This function NEVER calls put_page, ingest_capture, upsertChunks, or
 * any pages-writing engine method. Candidates are structurally invisible
 * to every gbrain search path.
 */
export async function toRow(
  engine: BrainEngine,
  item: ConnectorCandidateItem,
): Promise<{ written: boolean; row: ConnectorCandidateRow }> {
  const candidate = buildCandidateRow(item);

  // Positional params:
  //   $1  source_id        TEXT
  //   $2  source_record_id TEXT
  //   $3  version          TEXT
  //   $4  source_record_ids TEXT[]    — cast in SQL as $4::text[]
  //   $5  provider          TEXT
  //   $6  proposed_slug     TEXT
  //   $7  proposed_markdown TEXT
  //   $8  confidence        REAL
  //   $9  redactions        JSONB     — cast in SQL as $9::jsonb
  //       Passing a JS object with an explicit ::jsonb SQL cast is the
  //       same bind-protocol path as executeRawJsonb — both engines encode
  //       the object without the JSON.stringify(x)::jsonb double-encode
  //       bug class (verified by test/sql-query.test.ts on PGLite).
  //  $10  expires_at       TIMESTAMPTZ
  //  $11  as_of            TIMESTAMPTZ
  //  $12  rationale_ref    TEXT
  //  $13  status           TEXT
  //  $14  status_reason    TEXT
  //  $15  acted_by         TEXT
  //  $16  acted_at         TIMESTAMPTZ
  //  $17  superseded_by    BIGINT
  const params: unknown[] = [
    candidate.source_id,            // $1
    candidate.source_record_id,     // $2
    candidate.version,              // $3
    candidate.source_record_ids,    // $4  ::text[]
    candidate.provider,             // $5
    candidate.proposed_slug,        // $6
    candidate.proposed_markdown,    // $7
    candidate.confidence,           // $8
    candidate.redactions,           // $9  ::jsonb (JS object, cast in SQL)
    candidate.expires_at,           // $10
    candidate.as_of,                // $11
    candidate.rationale_ref,        // $12
    candidate.status,               // $13
    candidate.status_reason,        // $14
    candidate.acted_by,             // $15
    candidate.acted_at,             // $16
    candidate.superseded_by,        // $17
  ];

  const insertSql = `
    INSERT INTO connector_candidates (
      source_id, source_record_id, version,
      source_record_ids,
      provider, proposed_slug, proposed_markdown,
      confidence,
      redactions,
      expires_at, as_of, rationale_ref,
      status, status_reason, acted_by, acted_at, superseded_by
    ) VALUES (
      $1, $2, $3,
      $4::text[],
      $5, $6, $7,
      $8,
      $9::jsonb,
      $10, $11, $12,
      $13, $14, $15, $16, $17
    )
    ON CONFLICT (source_id, source_record_id, version) DO NOTHING
    RETURNING ${CANDIDATE_COLUMNS}
  `;

  const rows = await engine.executeRaw<ConnectorCandidateRow>(insertSql, params);

  if (rows.length === 0) {
    // ON CONFLICT DO NOTHING — row already existed; fetch it for the caller.
    const fetchSql = `
      SELECT ${CANDIDATE_COLUMNS}
      FROM connector_candidates
      WHERE source_id         = $1
        AND source_record_id  = $2
        AND version           = $3
    `;
    const existing = await engine.executeRaw<ConnectorCandidateRow>(fetchSql, [
      candidate.source_id,
      candidate.source_record_id,
      candidate.version,
    ]);
    return { written: false, row: existing[0] };
  }

  return { written: true, row: rows[0] };
}

// ── Review queue (TECH-2036): list + act on pending candidates ────────────────────
//
// The admin review queue (admin/src/pages/ReviewQueue.tsx) and its agent-callable
// /admin/api/candidates* routes are thin wrappers over these helpers. The candidate row's
// own status / status_reason / acted_by / acted_at columns ARE the audit trail (gbrain has
// no separate audit_logs table) — every act here stamps the actor + time. Approval hands the
// row to the promotion-hook seam below; the bridge that fills it lives in TECH-2037.

/** The connector_candidates columns, in row order — the single source of truth so every
 *  SELECT / RETURNING produces an identical ConnectorCandidateRow shape. */
const CANDIDATE_COLS = [
  'id', 'source_id', 'source_record_id', 'version',
  'source_record_ids', 'provider', 'proposed_slug', 'proposed_markdown',
  'confidence', 'redactions', 'expires_at', 'as_of', 'rationale_ref',
  'status', 'status_reason', 'acted_by', 'acted_at', 'superseded_by',
  // TECH-2109 promotion bridge columns
  'target_kind', 'target_path', 'promotion_status', 'promotion_pr_url',
  'promotion_branch', 'promoted_at', 'artifact_hash',
  'proposed_at',
] as const;
/** Bare column list, for RETURNING / unqualified SELECT. */
const CANDIDATE_COLUMNS = CANDIDATE_COLS.join(', ');
/** Same columns, qualified by a table alias — for the JOINed review-queue SELECT. */
const candidateColumnsAs = (alias: string): string => CANDIDATE_COLS.map((c) => `${alias}.${c}`).join(', ');

/**
 * Confidence at/above which a candidate carrying NO linked rationale `take` (rationale_ref)
 * is flagged for explicit reviewer attention (AC4 — a high-confidence SoR field-change with no
 * rationale should not be promoted on autopilot). A flag, never a block.
 */
export const NEEDS_RATIONALE_CONFIDENCE = 0.8;

/** True when a candidate is high-confidence yet has no linked rationale `take`. Pure. */
export function needsRationale(
  row: Pick<ConnectorCandidateRow, 'confidence' | 'rationale_ref'>,
): boolean {
  return (row.confidence ?? 0) >= NEEDS_RATIONALE_CONFIDENCE && !row.rationale_ref;
}

/**
 * Coerce the `bigint` id columns (`id`, `superseded_by`) that the Postgres driver returns as
 * JS `BigInt` to `number`, so a row matches its declared `id: number` / `superseded_by:
 * number | null` types AND is JSON-serializable. `res.json` / `JSON.stringify` throw on a
 * `BigInt` ("cannot serialize BigInt"), which surfaced as an HTTP 500 on EVERY admin
 * approve/reject/list even though the server-side work succeeded (TECH-2120). `Number()`
 * is lossless here — candidate ids fit comfortably within 2^53. Apply at every read site
 * that returns a candidate row to a caller. Pure.
 */
export function coerceCandidateRow<T extends ConnectorCandidateRow>(row: T): T {
  return {
    ...row,
    id: Number(row.id),
    superseded_by: row.superseded_by == null ? row.superseded_by : Number(row.superseded_by),
  } as T;
}

/** A candidate row enriched for the review queue: the source's human name + the flag. */
export interface ReviewCandidate extends ConnectorCandidateRow {
  source_name: string | null;
  needs_rationale: boolean;
}

export interface ListCandidatesOpts {
  /** Default 'pending' — the review queue's working set. */
  status?: 'pending' | 'accepted' | 'rejected';
  /** Optional per-source filter. */
  sourceId?: string;
  page?: number;
  pageSize?: number;
}

export interface ListCandidatesResult {
  rows: ReviewCandidate[];
  total: number;
  page: number;
  pages: number;
}

/**
 * List candidates (default: pending), newest-first, paginated, each enriched with the source
 * name (LEFT JOIN sources) and the needs_rationale flag. Read-only — no side effects. The
 * status + optional source filter are positional-parameterised; page size is clamped to
 * [1, 200].
 */
export async function listCandidates(
  engine: BrainEngine,
  opts: ListCandidatesOpts = {},
): Promise<ListCandidatesResult> {
  const status = opts.status ?? 'pending';
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
  const offset = (page - 1) * pageSize;

  const filters: string[] = ['c.status = $1'];
  const params: unknown[] = [status];
  if (opts.sourceId) {
    params.push(opts.sourceId);
    filters.push(`c.source_id = $${params.length}`);
  }
  const where = filters.join(' AND ');
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const rows = await engine.executeRaw<ConnectorCandidateRow & { source_name: string | null }>(
    `SELECT ${candidateColumnsAs('c')}, s.name AS source_name
       FROM connector_candidates c
       LEFT JOIN sources s ON s.id = c.source_id
      WHERE ${where}
      ORDER BY c.proposed_at DESC, c.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, pageSize, offset],
  );
  const [countRow] = await engine.executeRaw<{ total: number }>(
    `SELECT count(*)::int AS total FROM connector_candidates c WHERE ${where}`,
    params,
  );
  const total = countRow?.total ?? 0;
  return {
    rows: rows.map((r) => ({ ...coerceCandidateRow(r), needs_rationale: needsRationale(r) })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/**
 * Reject a PENDING candidate: status→rejected + reviewer's reason + actor/time audit. Guarded
 * by `status = 'pending'` so a double-submit or a race on an already-acted row is a safe no-op
 * (returns null). The reason is redaction-stripped — a reviewer note must not become a new
 * leak vector for a secret pasted from the candidate body.
 */
export async function rejectCandidate(
  engine: BrainEngine,
  id: number,
  actor: string,
  reason: string | null,
): Promise<ConnectorCandidateRow | null> {
  const rows = await engine.executeRaw<ConnectorCandidateRow>(
    `UPDATE connector_candidates
        SET status = 'rejected', status_reason = $2, acted_by = $3, acted_at = now()
      WHERE id = $1 AND status = 'pending'
      RETURNING ${CANDIDATE_COLUMNS}`,
    [id, reason != null ? strip(reason) : null, strip(actor)],
  );
  return rows[0] ? coerceCandidateRow(rows[0]) : null;
}

/**
 * The promotion-hook seam (AC3 / gt-promotion-hook). TECH-2037 / TECH-2109 register the real
 * techtris-brain promotion bridge (build → sign → emitRepositoryDispatch →
 * updateCandidatePromotionState). Until a hook is registered an approved candidate sits in an
 * 'accepted'-pending, retriable state — never lost (TECH-2037 AC3). The hook receives the
 * accepted row (already carrying target_kind / target_path / artifact_hash) AND the
 * reviewer-selected target so it can build the artifact for the dispatch.
 */
export interface PromotionHook {
  (
    engine: BrainEngine,
    candidate: ConnectorCandidateRow,
    actor: string,
    target: PromotionTarget,
  ): Promise<{ prUrl?: string }>;
}
let promotionHook: PromotionHook | null = null;

/** Register (or clear, with null) the promotion bridge invoked on candidate approval. */
export function registerPromotionHook(fn: PromotionHook | null): void {
  promotionHook = fn;
}
/** The currently-registered promotion hook, or null when none is wired (the v1 default). */
export function getPromotionHook(): PromotionHook | null {
  return promotionHook;
}

/** Thrown by approveCandidate when the reviewer-selected target fails server-side validation. */
export class PromotionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromotionTargetError';
  }
}

/**
 * Server-side promotion-target validation — rejects BEFORE any write (AC3). The Brain bridge
 * has its own fail-closed path sandbox, but gbrain refuses to PERSIST or DISPATCH a target
 * that is obviously unsafe so a bad target never reaches the external repo.
 *
 *  - existing_page REQUIRES a non-empty target_path.
 *  - ANY mode rejects a target_path with leading/trailing whitespace, a leading '/' or '~'
 *    (absolute), a backslash, a NUL, a URL scheme ('scheme://'), an empty path segment, or
 *    any dot-prefixed segment ('.', '..', '....', a dotfile, or a dot-directory like '.git'
 *    / '.github').
 *
 * Canonical-by-rejection: anything non-canonical is REJECTED, never silently rewritten, so a
 * path that PASSES is guaranteed canonical — the exact string persisted in target_path and
 * emitted in the HMAC-signed artifact is therefore safe without mutating the reviewer's input.
 * This rejects the parent-directory (..) traversal class AND the non-canonical-but-passing
 * inputs (' /etc/passwd', 'a/./b.md', '....//x', 'a//b') that a substring/segment-equality
 * check would let through. The Brain bridge re-validates with its own fail-closed sandbox
 * (CONTENT_DIRS confinement + protected-path rejection); this is defense in depth.
 *
 * inbox MAY omit the path (the Brain defaults it); when inbox supplies a path it is held to
 * the same rules.
 */
export function validatePromotionTarget(target: PromotionTarget): void {
  const path = target.path ?? '';
  if (target.kind === 'existing_page' && !path.trim()) {
    throw new PromotionTargetError('existing_page target requires a non-empty target_path');
  }
  if (path) {
    if (path !== path.trim()) {
      throw new PromotionTargetError('target_path has leading/trailing whitespace');
    }
    if (path.includes('\x00')) throw new PromotionTargetError('target_path contains a NUL byte');
    if (path.includes('\\')) throw new PromotionTargetError('target_path contains a backslash');
    if (path.startsWith('/') || path.startsWith('~')) {
      throw new PromotionTargetError('target_path must be relative (no leading / or ~)');
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) {
      throw new PromotionTargetError('target_path must not be a URL (scheme://)');
    }
    for (const segment of path.split('/')) {
      if (segment === '') {
        throw new PromotionTargetError('target_path contains an empty path segment');
      }
      if (segment.startsWith('.')) {
        // Rejects '.', '..' (traversal), '....' (literal multi-dot), and any dotfile /
        // dot-directory ('.git', '.github/...') — none of which is a legitimate Brain
        // content path (CONTENT_DIRS pages + inbox slugs never start with a dot).
        throw new PromotionTargetError(`target_path contains a dot-prefixed segment: ${segment}`);
      }
    }
  }
}

export interface ApproveResult {
  /** The accepted row, or null when the id was not pending (not-found / already acted). */
  row: ConnectorCandidateRow | null;
  /** Whether a promotion bridge ran, and its outcome. `pending` = accepted but not yet
   *  promoted (no hook, or the bridge threw) — retriable, never lost. */
  promotion: { invoked: boolean; pending?: boolean; prUrl?: string; error?: string };
}

/**
 * Approve a PENDING candidate with a reviewer-selected promotion target.
 *
 * Order (AC3):
 *  1. validatePromotionTarget — rejects an unsafe target BEFORE any write (throws).
 *  2. Build the minimized artifact + its canonical string + artifact_hash from the CURRENT
 *     row (fetched read-only) so the hash is computed before the accept UPDATE.
 *  3. ONE UPDATE sets status='accepted' + actor/time AND persists target_kind / target_path /
 *     artifact_hash, guarded by status='pending' (idempotency: a duplicate approve hits 0 rows
 *     and is a safe no-op). The decision + target are committed BEFORE the bridge runs.
 *  4. Hand the accepted row + target to the promotion hook. A hook failure leaves the row
 *     accepted-pending (retriable) — never throws out of approve, never marks promoted.
 *
 * A non-pending id (not found / already acted) returns { row: null }.
 */
export async function approveCandidate(
  engine: BrainEngine,
  id: number,
  actor: string,
  target: PromotionTarget,
): Promise<ApproveResult> {
  // 1. Reject an unsafe target before touching the DB.
  validatePromotionTarget(target);

  // 2. Read the current row to compute the artifact hash. If it is not pending, the accept
  //    UPDATE below will no-op anyway; computing the hash off a stale/absent row is harmless
  //    because it is only written inside the status='pending'-guarded UPDATE.
  const [current] = await engine.executeRaw<ConnectorCandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM connector_candidates WHERE id = $1`,
    [id],
  );
  let hash: string | null = null;
  if (current) {
    const artifact = buildPromotionArtifact(current, target);
    const canonical = canonicalizeArtifactForSigning(artifact);
    hash = artifactHash(canonical);
  }

  // 3. SAME UPDATE: accept + persist target + artifact_hash, guarded for idempotency.
  const rows = await engine.executeRaw<ConnectorCandidateRow>(
    `UPDATE connector_candidates
        SET status = 'accepted', acted_by = $2, acted_at = now(),
            target_kind = $3, target_path = $4, artifact_hash = $5
      WHERE id = $1 AND status = 'pending'
      RETURNING ${CANDIDATE_COLUMNS}`,
    [id, strip(actor), target.kind, target.path || null, hash],
  );
  const row = rows[0] ? coerceCandidateRow(rows[0]) : null;
  if (!row) return { row: null, promotion: { invoked: false } };

  // 4. Hand to the promotion hook (build → sign → emit → reflect). Failure stays retriable.
  const hook = getPromotionHook();
  if (!hook) return { row, promotion: { invoked: false, pending: true } };
  try {
    const result = await hook(engine, row, actor, target);
    return { row, promotion: { invoked: true, prUrl: result.prUrl } };
  } catch (err) {
    // Bridge failure: the row stays 'accepted' (already committed) — retriable, never lost.
    return { row, promotion: { invoked: false, pending: true, error: err instanceof Error ? err.message : String(err) } };
  }
}
