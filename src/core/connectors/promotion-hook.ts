/**
 * promotion-hook.ts — wires the inert TECH-2109 promotion bridge into the candidate
 * approval seam (registerPromotionHook). Importing this module (via registry.ts) registers
 * a PromotionHook that, on approval, does:
 *
 *     build (buildPromotionArtifact)
 *   → canonicalize (canonicalizeArtifactForSigning)
 *   → sign (signArtifact, hex HMAC keyed by PROMOTION_HMAC_SECRET)
 *   → emit (emitRepositoryDispatch → repository_dispatch to techtris-brain)
 *   → reflect (updateCandidatePromotionState: promotion_status='pr_opened')
 *
 * Failure semantics (AC5): a dispatch/emit failure throws OUT of the hook. approveCandidate
 * catches it and leaves the candidate `accepted` with NO promotion_status (retriable). The
 * hook NEVER marks the candidate promoted on failure and NEVER swallows the error into a
 * "promoted" state.
 *
 * INERT seam (AC5): registering this hook performs NO live dispatch by itself. The real
 * POST only happens when a candidate is approved AND the secret + token are configured.
 * Tests inject a fake fetch via makePromotionHook({ fetchFn }) and never fire a real
 * repository_dispatch.
 *
 * LOGGING DISCIPLINE (AC7): PROMOTION_HMAC_SECRET, the signature, and the full artifact are
 * NEVER logged. The hook logs only candidate_id / provider / target_kind / artifact_hash.
 */

import type { BrainEngine } from '../engine.ts';
import type { ConnectorCandidateRow } from './candidate.ts';
import { registerPromotionHook, type PromotionHook } from './candidate.ts';
import {
  buildPromotionArtifact,
  canonicalizeArtifactForSigning,
  signArtifact,
  emitRepositoryDispatch,
  updateCandidatePromotionState,
  type PromotionTarget,
  type FetchFn,
} from './promotion.ts';

/** Env var holding the HMAC secret shared with the Brain bridge. NEVER logged. */
export const PROMOTION_HMAC_SECRET_ENV = 'PROMOTION_HMAC_SECRET';
/** Env var holding the GitHub token authorizing the repository_dispatch. NEVER logged. */
export const PROMOTION_GITHUB_TOKEN_ENV = 'GBRAIN_PROMOTE_GITHUB_TOKEN';

export interface PromotionHookDeps {
  /** Resolve the HMAC secret. Defaults to process.env[PROMOTION_HMAC_SECRET]. */
  getSecret?: () => string | undefined;
  /** Resolve the GitHub token. Defaults to process.env[GBRAIN_PROMOTE_GITHUB_TOKEN]. */
  getGithubToken?: () => string | undefined;
  /** Injected fetch (tests pass a fake; production uses global fetch). */
  fetchFn?: FetchFn;
  /** Target repo override (tests). Defaults to the Brain repo inside emitRepositoryDispatch. */
  repo?: string;
}

/**
 * A redaction-safe log line for the promotion hook. ONLY the four allowlisted fields ever
 * appear — never the secret, signature, or full artifact.
 */
function logPromotion(event: string, row: ConnectorCandidateRow): void {
  // eslint-disable-next-line no-console
  console.log(
    `[promotion] ${event} candidate_id=${row.id} provider=${row.provider ?? 'unknown'} ` +
      `target_kind=${row.target_kind ?? 'unknown'} artifact_hash=${row.artifact_hash ?? 'none'}`,
  );
}

/**
 * Build a PromotionHook bound to the given deps. Pure factory — registering the returned
 * hook is inert; the live dispatch only fires on a real approval with a configured secret +
 * token.
 */
export function makePromotionHook(deps: PromotionHookDeps = {}): PromotionHook {
  const getSecret = deps.getSecret ?? (() => process.env[PROMOTION_HMAC_SECRET_ENV]);
  const getGithubToken = deps.getGithubToken ?? (() => process.env[PROMOTION_GITHUB_TOKEN_ENV]);

  return async (
    engine: BrainEngine,
    candidate: ConnectorCandidateRow,
    _actor: string,
    target: PromotionTarget,
  ): Promise<{ prUrl?: string }> => {
    const secret = getSecret();
    const githubToken = getGithubToken();
    if (!secret) throw new Error(`${PROMOTION_HMAC_SECRET_ENV} is not set — cannot sign promotion artifact`);
    if (!githubToken) throw new Error(`${PROMOTION_GITHUB_TOKEN_ENV} is not set — cannot emit repository_dispatch`);

    // build → canonicalize → sign
    const artifact = buildPromotionArtifact(candidate, target);
    const canonical = canonicalizeArtifactForSigning(artifact);
    const signature = signArtifact(canonical, secret);

    // emit (throws on non-2xx → approveCandidate leaves the row accepted-pending, retriable)
    await emitRepositoryDispatch({
      canonical,
      signature,
      githubToken,
      repo: deps.repo,
      fetchFn: deps.fetchFn,
    });
    logPromotion('dispatched', candidate);

    // reflect: a successful dispatch means the Brain bridge will open a PR. We record
    // 'pr_opened' as the optimistic post-dispatch state; the Brain reflects the terminal
    // pr_url/branch/indexed back via its callback (a separate path).
    await updateCandidatePromotionState(engine, candidate.id, { promotion_status: 'pr_opened' });

    return {};
  };
}

/**
 * Startup registration seam (mirrors registry.ts side-effect imports). Registers the
 * env-backed promotion hook so candidate approvals dispatch to the Brain. Idempotent: a
 * second call replaces the registered hook.
 */
export function registerDefaultPromotionHook(deps: PromotionHookDeps = {}): void {
  registerPromotionHook(makePromotionHook(deps));
}
