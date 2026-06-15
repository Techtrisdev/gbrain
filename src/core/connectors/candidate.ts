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
): Omit<ConnectorCandidateRow, 'id' | 'proposed_at'> {
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
    version: item.version ?? '1',
    source_record_ids: item.source_record_ids ? [...item.source_record_ids] : [],
    provider: item.provider ?? null,
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
    RETURNING
      id, source_id, source_record_id, version,
      source_record_ids, provider, proposed_slug, proposed_markdown,
      confidence, redactions,
      expires_at, as_of, rationale_ref,
      status, status_reason, acted_by, acted_at,
      superseded_by, proposed_at
  `;

  const rows = await engine.executeRaw<ConnectorCandidateRow>(insertSql, params);

  if (rows.length === 0) {
    // ON CONFLICT DO NOTHING — row already existed; fetch it for the caller.
    const fetchSql = `
      SELECT
        id, source_id, source_record_id, version,
        source_record_ids, provider, proposed_slug, proposed_markdown,
        confidence, redactions,
        expires_at, as_of, rationale_ref,
        status, status_reason, acted_by, acted_at,
        superseded_by, proposed_at
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
