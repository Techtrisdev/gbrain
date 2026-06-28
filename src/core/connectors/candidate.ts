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
import type { ConsolidationClassification } from './consolidation-decisions.ts';
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

  // ── Memory Consolidation Engine (U3) — pre-computed promotion target ──────────
  // Set ONLY by landRecords' consolidation path; absent on every non-consolidation
  // candidate (today's passthrough, the webhook receiver, tombstones), where they
  // all default to NULL — leaving such a row byte-identical to before U3.
  /** The classifier verdict (ADD | UPDATE | NOOP | NEEDS_REVIEW). */
  classification?: ConsolidationClassification | null;
  /** Pre-computed promotion target kind. 'update_page' is the consolidation UPDATE mode. */
  target_kind?: 'existing_page' | 'inbox' | 'update_page' | null;
  /** Pre-computed promotion target path (the resolved `<slug>.md` repo path for update_page). */
  target_path?: string | null;
  /** The UPDATE timeline line. Classifier output → strip()'d at the write boundary. */
  timeline_entry?: string | null;
  /** sha256 of the compiled-truth gbrain merged against (the UPDATE staleness guard, KTD8).
   *  A structural hash — persisted verbatim, NOT strip()'d. */
  base_compiled_hash?: string | null;
  /** Candidate status override. NOOP lands 'rejected' (off the pending queue). Default 'pending'. */
  status?: 'pending' | 'accepted' | 'rejected';
  /** Status reason. NOOP sets 'NOOP'. strip()'d. Default null. */
  status_reason?: string | null;
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
  // 'update_page' (U6) is the consolidation UPDATE receiver mode.
  target_kind: 'existing_page' | 'inbox' | 'update_page' | null;
  target_path: string | null;
  promotion_status: 'pr_opened' | 'indexed' | 'promoted_to_inbox' | 'needs_fix' | 'failed' | null;
  promotion_pr_url: string | null;
  promotion_branch: string | null;
  promoted_at: Date | null;
  artifact_hash: string | null;
  // Memory Consolidation Engine (U6 columns / U3 writer) — pre-computed UPDATE
  // target + audit. All nullable; a non-consolidation row reads null.
  base_compiled_hash: string | null;
  timeline_entry: string | null;
  classification: ConsolidationClassification | null;
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
  // 'id' / 'proposed_at' are DB-generated; the promotion-DISPATCH columns are
  // written later (at approval) by approveCandidate / the promotion bridge, never
  // by the connector INSERT — they default to NULL here. The pre-computed
  // promotion TARGET (target_kind/target_path) + the consolidation columns
  // (classification/timeline_entry/base_compiled_hash) ARE writable at land time
  // by the U3 consolidation path; they stay NULL on a non-consolidation candidate.
  | 'id'
  | 'proposed_at'
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
    status: item.status ?? 'pending',
    status_reason: item.status_reason != null ? strip(item.status_reason) : null,
    acted_by: null,
    acted_at: null,
    superseded_by: null,
    // Memory Consolidation Engine (U3): the pre-computed promotion target. All
    // NULL on a non-consolidation candidate (byte-identical to today's passthrough).
    // proposed_markdown (above) already carries strip() — so an UPDATE merged_body
    // routed through item.proposed_markdown is redacted here too. timeline_entry IS
    // classifier output → strip()'d like the body. target_path (a repo path) and
    // base_compiled_hash (a sha256 hex) are STRUCTURAL — persisted verbatim, never
    // strip()'d (strip could corrupt the path or the hash the receiver compares).
    target_kind: item.target_kind ?? null,
    target_path: item.target_path ?? null,
    classification: item.classification ?? null,
    timeline_entry: item.timeline_entry != null ? strip(item.timeline_entry) : null,
    base_compiled_hash: item.base_compiled_hash ?? null,
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
  //  $18  target_kind        TEXT     — U3 consolidation: pre-computed target (else NULL)
  //  $19  target_path        TEXT
  //  $20  classification     TEXT
  //  $21  timeline_entry     TEXT
  //  $22  base_compiled_hash TEXT
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
    candidate.target_kind,          // $18
    candidate.target_path,          // $19
    candidate.classification,       // $20
    candidate.timeline_entry,       // $21
    candidate.base_compiled_hash,   // $22
  ];

  const insertSql = `
    INSERT INTO connector_candidates (
      source_id, source_record_id, version,
      source_record_ids,
      provider, proposed_slug, proposed_markdown,
      confidence,
      redactions,
      expires_at, as_of, rationale_ref,
      status, status_reason, acted_by, acted_at, superseded_by,
      target_kind, target_path, classification, timeline_entry, base_compiled_hash
    ) VALUES (
      $1, $2, $3,
      $4::text[],
      $5, $6, $7,
      $8,
      $9::jsonb,
      $10, $11, $12,
      $13, $14, $15, $16, $17,
      $18, $19, $20, $21, $22
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
  // Memory Consolidation Engine (U6 columns / U3 writer)
  'base_compiled_hash', 'timeline_entry', 'classification',
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

  // Self-cleaning queue (U3): an expired candidate never lists, even before the
  // sweep hard-deletes it. NULL `expires_at` (legacy / non-consolidation rows) always
  // lists (back-compat). Applied to BOTH the row and the count query below via the
  // shared `where`, so the two never skew ("shows 5, returns 3").
  const filters: string[] = ['c.status = $1', '(c.expires_at IS NULL OR c.expires_at > now())'];
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
 * Self-cleaning sweep (U3 / KTD3): hard-delete every EXPIRED candidate that is not
 * `accepted`, so the `connector_candidates` table stays bounded across polls. Returns
 * the number of rows removed.
 *
 *  - `expires_at < now()` only — NULL `expires_at` (legacy / non-consolidation rows)
 *    is never swept (the comparison is NULL → not TRUE).
 *  - `status <> 'accepted'` is the load-bearing guard: an accepted candidate may have
 *    an in-flight or merged promotion PR (promotion_status='pr_opened'/'indexed'), so
 *    it MUST survive expiry — its promotion bridge owns its lifecycle, not the TTL.
 *
 * Idempotent: a second run with nothing newly expired deletes 0. Safe to call every
 * poll. `RETURNING id` makes the count engine-portable (Postgres + PGLite) rather than
 * relying on a driver-specific rowCount.
 */
export async function sweepExpiredCandidates(engine: BrainEngine): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(
    `DELETE FROM connector_candidates
      WHERE expires_at IS NOT NULL AND expires_at < now() AND status <> 'accepted'
      RETURNING id`,
    [],
  );
  return rows.length;
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
 *  - update_page (the machine consolidation UPDATE) REQUIRES a non-empty target_path, a
 *    non-empty base_compiled_hash (the KTD8 staleness guard the receiver compares HEAD's
 *    compiled-truth against — a missing hash would make the receiver fail closed / inert), AND
 *    a non-empty timeline_entry — the receiver rejects an empty body/timeline_entry for
 *    update_page (promote_candidate.py), so fail closed HERE rather than dispatch a doomed
 *    artifact. (The body lives on the row, not the target, so approveCandidate guards it.)
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
  if (target.kind === 'update_page') {
    // A machine-pre-computed UPDATE: the receiver's KTD8 staleness guard needs BOTH a concrete
    // target page AND the compiled-truth hash gbrain merged against. Reject either missing —
    // an empty hash would route every UPDATE to NEEDS_REVIEW (feature-inert), an empty path
    // has no page to rewrite.
    if (!path.trim()) {
      throw new PromotionTargetError('update_page target requires a non-empty target_path');
    }
    if (!(target.base_compiled_hash ?? '').trim()) {
      throw new PromotionTargetError('update_page target requires a non-empty base_compiled_hash');
    }
    // Mirror the receiver's update_page guard (promote_candidate.py): an empty timeline_entry
    // would be rejected receiver-side, so reject it at approve and never dispatch.
    if (!(target.timeline_entry ?? '').trim()) {
      throw new PromotionTargetError('update_page target requires a non-empty timeline_entry');
    }
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

/**
 * Derive the canonical inbox path the Brain bridge requires. The Brain receiver enforces
 * `inbox/YYYY-MM-DD-<slug>.md` (slug in [a-z0-9-]) and REJECTS an empty target.path, so a
 * default inbox approval (reviewer picks 'inbox' with no path) must arrive with a concrete,
 * safe path. We derive it from the candidate's date (as_of, else proposed_at) + a sanitized
 * proposed_slug so the persisted target_path AND the HMAC-signed artifact carry the same
 * canonical value. existing_page, or an inbox target already pathed by the reviewer, is
 * returned unchanged.
 */
export function resolveInboxTarget(
  candidate: ConnectorCandidateRow,
  target: PromotionTarget,
): PromotionTarget {
  if (target.kind !== 'inbox' || (target.path ?? '').trim() !== '') return target;
  return { kind: 'inbox', path: `inbox/${inboxDate(candidate)}-${inboxSlug(candidate)}.md` };
}

/**
 * A guaranteed `YYYY-MM-DD` string for the inbox path (as_of, else proposed_at). Guards BOTH
 * NaN dates AND valid-but-extreme dates whose toISOString() emits the expanded-year form
 * (`+275760-09-13`, `-271821-...`) — those slice to a non-`\d{4}-\d{2}-\d{2}` prefix the Brain
 * receiver REJECTS, re-introducing the very silent-no-PR failure this fix kills. Falls back to
 * the epoch as a last resort so the derived path is ALWAYS receiver-valid, never blocking.
 */
function inboxDate(candidate: ConnectorCandidateRow): string {
  const ymd = (value: Date | string | null): string | null => {
    if (value == null) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    const s = d.toISOString().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  };
  return ymd(candidate.as_of) ?? ymd(candidate.proposed_at) ?? '1970-01-01';
}

/**
 * Sanitize a candidate into the receiver's [a-z0-9-] inbox slug charset: lowercase, collapse
 * any run of non-alphanumerics to a single '-', trim leading/trailing '-', cap length. Falls
 * back to a stable `<provider>-<id>` slug when proposed_slug is null/empty/all-punctuation.
 */
function inboxSlug(candidate: ConnectorCandidateRow): string {
  const sanitize = (s: string): string =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/g, '');
  const slug = sanitize(candidate.proposed_slug ?? '');
  if (slug) return slug;
  const fallback = sanitize(`${candidate.provider ?? 'connector'}-${candidate.id}`);
  return fallback || `connector-${candidate.id}`;
}

export interface ApproveResult {
  /** The accepted row, or null when the id was not pending (not-found / already acted). */
  row: ConnectorCandidateRow | null;
  /** Whether a promotion bridge ran, and its outcome. `pending` = accepted but not yet
   *  promoted (no hook, or the bridge threw) — retriable, never lost. */
  promotion: { invoked: boolean; pending?: boolean; prUrl?: string; error?: string };
}

/**
 * Approve a PENDING candidate, honoring a MACHINE-pre-computed consolidation UPDATE target when
 * the stored row carries one (U4) and otherwise the reviewer-selected target.
 *
 * Order:
 *  1. Read the CURRENT row FIRST — its `classification` / `target_kind` decide whether this is
 *     a machine consolidation UPDATE (target sourced FROM the row) or a reviewer-driven
 *     candidate (target from the request).
 *  2. Compute the EFFECTIVE target. A consolidation UPDATE row (classification set AND
 *     target_kind='update_page') carries the full pre-computed target — kind/path/
 *     timeline_entry/base_compiled_hash all come from the STORED ROW, never the reviewer HTTP
 *     request (a reviewer cannot drive update_page). Everything else — reviewer approvals, and
 *     consolidation ADD/NEEDS_REVIEW rows that carry NO stored target (target_kind=null) — keeps
 *     today's behavior (resolveInboxTarget defaults a bare inbox path).
 *  3. Validate the EFFECTIVE target (NOT the reviewer's) before any write — for a consolidation
 *     UPDATE the reviewer target is empty/irrelevant, so validating IT would wrongly throw. Also
 *     fail closed on a malformed stored UPDATE (empty proposed_markdown body) so a doomed
 *     artifact is never dispatched (the receiver would reject an empty update_page body).
 *  4. Build the artifact_hash from the CURRENT row + effective target (read-only, pre-UPDATE).
 *  5. ONE UPDATE sets status='accepted' + actor/time + artifact_hash, guarded by
 *     status='pending' (idempotency: a duplicate approve hits 0 rows). A reviewer-driven
 *     approval ALSO persists the chosen target_kind/target_path; a consolidation UPDATE does
 *     NOT touch them — the classifier already set target_kind='update_page' + target_path at
 *     land time and they must NOT be clobbered.
 *  6. Hand the accepted row + effective target to the promotion hook. A hook failure leaves the
 *     row accepted-pending (retriable) — never throws out of approve, never marks promoted.
 *
 * A non-pending id (not found / already acted) returns { row: null }.
 */
export async function approveCandidate(
  engine: BrainEngine,
  id: number,
  actor: string,
  target: PromotionTarget,
): Promise<ApproveResult> {
  // 1. Read the current row FIRST — its classification/target_kind drive the target decision
  //    and the artifact hash. If it is not pending, the accept UPDATE below no-ops anyway.
  const [current] = await engine.executeRaw<ConnectorCandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS} FROM connector_candidates WHERE id = $1`,
    [id],
  );

  // 2. Honor a machine-pre-computed consolidation UPDATE target straight from the stored row.
  //    Only an UPDATE row carries a complete target (target_kind='update_page' + path +
  //    timeline_entry + base_compiled_hash); ADD/NEEDS_REVIEW rows have target_kind=null and
  //    stay reviewer-driven. resolveInboxTarget defaults a bare reviewer inbox path to the
  //    canonical inbox/YYYY-MM-DD-<slug>.md the Brain bridge REQUIRES.
  const honorStored =
    current != null && current.classification != null && current.target_kind === 'update_page';
  const effectiveTarget: PromotionTarget = honorStored
    ? {
        kind: 'update_page',
        path: current.target_path ?? '',
        timeline_entry: current.timeline_entry ?? undefined,
        base_compiled_hash: current.base_compiled_hash ?? undefined,
      }
    : current
      ? resolveInboxTarget(current, target)
      : target;

  // 3. Validate the EFFECTIVE (row-sourced or reviewer) target before any write.
  validatePromotionTarget(effectiveTarget);

  // 3b. For a consolidation UPDATE the artifact body = row.proposed_markdown (the merged
  //     compiled-truth), which is NOT carried on the target — so validatePromotionTarget can't
  //     see it. The receiver rejects an empty body for update_page (promote_candidate.py), so
  //     fail closed HERE (PromotionTargetError → 400, never dispatched) rather than emit a
  //     doomed artifact that only bounces back as a receiver-side failed callback.
  if (honorStored && !(current?.proposed_markdown ?? '').trim()) {
    throw new PromotionTargetError(
      'update_page candidate has an empty proposed_markdown (the merged compiled-truth body)',
    );
  }

  // 4. Compute the artifact hash off the current row + effective target (read-only).
  let hash: string | null = null;
  if (current) {
    const artifact = buildPromotionArtifact(current, effectiveTarget);
    const canonical = canonicalizeArtifactForSigning(artifact);
    hash = artifactHash(canonical);
  }

  // 5. Accept UPDATE, guarded by status='pending' for idempotency. A consolidation UPDATE row
  //    keeps its classifier-set target_kind/target_path (do NOT clobber the 'update_page' the
  //    classifier wrote at land time); a reviewer-driven row persists the chosen target.
  const rows = honorStored
    ? await engine.executeRaw<ConnectorCandidateRow>(
        `UPDATE connector_candidates
            SET status = 'accepted', acted_by = $2, acted_at = now(), artifact_hash = $3
          WHERE id = $1 AND status = 'pending'
          RETURNING ${CANDIDATE_COLUMNS}`,
        [id, strip(actor), hash],
      )
    : await engine.executeRaw<ConnectorCandidateRow>(
        `UPDATE connector_candidates
            SET status = 'accepted', acted_by = $2, acted_at = now(),
                target_kind = $3, target_path = $4, artifact_hash = $5
          WHERE id = $1 AND status = 'pending'
          RETURNING ${CANDIDATE_COLUMNS}`,
        [id, strip(actor), effectiveTarget.kind, effectiveTarget.path || null, hash],
      );
  const row = rows[0] ? coerceCandidateRow(rows[0]) : null;
  if (!row) return { row: null, promotion: { invoked: false } };

  // 4. Hand to the promotion hook (build → sign → emit → reflect). Failure stays retriable.
  const hook = getPromotionHook();
  if (!hook) return { row, promotion: { invoked: false, pending: true } };
  try {
    const result = await hook(engine, row, actor, effectiveTarget);
    return { row, promotion: { invoked: true, prUrl: result.prUrl } };
  } catch (err) {
    // Bridge failure: the row stays 'accepted' (already committed) — retriable, never lost.
    return { row, promotion: { invoked: false, pending: true, error: err instanceof Error ? err.message : String(err) } };
  }
}
