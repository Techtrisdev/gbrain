/**
 * promotion.ts — the gbrain (review) side of the TECH-2037 v1 connector→Brain
 * promotion bridge (TECH-2109).
 *
 * At candidate approval a reviewer selects a promotion target. gbrain then builds a
 * MINIMIZED, HMAC-signed approval artifact and emits it to techtris-brain via a GitHub
 * `repository_dispatch` (event_type `connector-promotion`). gbrain NEVER validates,
 * renders, or opens a PR itself — that is the already-merged Brain bridge
 * (scripts/check_promote.py / .github/workflows/promote.yml). gbrain ONLY: persists the
 * target (in approveCandidate), builds + signs + emits the artifact, and reflects the
 * dispatch state back onto the candidate row.
 *
 * THE LOCKED CONTRACT (the Brain bridge is merged — match it byte-for-byte):
 *  - The Brain verifies hmac.new(secret, artifact_bytes, sha256) over the RAW delivered
 *    artifact bytes, accepting a HEX signature first (base64url fallback), constant-time.
 *  - The Brain workflow extracts the artifact via
 *        parsed = json.loads(toJSON(client_payload.artifact))
 *        if isinstance(parsed, str): bytes = parsed.encode()
 *    Therefore the artifact MUST travel as an OPAQUE canonical JSON STRING in
 *    client_payload.artifact (NOT a nested object — a nested object would be re-serialized
 *    by GitHub/Python and break the HMAC).
 *  - client_payload.signature = lowercase HEX HMAC-SHA256 of those exact string bytes,
 *    keyed by PROMOTION_HMAC_SECRET (utf-8 bytes).
 *  - The artifact has EXACTLY 5 top-level keys (the Brain's validate_artifact fails closed
 *    on BOTH missing and unknown keys): provider, source_id, source_record_id,
 *    redaction_attestation, target. target has EXACTLY 4 keys: mode, path, timeline_entry,
 *    body. gbrain does NOT compute the PR branch (the Brain derives it).
 *  - canonicalizeArtifactForSigning is deterministic: sorted keys (recursively), no
 *    insignificant whitespace, so the same artifact always yields the same bytes.
 *    artifact_hash (stored, idempotency) = lowercase hex sha256 of that canonical string.
 *
 * LOGGING DISCIPLINE (AC7): PROMOTION_HMAC_SECRET, the signature, and the full artifact
 * are NEVER logged. Logs may carry only candidate_id / provider / target_kind /
 * artifact_hash.
 */

import { createHash, createHmac } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';
import type { ConnectorCandidateRow } from './candidate.ts';
import { strip } from './redact.ts';

// ── The locked artifact shape ────────────────────────────────────────────────────

/** Reviewer-selected promotion target. `existing_page` requires a non-empty path. */
export interface PromotionTarget {
  kind: 'existing_page' | 'inbox';
  /** The reviewer-selected target path (validated server-side in approveCandidate). */
  path: string;
}

/** The artifact's `target` object — EXACTLY these 4 keys (Brain TARGET_SCHEMA). */
export interface PromotionArtifactTarget {
  mode: 'existing_page' | 'inbox';
  path: string;
  timeline_entry: string;
  body: string;
}

/** The minimized approval artifact — EXACTLY these 5 keys (Brain ARTIFACT_SCHEMA). */
export interface PromotionArtifact {
  provider: string;
  source_id: string;
  source_record_id: string;
  redaction_attestation: string;
  target: PromotionArtifactTarget;
}

/** The redaction attestation string stamped on every artifact. */
export const REDACTION_ATTESTATION = 'redact.ts:v1 strip() applied; no secrets/PII detected';

/** The fixed Brain repo + event_type the dispatch targets. */
export const BRAIN_DISPATCH_REPO = 'Techtrisdev/techtris-brain';
export const PROMOTION_EVENT_TYPE = 'connector-promotion';

// ── Build ─────────────────────────────────────────────────────────────────────────

/**
 * Build the minimized 5-key artifact from a candidate row + reviewer target.
 *
 * Minimization: the artifact carries NO candidate body beyond `target.body` /
 * `target.timeline_entry`. Both of those run through the existing strip() redaction at
 * THIS write boundary (defense in depth — proposed_markdown was already stripped at
 * toRow, but the artifact is a fresh egress surface to an external repo).
 *
 * source_record_id is the FULL id — never hashed here (the Brain hashes it for the branch
 * + PR body; gbrain hands over the real id so the Brain can detect idempotent reuse).
 *
 * The PR branch is NOT included — the Brain derives it from (provider, source_id,
 * source_record_id). Pure; no I/O.
 */
export function buildPromotionArtifact(
  row: Pick<ConnectorCandidateRow, 'provider' | 'source_id' | 'source_record_id' | 'proposed_markdown'>,
  target: PromotionTarget,
): PromotionArtifact {
  return {
    provider: row.provider ?? '',
    source_id: row.source_id,
    source_record_id: row.source_record_id,
    redaction_attestation: REDACTION_ATTESTATION,
    target: {
      mode: target.kind,
      // path: NOT run through strip() — by design. A target path is STRUCTURAL, not free
      // text: approveCandidate's validatePromotionTarget has already rejected anything
      // non-canonical (whitespace, absolute, backslash, URL scheme, empty or dot-prefixed
      // segment), so what reaches here is a clean relative content path. strip() is for
      // PII/secrets in page-body content; running it on a path could corrupt a valid slug.
      path: target.path,
      // timeline_entry: a one-line provenance note, redacted at this boundary.
      timeline_entry: strip(`Promoted from connector candidate ${row.source_record_id} (${row.provider ?? 'unknown'}).`),
      // body: the candidate's proposed markdown (already stripped at toRow; re-stripped
      // here because strip() is idempotent and the artifact is a fresh external egress).
      body: strip(row.proposed_markdown ?? ''),
    },
  };
}

// ── Canonicalize + sign ─────────────────────────────────────────────────────────────

/**
 * Recursively sort object keys so serialization is deterministic regardless of input key
 * order. Arrays keep order (positional). Primitives pass through. This is the gbrain-side
 * mirror of the Brain's json.loads → byte-compare: the SAME logical artifact must always
 * produce the SAME bytes so artifact_hash is a stable idempotency key.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Serialize the artifact to a deterministic canonical JSON STRING: sorted keys
 * (recursively) and no insignificant whitespace (JSON.stringify default — no spaces).
 * This is the EXACT string that travels in client_payload.artifact AND the exact bytes
 * the HMAC + artifact_hash are computed over.
 */
export function canonicalizeArtifactForSigning(artifact: PromotionArtifact): string {
  return JSON.stringify(sortKeysDeep(artifact));
}

/**
 * Lowercase hex HMAC-SHA256 of the canonical string bytes, keyed by `secret` (utf-8
 * bytes). The Brain accepts hex first, so we emit hex. node:crypto digest('hex') is
 * already lowercase.
 */
export function signArtifact(canonical: string, secret: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}

/** Lowercase hex sha256 of the canonical string — the stored idempotency key. */
export function artifactHash(canonical: string): string {
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ── Emit (repository_dispatch) ──────────────────────────────────────────────────────

/** Minimal fetch shape so tests inject a fake (no real network). Mirrors global fetch. */
export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface EmitDispatchOpts {
  /** The canonical artifact STRING (opaque — not re-serialized). */
  canonical: string;
  /** The lowercase hex HMAC signature of `canonical`. */
  signature: string;
  /** GitHub token (Bearer) authorizing the repository_dispatch. */
  githubToken: string;
  /** Target repo slug; defaults to the Brain repo. */
  repo?: string;
  /** Injected fetch (tests pass a fake; production uses global fetch). */
  fetchFn?: FetchFn;
}

export interface EmitDispatchResult {
  ok: boolean;
  status: number;
}

/**
 * POST a `connector-promotion` repository_dispatch to the Brain repo.
 *
 * client_payload.artifact is the OPAQUE canonical STRING (NOT a nested object) so the
 * Brain's `json.loads(toJSON(artifact))` → `isinstance(str)` → `.encode()` path recovers
 * the exact signed bytes. A nested object would be re-serialized by GitHub/Python and
 * break the HMAC — that is the load-bearing reason for the string.
 *
 * Throws on a non-2xx so the caller (the hook) can leave the candidate accepted-pending
 * (retriable). NEVER logs the artifact / signature / token.
 */
export async function emitRepositoryDispatch(opts: EmitDispatchOpts): Promise<EmitDispatchResult> {
  const repo = opts.repo ?? BRAIN_DISPATCH_REPO;
  const url = `https://api.github.com/repos/${repo}/dispatches`;
  const doFetch: FetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);

  const body = JSON.stringify({
    event_type: PROMOTION_EVENT_TYPE,
    client_payload: {
      // OPAQUE STRING — do NOT pass the parsed object here (would break the HMAC).
      artifact: opts.canonical,
      signature: opts.signature,
    },
  });

  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'gbrain-connector-promotion',
    },
    body,
  });

  if (!res.ok) {
    // The response body MAY echo nothing sensitive, but to be safe we do not include the
    // artifact/signature in the error — only the status.
    throw new Error(`repository_dispatch failed: status=${res.status}`);
  }
  return { ok: true, status: res.status };
}

// ── Reflect dispatch state back onto the candidate row ────────────────────────────────

/** The promotion_status terminal/intermediate values the Brain reflects back. */
export type PromotionStatus =
  | 'pr_opened'
  | 'indexed'
  | 'promoted_to_inbox'
  | 'needs_fix'
  | 'failed';

export interface PromotionStatePatch {
  promotion_status?: PromotionStatus;
  promotion_pr_url?: string | null;
  promotion_branch?: string | null;
  /** When set true, stamps promoted_at = now(). */
  promoted?: boolean;
}

/**
 * Allowlisted UPDATE of the promotion-state columns on one candidate row. Only the four
 * promotion-reflection columns (+ promoted_at) are writable here; the column names are a
 * fixed allowlist, never interpolated from caller input. Returns the updated row, or null
 * when the id does not exist.
 *
 * This NEVER changes `status` (the accept decision is already committed) and NEVER touches
 * target_kind / target_path / artifact_hash (those are written once, at approval).
 */
export async function updateCandidatePromotionState(
  engine: BrainEngine,
  id: number,
  patch: PromotionStatePatch,
): Promise<ConnectorCandidateRow | null> {
  const sets: string[] = [];
  const params: unknown[] = [id];

  if (patch.promotion_status !== undefined) {
    params.push(patch.promotion_status);
    sets.push(`promotion_status = $${params.length}`);
  }
  if (patch.promotion_pr_url !== undefined) {
    params.push(patch.promotion_pr_url);
    sets.push(`promotion_pr_url = $${params.length}`);
  }
  if (patch.promotion_branch !== undefined) {
    params.push(patch.promotion_branch);
    sets.push(`promotion_branch = $${params.length}`);
  }
  if (patch.promoted) {
    sets.push(`promoted_at = now()`);
  }

  if (sets.length === 0) {
    // Nothing to write — read the row back unchanged for a uniform return shape.
    const [row] = await engine.executeRaw<ConnectorCandidateRow>(
      `SELECT ${CANDIDATE_PROMOTION_RETURNING} FROM connector_candidates WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  const rows = await engine.executeRaw<ConnectorCandidateRow>(
    `UPDATE connector_candidates
        SET ${sets.join(', ')}
      WHERE id = $1
      RETURNING ${CANDIDATE_PROMOTION_RETURNING}`,
    params,
  );
  return rows[0] ?? null;
}

/**
 * The full column list for a candidate RETURNING — kept in lock-step with
 * candidate.ts::CANDIDATE_COLS. Duplicated here (rather than imported) to avoid a circular
 * import with candidate.ts; the connector-promotion test asserts the row shape so drift is
 * caught.
 */
const CANDIDATE_PROMOTION_RETURNING = [
  'id', 'source_id', 'source_record_id', 'version',
  'source_record_ids', 'provider', 'proposed_slug', 'proposed_markdown',
  'confidence', 'redactions', 'expires_at', 'as_of', 'rationale_ref',
  'status', 'status_reason', 'acted_by', 'acted_at', 'superseded_by',
  'target_kind', 'target_path', 'promotion_status', 'promotion_pr_url',
  'promotion_branch', 'promoted_at', 'artifact_hash',
  'proposed_at',
].join(', ');
