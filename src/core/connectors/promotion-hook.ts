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
  getPromotionDispatchToken,
  BRAIN_DISPATCH_REPO,
  PROMOTION_APP_ID_ENV,
  PROMOTION_APP_PRIVATE_KEY_ENV,
  type PromotionTarget,
  type FetchFn,
  type AppAuthFetch,
} from './promotion.ts';

/** Env var holding the HMAC secret shared with the Brain bridge. NEVER logged. */
export const PROMOTION_HMAC_SECRET_ENV = 'PROMOTION_HMAC_SECRET';
/** Env var holding the GitHub token authorizing the repository_dispatch. NEVER logged. */
export const PROMOTION_GITHUB_TOKEN_ENV = 'GBRAIN_PROMOTE_GITHUB_TOKEN';

export interface PromotionHookDeps {
  /** Resolve the HMAC secret. Defaults to process.env[PROMOTION_HMAC_SECRET]. */
  getSecret?: () => string | undefined;
  /**
   * @deprecated A STATIC dispatch token. Kept for back-compat; when set (or
   * GBRAIN_PROMOTE_GITHUB_TOKEN is in env) it takes precedence over App-token minting.
   */
  getGithubToken?: () => string | undefined;
  /**
   * Full async dispatch-token resolver override (tests). When unset, a default resolver is
   * built: static token → GitHub App installation token → throw.
   */
  getToken?: () => Promise<string>;
  /** Injected App-auth fetch for the default App-token resolver's HTTP (tests). */
  dispatchTokenFetch?: AppAuthFetch;
  /** Env reader for the default token resolver (tests). Defaults to process.env. */
  getEnv?: (key: string) => string | undefined;
  /** Injected fetch (tests pass a fake; production uses global fetch). */
  fetchFn?: FetchFn;
  /** Target repo override (tests). Defaults to the Brain repo inside emitRepositoryDispatch. */
  repo?: string;
}

/**
 * Default dispatch-token resolver (A3 Path 2). Precedence:
 *   1. an explicit static token (`deps.getGithubToken` or `GBRAIN_PROMOTE_GITHUB_TOKEN`) — back-compat;
 *   2. else, if the GitHub App creds are set (`GBRAIN_GITHUB_APP_ID` + `GBRAIN_GITHUB_APP_PRIVATE_KEY`),
 *      mint a short-lived installation token for the Brain repo;
 *   3. else throw → approveCandidate leaves the candidate accepted-pending (retriable).
 * NEVER logs the token / key / JWT.
 */
function makeDefaultTokenResolver(
  deps: PromotionHookDeps,
  getEnv: (key: string) => string | undefined,
): () => Promise<string> {
  return async (): Promise<string> => {
    const staticToken = deps.getGithubToken ? deps.getGithubToken() : getEnv(PROMOTION_GITHUB_TOKEN_ENV);
    if (staticToken) return staticToken;
    const appId = getEnv(PROMOTION_APP_ID_ENV);
    const appKey = getEnv(PROMOTION_APP_PRIVATE_KEY_ENV);
    if (appId && appKey) {
      return getPromotionDispatchToken(deps.repo ?? BRAIN_DISPATCH_REPO, {
        getEnv,
        fetchImpl: deps.dispatchTokenFetch,
      });
    }
    throw new Error(
      `no dispatch credential — set ${PROMOTION_GITHUB_TOKEN_ENV}, or ${PROMOTION_APP_ID_ENV} + ${PROMOTION_APP_PRIVATE_KEY_ENV} (GitHub App)`,
    );
  };
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
  const getEnv = deps.getEnv ?? ((key: string) => process.env[key]);
  const getToken = deps.getToken ?? makeDefaultTokenResolver(deps, getEnv);

  return async (
    engine: BrainEngine,
    candidate: ConnectorCandidateRow,
    _actor: string,
    target: PromotionTarget,
  ): Promise<{ prUrl?: string }> => {
    const secret = getSecret();
    if (!secret) throw new Error(`${PROMOTION_HMAC_SECRET_ENV} is not set — cannot sign promotion artifact`);

    // build → canonicalize → sign
    const artifact = buildPromotionArtifact(candidate, target);
    const canonical = canonicalizeArtifactForSigning(artifact);
    const signature = signArtifact(canonical, secret);

    // Resolve the dispatch Bearer: a static token, else a minted GitHub App installation token.
    // Throws (caught by approveCandidate → accepted-pending, retriable) when no credential is set.
    const githubToken = await getToken();

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
