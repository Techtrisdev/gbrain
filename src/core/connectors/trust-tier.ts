/**
 * trust-tier.ts - default-off, fail-closed auto-approval for connector candidates.
 *
 * This module only decides whether a freshly-landed candidate is safe enough to
 * reuse the existing approval path. It never opens PRs directly and never changes
 * approveCandidate's semantics; the promotion bridge remains the single PR path.
 */

import type { BrainEngine } from '../engine.ts';
import {
  approveCandidate,
  type ApproveResult,
  type ConnectorCandidateRow,
} from './candidate.ts';
import { connectorAutomationDisabled } from './poll.ts';
import type { PromotionTarget } from './promotion.ts';

export type TrustDecision = 'auto_approve' | 'human';

export const AUTO_APPROVE_MIN_CONFIDENCE = 0.9;

// Maximally conservative initial allow-list. Operators may tune this in a later
// policy layer, but the code default intentionally limits auto-approval to docs.
export const AUTO_APPROVE_ALLOWED_PATH_PREFIXES = ['docs/', 'playbooks/'] as const;

export const AUTO_PROMOTE_ENABLED_KEY = 'connectors.auto_promote_enabled';
export const AUTO_PROMOTE_ACTOR = 'connector:auto-promote';

type TrustRelevantCandidateRow = Pick<
  ConnectorCandidateRow,
  'status' | 'classification' | 'confidence' | 'target_path' | 'target_kind' | 'rationale_ref' | 'redactions'
>;

const AUTO_APPROVE_DENIED_PATH_PREFIXES = [
  'clients/',
  'people/',
  'projects/',
  'integrations/',
  'decisions/',
  'handoffs/',
  'inbox/',
  'contracts/',
  '.github/',
  'scripts/',
  'schema.md',
  'RESOLVER.md',
  'CLAUDE.md',
  'AGENTS.md',
  'CODEOWNERS',
  'llms.txt',
] as const;

type ApproveCandidateFn = (
  engine: BrainEngine,
  id: number,
  actor: string,
  target: PromotionTarget,
) => Promise<ApproveResult>;

let approveCandidateForTrustTier: ApproveCandidateFn = approveCandidate;

/** Test seam only. Keeps maybeAutoApprove unit tests off the real promotion bridge. */
export function __setApproveCandidateForTests(fn: ApproveCandidateFn | null): void {
  approveCandidateForTrustTier = fn ?? approveCandidate;
}

export function trustTierDecision(
  row: Pick<
    ConnectorCandidateRow,
    'classification' | 'confidence' | 'target_path' | 'rationale_ref' | 'redactions' | 'target_kind'
  >,
): TrustDecision {
  try {
    // The promotion receiver now supports new_page (create a new content page).
    // A high-confidence ADD with a safe, non-sensitive target path, a rationale,
    // and no redactions can auto-approve — the receiver re-checks novelty at
    // promotion time (fails closed if the page already exists) and the PR is
    // the human review gate (the bridge never auto-merges).
    if (row.classification === 'ADD') {
      if (typeof row.confidence !== 'number') return 'human';
      if (!Number.isFinite(row.confidence) || row.confidence < AUTO_APPROVE_MIN_CONFIDENCE) {
        return 'human';
      }
      // target_kind is null for ADD rows (the ADD target is a NEW page, not a
      // pre-computed update). Accept null or new_page; anything else is a
      // contradiction (an ADD can't be an existing_page/update_page target).
      if (row.target_kind !== null && row.target_kind !== 'new_page') return 'human';
      if (!isPresentString(row.rationale_ref)) return 'human';
      if (hasRedactions(row.redactions)) return 'human';
      if (!isPresentString(row.target_path)) return 'human';
      if (!isSafeAutoApprovePath(row.target_path)) return 'human';
      return 'auto_approve';
    }

    if (row.classification !== 'UPDATE' && row.classification !== 'NEEDS_REVIEW' && row.classification !== 'NOOP') {
      return 'human';
    }
    // UPDATE / NEEDS_REVIEW / NOOP are never auto-approved — the tier
    // exists for a future explicit allowlist. Fail closed.
    return 'human';
  } catch {
    return 'human';
  }
}

export async function autoPromoteEnabled(engine: BrainEngine): Promise<boolean> {
  try {
    const raw = await engine.getConfig(AUTO_PROMOTE_ENABLED_KEY);
    if (raw == null) return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === 'true' || normalized === '1';
  } catch (err) {
    console.error(
      `[connector] auto-promote config read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

export async function maybeAutoApprove(engine: BrainEngine, row: ConnectorCandidateRow): Promise<boolean> {
  try {
    if (row.status !== 'pending') return false;
    if (!(await autoPromoteEnabled(engine))) return false;
    if (trustTierDecision(row) !== 'auto_approve') return false;

    const sourceConfig = await readSourceConfig(engine, row.source_id);
    if (sourceConfig.missing) return false;
    if (connectorAutomationDisabled({ config: sourceConfig.config as never })) return false;

    const id = Number(row.id);
    if (!Number.isSafeInteger(id)) return false;

    const freshRow = await readCurrentTrustRelevantRow(engine, id);
    if (!freshRow) return false;
    if (freshRow.status !== 'pending') return false;
    if (trustTierDecision(freshRow) !== 'auto_approve') return false;

    // This re-validation closes the stale in-memory-row TOCTOU. approveCandidate
    // intentionally re-reads by id, so the residual gap is two adjacent reads
    // before the guarded UPDATE, acceptable for this default-off fail-closed path.
    // Route the promotion target by classification: an ADD proposes a NEW page
    // → the receiver's new_page mode (which re-checks novelty + opens a PR);
    // everything else stays on the historical existing_page path.
    const target: PromotionTarget =
      freshRow.classification === 'ADD'
        ? { kind: 'new_page', path: freshRow.target_path ?? '' }
        : { kind: 'existing_page', path: freshRow.target_path ?? '' };
    const result = await approveCandidateForTrustTier(engine, id, AUTO_PROMOTE_ACTOR, target);
    return result.row !== null;
  } catch (err) {
    const id = safeCandidateId(row);
    console.error(
      `[connector] trust-tier auto-approve failed for candidate ${id}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

function isPresentString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasRedactions(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value != null && Boolean(value);
}

function isSafeAutoApprovePath(path: string): boolean {
  if (path !== path.trim()) return false;
  if (!AUTO_APPROVE_ALLOWED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (AUTO_APPROVE_DENIED_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  if (path.includes('\x00') || path.includes('\\')) return false;
  if (path.startsWith('/') || path.startsWith('~')) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path)) return false;
  for (const segment of path.split('/')) {
    if (segment === '' || segment.startsWith('.')) return false;
  }
  return true;
}

async function readCurrentTrustRelevantRow(
  engine: BrainEngine,
  id: number,
): Promise<TrustRelevantCandidateRow | null> {
  try {
    const rows = await engine.executeRaw<TrustRelevantCandidateRow>(
      `SELECT status, classification, confidence, target_path, target_kind, rationale_ref, redactions
         FROM connector_candidates WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function readSourceConfig(
  engine: BrainEngine,
  sourceId: string,
): Promise<{ missing: true; config: null } | { missing: false; config: unknown }> {
  if (!isPresentString(sourceId)) return { missing: true, config: null };
  const rows = await engine.executeRaw<{ config: unknown }>(
    `SELECT config FROM sources WHERE id = $1`,
    [sourceId],
  );
  if (!rows[0]) return { missing: true, config: null };
  return { missing: false, config: rows[0].config ?? null };
}

function safeCandidateId(row: ConnectorCandidateRow): string {
  try {
    return String(row.id ?? 'unknown');
  } catch {
    return 'unknown';
  }
}
