/**
 * github.ts — the GitHub KNOWLEDGE SaaSConnector (TECH-2041).
 *
 * The fourth real connector, modelled on linear.ts / slack.ts / calendar.ts. It turns
 * GitHub issue / pull-request webhook deliveries (and field changes) into table-only
 * connector_candidates rows via the framework's landRecords redaction choke point —
 * NEVER pages, never a promotion. The issue/PR BODY is comms-class free prose, so it is
 * NEVER carried verbatim: the raw `body` is dropped (minimize's `body:dropped` trail) and
 * the candidate's summary is a short structural metadata line under the `code` profile
 * (title/number/state/labels/author/url — NO body).
 *
 * ── DISTINCT from the git-sync /webhooks/github route ──────────────────────────────
 *
 * gbrain ALREADY has a `/webhooks/github` route (src/commands/serve-http.ts) — the
 * Federated-Sync-v2 push path that triggers a `sync` job on a `push` event. That route is
 * OUT OF SCOPE and untouched. This connector is a SEPARATE, KNOWLEDGE-class ingestion that
 * must NOT collide with it. It registers under a DISTINCT provider key — `github_kb` — so
 * the generic /webhooks/:provider receiver routes it on `/webhooks/github_kb`, leaving
 * `/webhooks/github` (the git-sync path) completely alone. Same upstream (GitHub), two
 * routes, two purposes: git-sync vs. knowledge-candidate extraction.
 *
 * ── Auth = GitHub App installation token, NOT user OAuth ────────────────────────────
 *
 * Unlike linear/slack/calendar (which use registerOAuthProvider's user-authorize/callback
 * flow), GitHub App authentication is a DIFFERENT shape: there is no per-user grant. The
 * App mints a short-lived RS256 JWT from its private key, exchanges it for a 1-hour
 * INSTALLATION access token scoped to one installation, and uses that token for REST calls.
 * So this connector does NOT call registerOAuthProvider. Instead it mints installation
 * tokens on demand (cached by expiry) via node:crypto, from:
 *   - GBRAIN_GITHUB_APP_PRIVATE_KEY  (PKCS#8 PEM — "BEGIN PRIVATE KEY")
 *   - GBRAIN_GITHUB_APP_ID           (numeric App id)
 *   - config.connectors.github_kb.installation_id  (per-source installation id)
 * The JWT→installation-token PATTERN mirrors Forge's workers/webhook-receiver/src/
 * github-app.ts (a Cloudflare Worker using Web Crypto); here it is reimplemented with
 * node:crypto (createSign('RSA-SHA256')) for the Bun/Node runtime.
 *
 * ── Webhook auth (AC3) ──────────────────────────────────────────────────────────────
 *
 * GitHub signs the raw body with the per-source webhook secret and sends
 * `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256(secret, rawBody). verifyWebhook strips
 * the `sha256=` prefix and constant-time-compares via hmacSha256Verify (the same prefix
 * discipline the git-sync route uses — Buffer.from('sha256=...', 'hex') would silently
 * truncate at the 's'). Idempotency rests on the candidate (source_id, source_record_id,
 * version) ON CONFLICT: a replayed delivery carries the same issue/PR id → the same
 * source_record_id → a no-op insert. (No delivery-id LRU: the generic receiver hands
 * normalize the parsed JSON body, not the X-GitHub-Delivery HTTP header, so any in-body
 * delivery-id check would be inert — the content-keyed ON CONFLICT is the real guarantee.)
 *
 * ── Backfill (AC4) ──────────────────────────────────────────────────────────────────
 *
 * Incremental via `GET /repos/{owner}/{repo}/issues?since=<watermark>&state=all` (GitHub's
 * issues endpoint returns BOTH issues and PRs — a PR carries a `pull_request` field). The
 * conditional `If-None-Match: <etag>` request makes a no-change poll a cheap `304 Not
 * Modified` → no candidate landed. The watermark (newest `updated_at`) + the response ETag
 * persist to sources.config.connectors.github_kb via a surgical jsonb_set so a sibling
 * config write (secret rotation) is never clobbered.
 *
 * Tests (test/connector-github.test.ts) mock the GitHub REST API + the installation-token
 * mint — no live API, no real App key.
 */

import { createHmac } from 'node:crypto';

import {
  hmacSha256Verify,
  registerConnector,
  type SaaSConnector,
  type NormalizedRecord,
  type ConnectorSource,
} from './base.ts';
import type { ConnectorCandidateItem } from './candidate.ts';
import type { BrainEngine } from '../engine.ts';
import { mintAppJwt } from './github-app-jwt.ts';

// ── GitHub payload shapes (the subset we read) ───────────────────────────────────

/** A GitHub issue OR pull-request resource (the subset we keep). The issues REST
 *  endpoint returns both; a PR additionally carries a `pull_request` object. */
export interface GitHubIssue {
  /** Internal stable id (the idempotency anchor — survives a title/number edit). */
  id?: number;
  /** Display number within the repo. */
  number?: number;
  /** open | closed. */
  state?: string;
  title?: string;
  /** Free-form markdown — ALWAYS DROPPED (metadata-only candidate). */
  body?: string;
  /** Web URL. */
  html_url?: string;
  /** Author. */
  user?: { login?: string };
  /** Labels — names only kept structurally; NOT surfaced on the candidate (see note). */
  labels?: ({ name?: string } | string)[];
  /** Present iff this "issue" row is actually a pull request. */
  pull_request?: Record<string, unknown>;
  /** RFC3339 last-modified — the backfill watermark + dedupe stamp. */
  updated_at?: string;
  created_at?: string;
}

/** A GitHub issues/PR webhook delivery envelope. */
export interface GitHubWebhookPayload {
  /** opened | edited | closed | reopened | labeled | … */
  action?: string;
  /** Present on `issues` events. */
  issue?: GitHubIssue;
  /** Present on `pull_request` events. */
  pull_request?: GitHubIssue;
  /** The repo the event belongs to — the account anchor (full_name e.g. "acme/widgets"). */
  repository?: { full_name?: string; id?: number };
  /** App installation id — the account-anchor fallback when full_name is absent. */
  installation?: { id?: number };
}

// ── Constants ───────────────────────────────────────────────────────────────────

const PROVIDER = 'github_kb';
const SIGNATURE_HEADER = 'x-hub-signature-256'; // lowercase — Node lowercases header keys
/** GitHub's signature scheme prefix on X-Hub-Signature-256. */
const SIGNATURE_PREFIX = 'sha256=';
/** `code` source class — drops bodies, allowlists repo/number/author/state/url/labels. */
const PROFILE = 'code';
/**
 * Cap the structural summary line length (mirrors linear/slack). Bounds any residual
 * surface a holder of the per-source signing secret could smuggle through the
 * title/author fields — strip() masks regex-detectable PII/secrets; the cap bounds what
 * strip() cannot see (names/addresses/deal terms). The summary is structural (number +
 * title + state), never body-derived, so 200 is ample.
 */
const MAX_SUMMARY_LEN = 200;

/** GitHub REST API base + App-auth endpoints. */
const GITHUB_API_BASE = 'https://api.github.com';
/** Installation tokens last ~1h; we refresh REFRESH_SKEW_MS before expiry. */
const INSTALLATION_TOKEN_SKEW_MS = 60_000;
/** Issues page size for backfill. */
const BACKFILL_PAGE_SIZE = 100;
/** A required User-Agent for every GitHub API call (GitHub rejects UA-less requests). */
const USER_AGENT = 'gbrain-github-kb-connector';

/** App-auth env. The private key is PKCS#8 PEM; the App id is numeric. */
const APP_PRIVATE_KEY_ENV = 'GBRAIN_GITHUB_APP_PRIVATE_KEY';
const APP_ID_ENV = 'GBRAIN_GITHUB_APP_ID';

// ── Helpers: payload field access (defensive against unknown) ────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return '(unreadable body)';
  }
}

// ── GitHub App auth: RS256 JWT → installation access token (node:crypto) ──────────

// mintAppJwt (the RS256 App-JWT mint) and its base64url helper now live in the pure-crypto
// leaf ./github-app-jwt.ts (imported at the top of this file) so promotion.ts can reuse it
// WITHOUT importing this connector module. Importing github.ts pulls its top-level
// `registerConnector(githubConnector)` side effect into the serve boot graph; when that ran
// before base.ts initialised its `REGISTRY` map the server crashed at startup with a
// temporal-dead-zone error. Re-exported here for back-compat (test/connector-github.test.ts
// imports mintAppJwt from this module).
export { mintAppJwt };

/** A minted installation token + its absolute expiry (ms). */
interface InstallationToken {
  token: string;
  expiresAtMs: number;
}

/**
 * Exchange an App JWT for a 1-hour installation access token (POST
 * /app/installations/{id}/access_tokens). `appJwt` authenticates as the App. Pure HTTP via
 * fetch (mockable in tests). Throws loud on a non-2xx or a malformed response.
 */
export async function fetchInstallationToken(
  appJwt: string,
  installationId: string,
): Promise<InstallationToken> {
  const res = await fetch(`${GITHUB_API_BASE}/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${appJwt}`,
      accept: 'application/vnd.github+json',
      'user-agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    throw new Error(`github app token exchange ${res.status}: ${await safeText(res)}`);
  }
  const json = (await res.json()) as { token?: string; expires_at?: string };
  if (!json.token) throw new Error('github app token exchange: response missing token');
  const expiresAtMs = json.expires_at ? Date.parse(json.expires_at) : NaN;
  return {
    token: json.token,
    // Fall back to a conservative 50-minute lifetime if expires_at is absent/unparseable.
    expiresAtMs: Number.isNaN(expiresAtMs) ? Date.now() + 50 * 60 * 1000 : expiresAtMs,
  };
}

/**
 * Per-(installation) installation-token cache. Keyed by installation id so two sources on
 * the same installation share a token. Refreshed INSTALLATION_TOKEN_SKEW_MS before expiry.
 */
const installationTokenCache = new Map<string, InstallationToken>();

/**
 * Resolve a valid installation access token for the source. Reads the App private key +
 * App id from env and the per-source installation id from config.connectors.github_kb.
 * Mints on demand (cached by expiry). The `engine`/`source` signature mirrors the OAuth
 * connectors' getValidAccessToken call site so the backfill code path reads identically,
 * but GitHub App auth does NOT consult the custody module (there is no user grant).
 */
export async function getInstallationToken(source: ConnectorSource): Promise<string> {
  const installationId = readInstallationId(source);
  if (!installationId) {
    throw new Error(
      `github_kb: missing installation_id in config.connectors.github_kb for source '${source.id}'`,
    );
  }
  const cached = installationTokenCache.get(installationId);
  if (cached && cached.expiresAtMs - Date.now() > INSTALLATION_TOKEN_SKEW_MS) {
    return cached.token;
  }
  const privateKey = process.env[APP_PRIVATE_KEY_ENV];
  const appId = process.env[APP_ID_ENV];
  if (!privateKey) throw new Error(`${APP_PRIVATE_KEY_ENV} is not set (GitHub App private key, PKCS#8 PEM)`);
  if (!appId) throw new Error(`${APP_ID_ENV} is not set (GitHub App id)`);

  const jwt = mintAppJwt(privateKey, appId);
  const minted = await fetchInstallationToken(jwt, installationId);
  installationTokenCache.set(installationId, minted);
  return minted.token;
}

// ── Helpers: summary + record building ────────────────────────────────────────────

/** Whether a record is an issue or a pull request. The kind is determined by the CALLER:
 *  the webhook routing key (`issue` vs `pull_request`) for inbound, or the presence of a
 *  `pull_request` marker for a row from the issues-list endpoint (which returns both). */
type ItemKind = 'issue' | 'pr';

/** True iff an issues-list row is actually a pull request (the REST issues endpoint
 *  returns both; a PR row carries a `pull_request` object). Used for BACKFILL rows, where
 *  there is no routing key. A `pull_request` WEBHOOK object does NOT carry this marker, so
 *  normalize passes the kind explicitly rather than relying on this. */
function kindFromIssuesRow(item: GitHubIssue): ItemKind {
  return asRecord(item.pull_request) !== null ? 'pr' : 'issue';
}

/**
 * A short, structural summary line for an issue/PR. NEVER body-derived: the raw `body` is
 * dropped by minimize (and strip() does not catch the names/addresses/deal-terms a body can
 * contain — its documented v1 boundary). The title rides in as a structural label (capped);
 * strip() in the landing path masks any regex-detectable PII/secret in it.
 */
function summaryForItem(item: GitHubIssue, kind: ItemKind): string {
  const label = kind === 'pr' ? 'PR' : 'Issue';
  const number = num(item.number);
  const state = str(item.state) ?? 'unknown';
  const rawTitle = str(item.title);
  const title = rawTitle ? rawTitle.slice(0, MAX_SUMMARY_LEN) : undefined;
  const numberLabel = number !== undefined ? `#${number}` : '';
  const head = `${label} ${numberLabel} [${state}]`.replace(/\s+/g, ' ').trim();
  const line = title ? `${head}: ${title}` : head;
  return line.slice(0, MAX_SUMMARY_LEN);
}

/**
 * Build a NormalizedRecord for a single issue/PR. Shared by the inbound webhook (normalize)
 * and outbound backfill so both land an identical candidate shape. The `kind` is supplied by
 * the caller (the webhook routing key, or the issues-list `pull_request` marker). The stable
 * upstream `id` is the idempotency anchor (survives a number/title edit — number is reused
 * across repos, id is globally stable). The raw `body` is carried ONLY so minimize records
 * the `body:dropped` trail; it is ALWAYS dropped and never reaches a candidate column.
 */
function recordForItem(item: GitHubIssue, kind: ItemKind): NormalizedRecord | null {
  const id = num(item.id);
  if (id === undefined) return null;
  const sourceRecordId = `${kind}:${id}`;

  // NOTE (copied from linear/slack, deliberately): structural metadata is intentionally NOT
  // surfaced on the candidate. toCandidate emits only the redacted summary (as
  // proposed_markdown) + provider / slug / confidence — it does not pass `item.metadata`
  // through to a row. We deliberately do NOT build a metadata object here: a copycat
  // connector must not assume metadata is written, or it would inherit the unstripped-array
  // hole (minimize keeps the `code` profile's `labels` array verbatim — array elements are
  // not run through strip()). If a future ticket surfaces metadata, it MUST add per-element
  // string stripping for the labels[] array first.

  return {
    sourceRecordId,
    profile: PROFILE,
    item: {
      sourceRecordId,
      summary: summaryForItem(item, kind),
      // body is dropped by minimize; carried only for the redaction trail.
      body: str(item.body),
    },
    proposedSlug: `github-${kind}-${id}`,
  };
}

// ── The connector ────────────────────────────────────────────────────────────────

export const githubConnector: SaaSConnector = {
  provider: PROVIDER,
  signatureHeader: SIGNATURE_HEADER,

  /**
   * AC3: HMAC-SHA256 over the raw body, hex digest in `X-Hub-Signature-256` with the
   * `sha256=` scheme prefix. Strip the prefix and constant-time compare via
   * hmacSha256Verify (the framework primitive). Fail-closed on a missing header or a
   * missing/wrong prefix.
   *
   * Idempotency is NOT here (verifyWebhook is pure over rawBody + headers + secret). The
   * receiver calls normalize after a successful verify; a replayed delivery dedupes at the
   * candidate (source_id, source_record_id, version) ON CONFLICT write boundary.
   */
  verifyWebhook(rawBody, headers, secret): boolean {
    const signature = headers[SIGNATURE_HEADER];
    if (!signature) return false;
    if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
    const signatureHex = signature.slice(SIGNATURE_PREFIX.length);
    return hmacSha256Verify(rawBody, secret, signatureHex);
  },

  /**
   * AC4: resolve the account the source is mapped to — the repo `full_name`
   * (e.g. "acme/widgets"), falling back to the installation id when the repo is absent.
   * The receiver looks the source up by config.connectors.github_kb.account.
   */
  accountFromPayload(payload): string | null {
    const p = (asRecord(payload) ?? {}) as GitHubWebhookPayload;
    const fullName = str(p.repository?.full_name);
    if (fullName) return fullName;
    const installationId = num(p.installation?.id);
    return installationId !== undefined ? String(installationId) : null;
  },

  /**
   * AC4: an issues/pull_request webhook (open / edit / close / label / field change) → a
   * single high-confidence metadata candidate (NO raw body). A replayed delivery is a safe
   * no-op: the same issue/PR id yields the same source_record_id, so the candidate
   * (source_id, source_record_id, version) ON CONFLICT drops the duplicate at the write
   * boundary. Other event shapes (ping, push, etc.) carry no issue/PR object → return []
   * (the receiver 202-acks an empty land).
   *
   * `_source` is accepted (interface contract) but ignored — GitHub_kb ingests every
   * issue/PR on the connected repo (no per-source allowlist beyond the source mapping).
   */
  normalize(payload, _source): NormalizedRecord[] {
    const p = (asRecord(payload) ?? {}) as GitHubWebhookPayload;

    // The webhook routing key determines the kind directly: an `issues` event carries
    // `issue`; a `pull_request` event carries `pull_request`. (A PR webhook object does NOT
    // carry a nested `pull_request` marker, so we must not infer the kind from the object.)
    let item: GitHubIssue | null = null;
    let kind: ItemKind = 'issue';
    if (asRecord(p.issue)) {
      item = p.issue as GitHubIssue;
      kind = 'issue';
    } else if (asRecord(p.pull_request)) {
      item = p.pull_request as GitHubIssue;
      kind = 'pr';
    }
    if (!item) return [];
    const record = recordForItem(item, kind);
    return record ? [record] : [];
  },

  /**
   * AC4: map a (already-minimized) record to a high-confidence candidate. version omitted →
   * defaults to '1' (the idempotency key is (source, source_record_id, 1); the kind:id
   * source_record_id is already globally unique + deterministic). The body was already
   * dropped by minimize; proposed_markdown is the redacted structural summary.
   */
  toCandidate(record, sourceId): ConnectorCandidateItem {
    return {
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      provider: PROVIDER,
      proposed_slug: record.proposedSlug,
      proposed_markdown: record.item.summary,
      confidence: 0.9,
    };
  },

  /**
   * AC4: outbound backfill. Incremental list of issues+PRs updated since the watermark via
   * `GET /repos/{owner}/{repo}/issues?since=<watermark>&state=all`, landing each through the
   * SAME landRecords redaction path. A conditional `If-None-Match: <etag>` request makes a
   * no-change poll a cheap `304 Not Modified` → no-op (no candidate, watermark/ETag
   * unchanged). The watermark (newest updated_at) + the fresh ETag persist via a surgical
   * jsonb_set so a sibling config write is never clobbered, and a resumed run re-fetches
   * nothing newer (landRecords' ON CONFLICT makes any overlap a safe no-op).
   *
   * Auth is a GitHub App installation token (getInstallationToken), NOT a user OAuth grant.
   */
  async backfill(_engine: BrainEngine, source: ConnectorSource): Promise<number> {
    const { landRecords } = await import('./base.ts');
    const repo = readRepoFullName(source);
    if (!repo) {
      throw new Error(`github_kb: missing repo full_name in config.connectors.github_kb for source '${source.id}'`);
    }
    const token = await getInstallationToken(source);
    const watermark = readBackfillWatermark(source);
    const etag = readBackfillEtag(source);

    const page = await fetchIssuesPage(token, repo, watermark, etag);
    // 304 Not Modified: nothing changed since the stored ETag. No candidate, no watermark
    // move — a true no-op.
    if (page.notModified) return 0;

    const records: NormalizedRecord[] = [];
    let newestUpdatedAt = watermark;
    for (const item of page.items) {
      // The issues-list endpoint returns both issues and PRs; a PR row carries a
      // `pull_request` marker, so kind is inferred from the row here (no routing key).
      const record = recordForItem(item, kindFromIssuesRow(item));
      if (record) records.push(record);
      // Only advance the watermark on a PARSEABLE RFC3339 updated_at: an empty/garbage value
      // that sorts lexically highest would otherwise become the next `since` cursor and earn a
      // 422 that wedges this source's backfill. A row with an unparseable timestamp still lands
      // as a candidate (above) — it just doesn't move the cursor.
      const u = str(item.updated_at);
      if (u && Number.isFinite(Date.parse(u)) && (!newestUpdatedAt || u > newestUpdatedAt)) {
        newestUpdatedAt = u;
      }
    }
    const result = await landRecords(_engine, source.id, this, records);

    // Persist the advanced watermark + the fresh ETag so the next poll is conditional and
    // resumes after the newest record. Both writes are surgical (jsonb_set) — no clobber.
    if (newestUpdatedAt && newestUpdatedAt !== watermark) {
      await writeBackfillWatermark(_engine, source, newestUpdatedAt);
    }
    if (page.etag && page.etag !== etag) {
      await writeBackfillEtag(_engine, source, page.etag);
    }

    return result.written;
  },
};

// ── Per-source config (sources.config.connectors.github_kb.*) ─────────────────────

function safeParseConfig(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function githubConfig(source: ConnectorSource): Record<string, unknown> | null {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  return asRecord(connectors?.[PROVIDER]);
}

/** The per-source App installation id (config.connectors.github_kb.installation_id). */
export function readInstallationId(source: ConnectorSource): string | null {
  const v = githubConfig(source)?.installation_id;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

/** Valid GitHub "owner/name" shape — alphanumerics plus . _ - in each of the two segments. */
const REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;

/** The repo to back-fill, as "owner/name" (config.connectors.github_kb.repo or .account).
 *  Validated against the owner/name shape: the value is interpolated into the issues-list URL
 *  path, so a config typo carrying `?`, `#`, or `../` would mangle the request (or traverse
 *  the API path) rather than fail cleanly. An operator misconfig throws loud here. */
export function readRepoFullName(source: ConnectorSource): string | null {
  const cfg = githubConfig(source);
  const repo = str(cfg?.repo) ?? str(cfg?.account) ?? null;
  if (repo !== null && !REPO_FULL_NAME_RE.test(repo)) {
    throw new Error(
      `github_kb: repo '${repo}' is not a valid "owner/name" for source '${source.id}' ` +
        `(config.connectors.github_kb.repo/account)`,
    );
  }
  return repo;
}

/** Read the persisted `updated_at` watermark, or null on first run. */
export function readBackfillWatermark(source: ConnectorSource): string | null {
  return str(githubConfig(source)?.backfill_cursor) ?? null;
}

/** Read the persisted issues-list ETag, or null on first run. */
export function readBackfillEtag(source: ConnectorSource): string | null {
  return str(githubConfig(source)?.backfill_etag) ?? null;
}

/**
 * Persist ONLY the watermark via a surgical jsonb_set against the CURRENT row, leaving every
 * sibling config key intact — the same lost-update-safe pattern as Linear's watermark write.
 * (The parent objects connectors.github_kb must exist; the connect/enable flow always
 * creates them before a backfill can run.)
 */
export async function writeBackfillWatermark(
  engine: BrainEngine,
  source: ConnectorSource,
  watermark: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET config = jsonb_set(config, '{connectors,github_kb,backfill_cursor}', to_jsonb($1::text), true)
      WHERE id = $2`,
    [watermark, source.id],
  );
}

/** Persist ONLY the issues-list ETag via a surgical jsonb_set (same no-clobber pattern). */
export async function writeBackfillEtag(
  engine: BrainEngine,
  source: ConnectorSource,
  etag: string,
): Promise<void> {
  await engine.executeRaw(
    `UPDATE sources
        SET config = jsonb_set(config, '{connectors,github_kb,backfill_etag}', to_jsonb($1::text), true)
      WHERE id = $2`,
    [etag, source.id],
  );
}

// ── GitHub issues-list backfill query ──────────────────────────────────────────────

interface GitHubIssuesPage {
  items: GitHubIssue[];
  etag: string | null;
  /** True when GitHub answered 304 Not Modified (the conditional-request no-op). */
  notModified: boolean;
}

/**
 * Fetch issues+PRs updated since the watermark, with a conditional `If-None-Match` request.
 * `token` is a BARE installation token; this function prepends `Bearer `. A `304 Not
 * Modified` returns `{ items: [], notModified: true }` (no candidate landed). Pure HTTP via
 * fetch (mockable in tests).
 *
 * NOTE: `repo` is "owner/name", validated against REPO_FULL_NAME_RE at read time
 * (readRepoFullName), so its two path segments are safe to interpolate directly.
 */
export async function fetchIssuesPage(
  token: string,
  repo: string,
  updatedAfter: string | null,
  etag: string | null,
): Promise<GitHubIssuesPage> {
  const params = new URLSearchParams({
    state: 'all',
    sort: 'updated',
    direction: 'asc',
    per_page: String(BACKFILL_PAGE_SIZE),
  });
  if (updatedAfter) params.set('since', updatedAfter);

  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
  };
  // Conditional request: a no-change poll returns 304 and does not count against the
  // primary rate limit.
  if (etag) headers['if-none-match'] = etag;

  const res = await fetch(`${GITHUB_API_BASE}/repos/${repo}/issues?${params.toString()}`, {
    method: 'GET',
    headers,
  });

  if (res.status === 304) {
    return { items: [], etag, notModified: true };
  }
  if (!res.ok) {
    throw new Error(`github issues list ${res.status}: ${await safeText(res)}`);
  }
  const items = (await res.json()) as GitHubIssue[];
  const freshEtag = res.headers.get('etag');
  return { items: Array.isArray(items) ? items : [], etag: freshEtag, notModified: false };
}

// ── Webhook HMAC signing helper (exported for tests + symmetry with serve-http) ───

/**
 * Compute the `sha256=`-prefixed X-Hub-Signature-256 header value GitHub would send for a
 * body+secret. Exported so tests sign fixtures with the same primitive the receiver
 * verifies against (mirrors the connector-linear sign helper).
 */
export function signGitHubWebhook(rawBody: Buffer, secret: string): string {
  return `${SIGNATURE_PREFIX}${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

// ── Registration (side-effecting at module load) ─────────────────────────────────
//
// NO registerOAuthProvider — GitHub App installation-token auth is NOT the user OAuth flow
// the other connectors register. The connector is registered so the generic
// /webhooks/:provider receiver routes `/webhooks/github_kb` to it (the git-sync
// /webhooks/github route is untouched).

registerConnector(githubConnector);
