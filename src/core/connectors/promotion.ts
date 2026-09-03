/**
 * promotion.ts — the gbrain (review) side of the TECH-2037 v1 connector→Brain
 * promotion bridge (TECH-2109).
 *
 * At candidate approval a reviewer selects a promotion target. gbrain then builds a
 * MINIMIZED, HMAC-signed approval artifact and emits it to techtris-brain via a GitHub
 * `repository_dispatch` (event_type `connector-promotion`). gbrain NEVER validates,
 * renders, or opens a PR itself — that is the already-merged Brain bridge
 * (scripts/check_promote.py / .github/workflows/promote.yml). gbrain ONLY: persists the
 * target (in approveCandidate), builds + signs + emits the artifact, and receives signed
 * lifecycle callbacks without ever treating dispatch acceptance as PR or index proof.
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
 *    redaction_attestation, target. `target` is MODE-DEPENDENT (the Brain's validate_artifact
 *    is mode-aware): inbox/existing_page/new_page carry EXACTLY 4 keys (mode, path, timeline_entry,
 *    body); update_page carries EXACTLY 5 (those + base_compiled_hash, the KTD8 compiled-truth
 *    staleness hash — REQUIRED iff update_page, FORBIDDEN otherwise). base_compiled_hash is
 *    OMITTED (never null) for the 4-key modes — JSON.stringify drops an absent key but KEEPS a
 *    null, so a null would land in the receiver's t_unknown and reject. gbrain does NOT compute
 *    the PR branch (the Brain derives it).
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
import type {
  PromotionCallbackMetadata,
  PromotionLifecycleState,
} from './promotion-state.ts';
import { hmacSha256Verify } from './base.ts';
import { strip } from './redact.ts';
import { mintAppJwt } from './github-app-jwt.ts';

// ── The locked artifact shape ────────────────────────────────────────────────────

/**
 * The promotion target. `existing_page`/`inbox` are reviewer-selected; `update_page` is the
 * MACHINE-pre-computed Memory-Consolidation UPDATE target — its `path`, `timeline_entry`, and
 * `base_compiled_hash` are sourced from the stored candidate row at approve time (U4), NEVER
 * from the reviewer HTTP request. `new_page` is the machine auto-approve target for a safe
 * high-confidence ADD (receiver creates a new draft page). `existing_page`, `new_page`, and
 * `update_page` all require a non-empty path; `update_page` ALSO requires a non-empty
 * `base_compiled_hash` (KTD8 staleness guard).
 */
export interface PromotionTarget {
  kind: 'existing_page' | 'inbox' | 'update_page' | 'new_page';
  /** The target path (validated server-side in approveCandidate). For update_page this is the
   *  classifier-resolved `<slug>.md` content path carried from the row. For new_page it is the
   *  classifier's proposed NEW-page path. */
  path: string;
  /** update_page ONLY: the classifier's real dated timeline line (carried from the row). */
  timeline_entry?: string;
  /** update_page ONLY: sha256 of the compiled-truth gbrain merged against (KTD8 staleness
   *  guard). A structural hash — emitted verbatim, never strip()'d. */
  base_compiled_hash?: string;
}

/**
 * The artifact's `target` object. MODE-DEPENDENT key set (matches the Brain's mode-aware
 * TARGET_SCHEMA): inbox/existing_page/new_page carry EXACTLY {mode, path, timeline_entry, body}
 * (4 keys); update_page carries those + `base_compiled_hash` (5 keys). `base_compiled_hash` is
 * present ONLY for update_page and OMITTED (never null) otherwise.
 */
export interface PromotionArtifactTarget {
  mode: 'existing_page' | 'inbox' | 'update_page' | 'new_page';
  path: string;
  timeline_entry: string;
  body: string;
  /** update_page ONLY (the KTD8 compiled-truth staleness hash). Omitted for the 4-key modes. */
  base_compiled_hash?: string;
}

/** Legacy minimized approval artifact. The Brain dual-reader keeps accepting it
 * while already-dispatched candidates drain. */
export interface PromotionArtifactV1 {
  provider: string;
  source_id: string;
  source_record_id: string;
  redaction_attestation: string;
  target: PromotionArtifactTarget;
}

/** Generation-aware artifact. The correlation remains the identity through
 * Brain branch, PR, frontmatter, reindex proof, and callback acknowledgement. */
export interface PromotionArtifactV2 extends PromotionArtifactV1 {
  schema_version: 2;
  correlation_id: string;
}

export type PromotionArtifact = PromotionArtifactV1 | PromotionArtifactV2;

/** The redaction attestation string stamped on every artifact. */
export const REDACTION_ATTESTATION = 'redact.ts:v1 strip() applied; no secrets/PII detected';

/** The fixed Brain repo + event_type the dispatch targets. */
export const BRAIN_DISPATCH_REPO = 'Techtrisdev/techtris-brain';
export const PROMOTION_EVENT_TYPE = 'connector-promotion';

// ── Build ─────────────────────────────────────────────────────────────────────────

/**
 * Build the minimized artifact from a candidate row + effective target.
 *
 * Minimization: the artifact carries NO candidate body beyond `target.body` /
 * `target.timeline_entry`. Both of those run through the existing strip() redaction at
 * THIS write boundary (defense in depth — proposed_markdown was already stripped at
 * toRow, but the artifact is a fresh egress surface to an external repo).
 *
 * MODE-DEPENDENT shape (U4): for inbox/existing_page/new_page the `target` is the historical 4-key
 * object with a HARDCODED provenance `timeline_entry`. For `update_page` (the machine
 * consolidation UPDATE) the `target` carries the classifier's REAL dated `timeline_entry`
 * (from the effective target, which approveCandidate sourced from the stored row) plus a 5th
 * key `base_compiled_hash` — added by CONDITIONAL SPREAD so the key is OMITTED (not null) for
 * the 4-key modes (JSON.stringify drops an absent key but keeps a null, which the receiver's
 * mode-aware schema would reject as an unknown key). `base_compiled_hash` is NOT strip()'d: a
 * sha256 hex is structural and strip() could corrupt the byte-for-byte value the receiver
 * compares.
 *
 * source_record_id is the FULL id — never hashed here (the Brain hashes it for the branch
 * + PR body; gbrain hands over the real id so the Brain can detect idempotent reuse).
 *
 * The PR branch is NOT included — the Brain derives it from (provider, source_id,
 * source_record_id). Pure; no I/O.
 */
export function buildPromotionArtifact(
  row: Pick<ConnectorCandidateRow, 'provider' | 'source_id' | 'source_record_id' | 'proposed_markdown'>
    & Partial<Pick<ConnectorCandidateRow, 'id' | 'context_generation'>>,
  target: PromotionTarget,
): PromotionArtifact {
  const isUpdate = target.kind === 'update_page';
  const candidateId = Number(row.id);
  const generation = Number(row.context_generation);
  const generationAware = Number.isSafeInteger(candidateId) && candidateId > 0
    && Number.isSafeInteger(generation) && generation > 0;
  return {
    ...(generationAware
      ? { schema_version: 2 as const, correlation_id: `cm-promo-v2-c${candidateId}-g${generation}` }
      : {}),
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
      // timeline_entry: for update_page, the classifier's real dated line (carried on the
      // effective target from the row); for inbox/existing_page, the hardcoded provenance
      // note. Redacted at this boundary (idempotent — the row line was stripped at toRow).
      timeline_entry: isUpdate
        ? strip(target.timeline_entry ?? '')
        : strip(`Promoted from connector candidate ${row.source_record_id} (${row.provider ?? 'unknown'}).`),
      // body: the candidate's proposed markdown (already stripped at toRow; re-stripped
      // here because strip() is idempotent and the artifact is a fresh external egress).
      body: strip(row.proposed_markdown ?? ''),
      // base_compiled_hash: present ONLY for update_page (KTD8). CONDITIONAL SPREAD so the key
      // is OMITTED (not null) for the 4-key modes. NOT strip()'d (structural sha256 hex).
      ...(isUpdate ? { base_compiled_hash: target.base_compiled_hash ?? '' } : {}),
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
type GitHubFetchResponse = { ok: boolean; status: number; text: () => Promise<string> };

export type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<GitHubFetchResponse>;

/** Every GitHub API request is bounded so a stuck socket cannot strand a promotion attempt. */
const PROMOTION_GITHUB_REQUEST_TIMEOUT_MS = 15_000;

function githubRequestTimeoutMs(override: number | undefined): number {
  const timeoutMs = override ?? PROMOTION_GITHUB_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('promotion GitHub request timeout must be a positive integer');
  }
  return timeoutMs;
}

async function fetchGitHubWithTimeout<
  TInit extends {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
>(
  doFetch: (url: string, init: TInit) => Promise<GitHubFetchResponse>,
  url: string,
  init: Omit<TInit, 'signal'>,
  timeoutMs: number,
): Promise<GitHubFetchResponse> {
  const controller = new AbortController();
  const timeoutError = new Error(`promotion GitHub request timeout after ${timeoutMs}ms`);
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      doFetch(url, { ...init, signal: controller.signal } as TInit),
      timeout,
    ]);
  } catch (error) {
    // Fetch implementations vary in the AbortError they surface. Keep the durable
    // failure taxonomy stable whenever our own deadline fired.
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  /** Per-request deadline override (tests). Production defaults to 15 seconds. */
  timeoutMs?: number;
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

  const res = await fetchGitHubWithTimeout(doFetch, url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${opts.githubToken}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'content-type': 'application/json',
      'user-agent': 'gbrain-connector-promotion',
    },
    body,
  }, githubRequestTimeoutMs(opts.timeoutMs));

  if (!res.ok) {
    // The response body MAY echo nothing sensitive, but to be safe we do not include the
    // artifact/signature in the error — only the status.
    throw new Error(`repository_dispatch failed: status=${res.status}`);
  }
  return { ok: true, status: res.status };
}

// ── GitHub App dispatch-token minting (A3 Path 2) ──────────────────────────────────────
//
// The repository_dispatch Bearer can be EITHER a static GBRAIN_PROMOTE_GITHUB_TOKEN
// (back-compat) OR a short-lived GitHub App INSTALLATION token minted on demand from the same
// App the github_kb connector uses (GBRAIN_GITHUB_APP_ID + GBRAIN_GITHUB_APP_PRIVATE_KEY).
// Reuses github-app-jwt.ts::mintAppJwt (pure RS256 crypto leaf — NOT github.ts, which would
// pull the connector module's registerConnector side effect into the boot graph); the
// installation-id resolve + token exchange use an injectable fetch so tests need no real
// network / key / installation. The
// private key, the App JWT, and the minted token are NEVER logged.

/** Env: the GitHub App credentials (shared with github_kb) + an optional installation-id override. */
export const PROMOTION_APP_ID_ENV = 'GBRAIN_GITHUB_APP_ID';
export const PROMOTION_APP_PRIVATE_KEY_ENV = 'GBRAIN_GITHUB_APP_PRIVATE_KEY';
export const PROMOTION_INSTALLATION_ID_ENV = 'GBRAIN_PROMOTE_GITHUB_INSTALLATION_ID';

/** Injectable fetch for App-auth HTTP (GET resolve; POST exchange carries a scoped JSON body). Tests pass a fake. */
export type AppAuthFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<GitHubFetchResponse>;

interface CachedInstallToken {
  token: string;
  expiresAtMs: number;
}
/** Installation tokens last ~1h; refresh this far before expiry. */
const INSTALL_TOKEN_SKEW_MS = 60_000;
/** Installation-token cache (module-level), keyed by repo — a hit skips the JWT mint + both HTTP calls. */
const promotionInstallTokenCache = new Map<string, CachedInstallToken>();

export interface DispatchTokenDeps {
  /** Env reader (tests inject). Defaults to process.env. */
  getEnv?: (key: string) => string | undefined;
  /** Injected fetch for the App-auth HTTP. Defaults to global fetch. */
  fetchImpl?: AppAuthFetch;
  /** Clock (tests inject). Defaults to Date.now. */
  now?: () => number;
  /** Per-request deadline override (tests). Production defaults to 15 seconds. */
  timeoutMs?: number;
}

const appAuthHeaders = (appJwt: string): Record<string, string> => ({
  authorization: `Bearer ${appJwt}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'gbrain-connector-promotion',
});

/**
 * Resolve the App installation id for `repo`: an explicit env override if set, else
 * `GET /repos/{repo}/installation` authenticated as the App (JWT). Throws loud on a non-2xx
 * (e.g. the App is not installed on the repo) so a misconfig surfaces rather than minting
 * against the wrong installation.
 */
async function resolveInstallationId(
  repo: string,
  appJwt: string,
  doFetch: AppAuthFetch,
  getEnv: (key: string) => string | undefined,
  timeoutMs: number,
): Promise<string> {
  const override = getEnv(PROMOTION_INSTALLATION_ID_ENV);
  if (override && override.trim()) return override.trim();
  const res = await fetchGitHubWithTimeout(doFetch, `https://api.github.com/repos/${repo}/installation`, {
    method: 'GET',
    headers: appAuthHeaders(appJwt),
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`resolve App installation for ${repo} failed: status=${res.status} (is the App installed with contents:write?)`);
  }
  const id = (JSON.parse(await res.text()) as { id?: number }).id;
  if (id === undefined || id === null) throw new Error(`resolve App installation for ${repo}: response missing id`);
  return String(id);
}

/**
 * Mint (or reuse a cached) short-lived GitHub App INSTALLATION token authorizing
 * repository_dispatch on `repo`. Reuses github-app-jwt.ts::mintAppJwt (9-min RS256 App JWT), resolves
 * the installation id, then exchanges the JWT for a ~1h installation token (cached by
 * installation id, refreshed before expiry). NEVER logs the key / JWT / token.
 */
export async function getPromotionDispatchToken(
  repo: string = BRAIN_DISPATCH_REPO,
  deps: DispatchTokenDeps = {},
): Promise<string> {
  const getEnv = deps.getEnv ?? ((key: string) => process.env[key]);
  const doFetch = deps.fetchImpl ?? (globalThis.fetch as unknown as AppAuthFetch);
  const nowMs = deps.now ?? (() => Date.now());
  const timeoutMs = githubRequestTimeoutMs(deps.timeoutMs);

  // Cache check first (keyed by repo) — a hit skips the JWT mint + both App-auth HTTP calls.
  const cached = promotionInstallTokenCache.get(repo);
  if (cached && cached.expiresAtMs - nowMs() > INSTALL_TOKEN_SKEW_MS) return cached.token;

  const privateKey = getEnv(PROMOTION_APP_PRIVATE_KEY_ENV);
  const appId = getEnv(PROMOTION_APP_ID_ENV);
  if (!privateKey) throw new Error(`${PROMOTION_APP_PRIVATE_KEY_ENV} is not set (GitHub App private key, PKCS#8 PEM)`);
  if (!appId) throw new Error(`${PROMOTION_APP_ID_ENV} is not set (GitHub App id)`);

  const appJwt = mintAppJwt(privateKey, appId);
  const installationId = await resolveInstallationId(repo, appJwt, doFetch, getEnv, timeoutMs);

  // Scope the installation token to JUST the target repo + the minimum permission needed.
  // repository_dispatch (POST /repos/{owner}/{repo}/dispatches) requires Contents: write per
  // GitHub's fine-grained-PAT permission table — nothing narrower is accepted. Omitting
  // `repositories`/`permissions` would mint a token carrying ALL of the installation's repos
  // and permissions, far too broad for this single-purpose dispatch credential. The
  // `repositories` field takes bare repo NAMES (not owner/name); slice handles a bare name too.
  const repoName = repo.slice(repo.lastIndexOf('/') + 1);
  const tokenRequestBody = JSON.stringify({
    repositories: [repoName],
    permissions: { contents: 'write' },
  });
  const res = await fetchGitHubWithTimeout(
    doFetch,
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: { ...appAuthHeaders(appJwt), 'content-type': 'application/json' },
      body: tokenRequestBody,
    },
    timeoutMs,
  );
  if (!res.ok) throw new Error(`App installation token exchange failed: status=${res.status}`);
  const json = JSON.parse(await res.text()) as { token?: string; expires_at?: string };
  if (!json.token) throw new Error('App installation token exchange: response missing token');
  const parsedExpiry = json.expires_at ? Date.parse(json.expires_at) : NaN;
  const minted: CachedInstallToken = {
    token: json.token,
    expiresAtMs: Number.isNaN(parsedExpiry) ? nowMs() + 50 * 60 * 1000 : parsedExpiry,
  };
  promotionInstallTokenCache.set(repo, minted);
  return minted.token;
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
  'base_compiled_hash', 'timeline_entry', 'classification',
  'context_session_id', 'context_generation', 'context_partition', 'correlation_id',
  'requires_human_review', 'evidence_trust', 'review_warning', 'proposed_at',
].join(', ');

// ════════════════════════════════════════════════════════════════════════════════════
// Promotion STATUS CALLBACK (TECH-2110) — the inbound machine endpoint
// ════════════════════════════════════════════════════════════════════════════════════
//
// DUAL-READER CONTRACT — legacy Brain callbacks remain valid while the generation-aware
// callback identity rolls out after this receiver is deployed.
//
// The TECH-2110 ticket spec'd an inbound wire of
//   { candidate_id, artifact_hash, …, signed_at, nonce }  +  header X-Promotion-Signature
//   + artifact_hash ownership  +  nonce/clock-skew replay protection.
// That is WRONG. The authoritative sender is the merged techtris-brain bridge (PR #101,
// its `emit_status`), which actually sends:
//   - Header:    X-Brain-Signature  (NOT X-Promotion-Signature)
//   - Signature: lowercase hex HMAC-SHA256 over the RAW request body bytes, keyed by
//                PROMOTION_HMAC_SECRET. The Brain signs json.dumps(payload, sort_keys=True)
//                .encode() and sends those EXACT bytes, so we MUST verify over the raw bytes
//                as received — never re-serialize first (re-serialization changes the bytes
//                and breaks the HMAC).
//   - Body:      EXACTLY { status, branch, pr_url, source_record_id_hash } — no candidate_id,
//                no artifact_hash, no nonce, no signed_at, no target_*, no reason.
//   - status in  EXACTLY { "opened", "failed", "indexed" } - the statuses the Brain emits.
//   - Identity:  source_record_id_hash = sha256(source_record_id).hexdigest()[:16] — the
//                Brain's only candidate identifier on the wire (there is no candidate_id).
//
// gbrain therefore matches the MERGED reality: ownership is by source_record_id_hash, and
// replay-safety rests on IDEMPOTENCY (re-applying the same writeback is a no-op) because the
// Brain sends no nonce/timestamp to support the ticket's skew-window replay model.
//
// STATUS MAPPING (load-bearing): not every wire `status` is a valid promotion_status CHECK
// value. We map:  "opened" -> 'pr_opened' (+ store pr_url + branch, stamp promoted_at),
//                 "indexed" -> 'indexed',
//                 "failed" -> 'failed' (status_* only; the candidate STAYS status='accepted',
//                            never 'rejected').
//
// SECURITY: verify-before-parse. A forged/missing/garbage signature → 401 with ZERO DB
// writes and the body NEVER parsed or logged. A missing secret → 500 fail-closed (no write).
// LOGGING (AC7): the secret, the signature, and the full body are NEVER logged; only `status`,
// `source_record_id_hash` (already a hash — safe), and the matched candidate id.

/** The wire statuses the merged Brain bridge emits. */
export type PromotionCallbackWireStatus = 'opened' | 'failed' | 'indexed';

/** The EXACT 4-key body the merged Brain `emit_status` sends. */
export interface PromotionCallbackBody {
  status: PromotionCallbackWireStatus;
  branch: string;
  pr_url: string;
  source_record_id_hash: string;
}

/** The 4 keys the body must carry — used to reject BOTH missing and unknown keys. */
const PROMOTION_CALLBACK_KEYS: readonly string[] = ['branch', 'pr_url', 'source_record_id_hash', 'status'];

/** Generation-aware callback contract. The Brain sender moves to this only after this reader ships. */
export type PromotionCallbackV2Status =
  | 'opened'
  | 'dispatch_failed'
  | 'merged'
  | 'indexing_failed'
  | 'indexed';

interface PromotionCallbackBodyV2Base {
  schema_version: 2;
  correlation_id: string;
  branch?: string;
  pr_url?: string;
  merge_sha?: string;
  workflow_run_id?: string;
  failure_code?: string;
}

/** V2 callbacks carry the durable evidence required by their lifecycle stage. */
export type PromotionCallbackBodyV2 = PromotionCallbackBodyV2Base & (
  | { status: 'opened'; branch: string; pr_url: string; failure_code?: never }
  | { status: 'dispatch_failed'; failure_code: string }
  | { status: 'merged'; merge_sha: string; workflow_run_id: string; failure_code?: never }
  | { status: 'indexing_failed'; merge_sha: string; workflow_run_id: string; failure_code: string }
  | { status: 'indexed'; merge_sha: string; workflow_run_id: string; failure_code?: never }
);

const PROMOTION_CALLBACK_V2_KEYS = new Set([
  'schema_version', 'correlation_id', 'status', 'branch', 'pr_url',
  'merge_sha', 'workflow_run_id', 'failure_code',
]);
const PROMOTION_CALLBACK_V2_STATUSES = new Set<PromotionCallbackV2Status>([
  'opened', 'dispatch_failed', 'merged', 'indexing_failed', 'indexed',
]);
const CALLBACK_FAILURE_CODES = new Set([
  'brain_reported_dispatch_failure',
  'brain_reported_indexing_failure',
  'dispatch_workflow_failed',
  'promotion_validation_failed',
  'pr_creation_failed',
  'reindex_workflow_failed',
  'indexed_callback_failed',
  'retrieval_proof_failed',
]);

/** Discriminated result the Express wrapper maps to an HTTP response. */
export type PromotionCallbackResult =
  | { ok: true; status: 200; candidateId: number; mappedStatus: PromotionLifecycleState; outcome: 'applied' | 'stale' }
  | { ok: false; status: 400 | 401 | 404 | 409 | 500; error: string };

/**
 * The 16-char identity the Brain puts on the wire:
 *   first 16 lowercase hex chars of sha256(source_record_id).
 * Mirrors the Brain's `_sha256_hex(source_record_id.encode())[:16]`.
 */
export function sourceRecordIdHash16(sourceRecordId: string): string {
  return createHash('sha256').update(sourceRecordId, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Strictly validate the parsed JSON body: it must be a plain object carrying EXACTLY the 4
 * keys (no missing, no extra), each of the right type, with status in {opened, failed, indexed}.
 * Returns the typed body or null (caller → 400). Pure; no I/O.
 */
function parsePromotionCallbackBody(parsed: unknown): PromotionCallbackBody | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  // Reject missing OR unknown keys: the key set must be EXACTLY the 4 expected keys.
  const keys = Object.keys(obj).sort();
  if (keys.length !== PROMOTION_CALLBACK_KEYS.length) return null;
  for (let i = 0; i < PROMOTION_CALLBACK_KEYS.length; i++) {
    if (keys[i] !== PROMOTION_CALLBACK_KEYS[i]) return null;
  }

  const { status, branch, pr_url, source_record_id_hash } = obj;
  if (status !== 'opened' && status !== 'failed' && status !== 'indexed') return null;
  if (typeof branch !== 'string') return null;
  if (typeof pr_url !== 'string') return null;
  if (typeof source_record_id_hash !== 'string' || source_record_id_hash.length === 0) return null;

  return { status, branch, pr_url, source_record_id_hash };
}

function optionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0 && value.length <= max);
}

function parsePromotionCallbackBodyV2(parsed: unknown): PromotionCallbackBodyV2 | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).some((key) => !PROMOTION_CALLBACK_V2_KEYS.has(key))) return null;
  if (obj.schema_version !== 2) return null;
  if (typeof obj.correlation_id !== 'string' || !/^cm-promo-v2-c[1-9]\d*-g\d+$/.test(obj.correlation_id)) return null;
  if (typeof obj.status !== 'string' || !PROMOTION_CALLBACK_V2_STATUSES.has(obj.status as PromotionCallbackV2Status)) return null;
  if (!optionalBoundedString(obj.branch, 255) || !optionalBoundedString(obj.pr_url, 2_048)) return null;
  if (!optionalBoundedString(obj.workflow_run_id, 64) || !optionalBoundedString(obj.failure_code, 80)) return null;
  if (obj.merge_sha !== undefined && (typeof obj.merge_sha !== 'string' || !/^[0-9a-f]{40}$/.test(obj.merge_sha))) return null;
  if (obj.failure_code !== undefined && !CALLBACK_FAILURE_CODES.has(obj.failure_code as string)) return null;
  if (obj.status === 'opened' && (obj.branch === undefined || obj.pr_url === undefined)) return null;
  if (
    (obj.status === 'merged' || obj.status === 'indexing_failed' || obj.status === 'indexed')
    && (obj.merge_sha === undefined || obj.workflow_run_id === undefined)
  ) return null;
  if ((obj.status === 'dispatch_failed' || obj.status === 'indexing_failed') && obj.failure_code === undefined) return null;
  if ((obj.status === 'opened' || obj.status === 'merged' || obj.status === 'indexed') && obj.failure_code !== undefined) return null;
  return obj as unknown as PromotionCallbackBodyV2;
}

function callbackState(status: PromotionCallbackWireStatus | PromotionCallbackV2Status): PromotionLifecycleState {
  if (status === 'opened') return 'pr_opened';
  if (status === 'failed' || status === 'dispatch_failed') return 'dispatch_failed';
  if (status === 'merged') return 'merged_reindexing';
  if (status === 'indexing_failed') return 'indexing_failed';
  return 'indexed';
}

function callbackMetadata(
  body: PromotionCallbackBody | PromotionCallbackBodyV2,
): PromotionCallbackMetadata {
  if ('schema_version' in body) {
    return {
      branch: body.branch,
      prUrl: body.pr_url,
      mergeSha: body.merge_sha,
      workflowRunId: body.workflow_run_id,
      failureCode: body.failure_code,
    };
  }
  return {
    branch: body.branch || undefined,
    prUrl: body.pr_url || undefined,
    failureCode: body.status === 'failed' ? 'brain_reported_dispatch_failure' : undefined,
  };
}

/**
 * Among the dispatched-and-awaiting-callback set (status='accepted' AND artifact_hash IS NOT
 * NULL), return ALL candidates whose source_record_id hashes to the wire identity.
 *
 * The SELECT predicate (not a SQL hash match) is deliberate: the Brain sends only the 16-char
 * hash, and we scope the comparison to the rows that were actually dispatched, recomputing the
 * hash in TS. The caller FAILS CLOSED on >1 (it never picks a row): the merged Brain callback
 * body carries no source_id/provider/candidate_id/artifact_hash, so gbrain cannot safely
 * disambiguate multiple accepted candidates sharing a source_record_id hash — and a write path
 * must never guess which row to mutate.
 */
async function matchCandidatesByHash(
  engine: BrainEngine,
  hash16: string,
): Promise<ConnectorCandidateRow[]> {
  const rows = await engine.executeRaw<ConnectorCandidateRow>(
    `SELECT ${CANDIDATE_PROMOTION_RETURNING}
       FROM connector_candidates
      WHERE status = 'accepted' AND artifact_hash IS NOT NULL`,
  );
  return rows.filter((r) => sourceRecordIdHash16(r.source_record_id) === hash16);
}

/**
 * Handle a promotion status callback. ALL I/O is the injected `engine`; the raw body Buffer
 * and the X-Brain-Signature header value are passed in — there is no Express/network coupling
 * here, so the handler is driven directly in tests with a real engine + a synthetically signed
 * body. NEVER throws for an expected rejection (forged sig / bad body / no match): it returns a
 * typed result the wrapper maps to a status code. An unexpected engine error → 500.
 *
 * Order is load-bearing:
 *   1. secret present?            no → 500 (fail-closed), no parse, no write.
 *   2. hmacSha256Verify(raw)?     no → 401, body NEVER parsed/logged, no write.
 *   3. JSON.parse + strict legacy-or-v2 shape validation → bad → 400, no write.
 *   4. legacy hash identity fails closed on ambiguity; v2 correlation identity is exact.
 *   5. apply a monotonic lifecycle transition and audit stale/out-of-order callbacks.
 */
export async function handlePromotionCallback(args: {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  secret: string | undefined;
  engine: BrainEngine;
}): Promise<PromotionCallbackResult> {
  const { rawBody, signatureHeader, secret, engine } = args;

  // (1) Missing secret → fail closed. Do not parse, do not write.
  if (!secret) {
    console.error('promotion callback: PROMOTION_HMAC_SECRET is not configured — failing closed');
    return { ok: false, status: 500, error: 'callback_secret_unconfigured' };
  }

  // (2) Verify-before-parse over the RAW bytes. A forged/missing/garbage signature ends here:
  //     the body is never parsed and never logged. hmacSha256Verify is constant-time and
  //     returns false for a missing/empty/non-hex signature.
  if (!hmacSha256Verify(rawBody, secret, signatureHeader ?? '')) {
    // Do NOT log the signature or any body content.
    console.warn('promotion callback: signature verification failed — rejecting before parse');
    return { ok: false, status: 401, error: 'signature_mismatch' };
  }

  // (3) Parse + strictly validate the 4-key body.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, status: 400, error: 'malformed_json' };
  }
  const legacyBody = parsePromotionCallbackBody(parsed);
  const v2Body = parsePromotionCallbackBodyV2(parsed);
  if (!legacyBody && !v2Body) {
    return { ok: false, status: 400, error: 'invalid_body' };
  }

  const { applyPromotionCallbackTransition } = await import('./promotion-state.ts');
  if (v2Body) {
    try {
      const result = await applyPromotionCallbackTransition(
        engine,
        v2Body.correlation_id,
        callbackState(v2Body.status),
        callbackMetadata(v2Body),
      );
      if (!result) return { ok: false, status: 404, error: 'candidate_not_found' };
      console.log(`promotion callback: applied status=${v2Body.status} correlation_id=${v2Body.correlation_id}`);
      return {
        ok: true,
        status: 200,
        candidateId: result.candidateId,
        mappedStatus: result.state,
        outcome: result.outcome,
      };
    } catch (err) {
      console.error('promotion callback: writeback failed:', err instanceof Error ? err.message : String(err));
      return { ok: false, status: 500, error: 'writeback_failed' };
    }
  }
  const body = legacyBody!;

  // (4) Match by source_record_id_hash among the dispatched set. Fail CLOSED on ambiguity:
  //     0 → 404; exactly 1 → proceed; >1 → 409 with ZERO writes. The Brain callback carries no
  //     source_id/provider/candidate_id/artifact_hash, so we cannot disambiguate and must never
  //     guess which row to mutate.
  let matches: ConnectorCandidateRow[];
  try {
    matches = await matchCandidatesByHash(engine, body.source_record_id_hash);
  } catch (err) {
    console.error('promotion callback: candidate lookup failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, status: 500, error: 'lookup_failed' };
  }
  if (matches.length === 0) {
    // source_record_id_hash is already a hash — safe to log.
    console.warn(`promotion callback: no dispatched candidate matched source_record_id_hash=${body.source_record_id_hash}`);
    return { ok: false, status: 404, error: 'candidate_not_found' };
  }
  if (matches.length > 1) {
    console.warn(
      `promotion callback: ambiguous source_record_id_hash=${body.source_record_id_hash} matched ${matches.length} dispatched candidates — refusing with zero writes`,
    );
    return { ok: false, status: 409, error: 'ambiguous_candidate_match' };
  }
  const candidate = matches[0];

  // Legacy identity can be ambiguous, but once exactly one candidate is found it enters the
  // same monotonic lifecycle as v2. A late signed `opened` may advance a dispatch failure;
  // no callback can regress an already indexed transition.
  try {
    const { ensurePromotionTransition } = await import('./promotion-state.ts');
    const transition = await ensurePromotionTransition(engine, candidate);
    const result = await applyPromotionCallbackTransition(
      engine,
      transition.correlation_id,
      callbackState(body.status),
      callbackMetadata(body),
    );
    if (!result) return { ok: false, status: 404, error: 'candidate_not_found' };
    // AC7 logging: status, source_record_id_hash (safe), and the matched candidate id ONLY.
    console.log(
      `promotion callback: applied status=${body.status} source_record_id_hash=${body.source_record_id_hash} candidate_id=${candidate.id}`,
    );
    return {
      ok: true,
      status: 200,
      candidateId: result.candidateId,
      mappedStatus: result.state,
      outcome: result.outcome,
    };
  } catch (err) {
    console.error('promotion callback: writeback failed:', err instanceof Error ? err.message : String(err));
    return { ok: false, status: 500, error: 'writeback_failed' };
  }
}
