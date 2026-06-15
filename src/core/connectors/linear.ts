/**
 * linear.ts — the Linear SaaSConnector (TECH-2035).
 *
 * The first real connector and the template for the rest. It turns Linear webhook
 * deliveries (Issue / Comment / Project / status changes) into table-only
 * connector_candidates rows via the framework's landRecords redaction choke point —
 * NEVER pages, never a promotion. For material status/field changes it ALSO emits a
 * typed redacted rationale "take" (decision / commitment / objection / action_item /
 * open_question) as a SECOND candidate, because the `takes`/`take_proposals` tables are
 * page-bound (page_id / page_slug NOT NULL) and a connector may not write pages — so the
 * take rides as a redacted, table-only candidate carrying its take type in metadata.
 *
 * Webhook auth (AC3): Linear signs the raw body with HMAC-SHA256 and sends the hex
 * digest in the `Linear-Signature` header (NO `sha256=` prefix), plus a
 * `webhookTimestamp` (epoch ms) in the JSON body. verifyWebhook enforces BOTH a
 * constant-time HMAC compare (reusing hmacSha256Verify) AND a ±60s timestamp window,
 * so a replayed-but-validly-signed delivery outside the window is rejected.
 *
 * OAuth + backfill (AC2): actor=app OAuth (24h access tokens + refresh, scope `read`),
 * registered with the custody module (TECH-2033) at module load. backfill() pages
 * Linear's GraphQL API with `filter: { updatedAt: { gt } }` + a cursor, persisting the
 * watermark under sources.config.connectors.linear.backfill_cursor so a resumed run
 * yields no duplicates (and landRecords' ON CONFLICT makes a re-fetch a safe no-op).
 *
 * The credentials import is the TECH-2033 contract; this branch ships a type-only
 * stub at ./credentials.ts (drop at merge). Tests mock getValidAccessToken + the
 * Linear GraphQL API (recorded fixtures) — no real custody module required.
 */

import {
  hmacSha256Verify,
  registerConnector,
  type SaaSConnector,
  type NormalizedRecord,
  type ConnectorSource,
} from './base.ts';
import type { ConnectorCandidateItem } from './candidate.ts';
import type { BrainEngine } from '../engine.ts';
import {
  getValidAccessToken,
  registerOAuthProvider,
  type StoredToken,
} from './credentials.ts';

// ── Linear payload shapes (the subset we read) ──────────────────────────────────

/** A Linear webhook delivery envelope. */
export interface LinearWebhookPayload {
  /** create | update | remove. */
  action?: string;
  /** Entity type: Issue | Comment | Project | … */
  type?: string;
  /** The entity snapshot. */
  data?: Record<string, unknown>;
  /** Field-level diff for update actions (present on status/field changes). */
  updatedFrom?: Record<string, unknown>;
  /** Workspace/org id — the account anchor. */
  organizationId?: string;
  /** Anti-replay timestamp (epoch ms). */
  webhookTimestamp?: number;
  /** Delivery id (NOT used for idempotency — non-deterministic). */
  webhookId?: string;
}

/** The take types AC4 enumerates. */
export type LinearTakeType =
  | 'decision'
  | 'commitment'
  | 'objection'
  | 'action_item'
  | 'open_question';

// ── Constants ───────────────────────────────────────────────────────────────────

const PROVIDER = 'linear';
const SIGNATURE_HEADER = 'linear-signature'; // lowercase — Node lowercases header keys
/** Anti-replay window for webhookTimestamp (AC3). */
const TIMESTAMP_WINDOW_MS = 60_000;
/** Linear OAuth + GraphQL endpoints (actor=app, scope read). */
const LINEAR_OAUTH_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
const LINEAR_OAUTH_TOKEN_URL = 'https://api.linear.app/oauth/token';
const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
const LINEAR_OAUTH_SCOPE = 'read';
/** 24h access-token lifetime (ms) used when the token response omits expires_in. */
const LINEAR_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const BACKFILL_PAGE_SIZE = 50;

// ── OAuth provider registration (actor=app, 24h tokens + refresh, scope read) ────

/** Map a Linear OAuth token response onto the custody StoredToken shape. */
function tokenFromOAuthResponse(json: Record<string, unknown>): StoredToken {
  const accessToken = typeof json.access_token === 'string' ? json.access_token : '';
  const refreshToken = typeof json.refresh_token === 'string' ? json.refresh_token : undefined;
  const expiresInSec = typeof json.expires_in === 'number' ? json.expires_in : LINEAR_TOKEN_TTL_MS / 1000;
  const scope = typeof json.scope === 'string' ? json.scope : LINEAR_OAUTH_SCOPE;
  const tokenType = typeof json.token_type === 'string' ? json.token_type : 'Bearer';
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + expiresInSec * 1000,
    scope,
    tokenType,
  };
}

/** POST an x-www-form-urlencoded body to Linear's token endpoint. */
async function postTokenForm(body: Record<string, string>): Promise<StoredToken> {
  const res = await fetch(LINEAR_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    throw new Error(`linear oauth token endpoint ${res.status}: ${await safeText(res)}`);
  }
  return tokenFromOAuthResponse((await res.json()) as Record<string, unknown>);
}

/**
 * Register Linear's actor=app OAuth config with the custody module. Side-effecting at
 * module load (mirrors registerConnector). The client id/secret come from the
 * environment — the custody module owns persistence; the connector owns the wire shape.
 */
export function registerLinearOAuth(): void {
  registerOAuthProvider(PROVIDER, {
    authorizeUrl: ({ state, redirectUri, scope }) => {
      const params = new URLSearchParams({
        client_id: process.env.LINEAR_CLIENT_ID ?? '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: scope ?? LINEAR_OAUTH_SCOPE,
        state,
        // actor=app: the integration acts as itself, not on behalf of a user.
        actor: 'app',
      });
      return `${LINEAR_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    },
    exchangeCode: ({ code, redirectUri }) =>
      postTokenForm({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: process.env.LINEAR_CLIENT_ID ?? '',
        client_secret: process.env.LINEAR_CLIENT_SECRET ?? '',
      }),
    refresh: (token) =>
      postTokenForm({
        grant_type: 'refresh_token',
        refresh_token: token.refreshToken ?? '',
        client_id: process.env.LINEAR_CLIENT_ID ?? '',
        client_secret: process.env.LINEAR_CLIENT_SECRET ?? '',
      }),
  });
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 256);
  } catch {
    return '(unreadable body)';
  }
}

// ── Helpers: payload field access (defensive against unknown) ────────────────────

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Pull a stable upstream id from an entity snapshot. */
function recordId(data: Record<string, unknown>): string | undefined {
  return str(data.id) ?? str(data.identifier);
}

/** Resolve the redaction profile for a Linear entity. Issues/comments are work
 *  discourse (code class — keeps repo/number/author/state/url/labels/timestamps);
 *  projects/docs fall to docs. Unknown → generic (still allowlisted, fail-closed). */
function profileForType(type: string | undefined): string {
  switch (type) {
    case 'Issue':
    case 'Comment':
      return 'code';
    case 'Project':
    case 'Document':
      return 'docs';
    default:
      return 'generic';
  }
}

/**
 * Did this update carry a MATERIAL status or field change worth a rationale take?
 * Linear sends `updatedFrom` with the prior values of changed fields on `update`
 * actions. We treat a change to state/status, assignee, priority, or project as
 * material (the fields that move a decision/commitment/owner).
 */
const MATERIAL_FIELDS = ['stateId', 'state', 'assigneeId', 'priority', 'projectId'] as const;

function materialChange(payload: LinearWebhookPayload): boolean {
  if (payload.action !== 'update') return false;
  const from = asRecord(payload.updatedFrom);
  if (!from) return false;
  return MATERIAL_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(from, f));
}

/**
 * Classify a material change into a take type. Deterministic, payload-driven:
 *  - a new state whose type is 'completed'/'canceled' → decision (the issue resolved)
 *  - an assignee change with a now-set owner → commitment (owner takes it on)
 *  - a priority raise → action_item (work pulled forward)
 *  - otherwise → open_question (a change happened; rationale unknown)
 * 'objection' is reserved for explicit blocker/cancel signals.
 */
function classifyTake(payload: LinearWebhookPayload): { type: LinearTakeType; owner: string } {
  const data = asRecord(payload.data) ?? {};
  const from = asRecord(payload.updatedFrom) ?? {};

  const stateType = str(asRecord(data.state)?.type) ?? str(data.stateType);
  if ('stateId' in from || 'state' in from) {
    if (stateType === 'canceled') return { type: 'objection', owner: ownerOf(data) };
    if (stateType === 'completed') return { type: 'decision', owner: ownerOf(data) };
  }
  if (('assigneeId' in from || 'assignee' in from) && (str(data.assigneeId) || asRecord(data.assignee))) {
    return { type: 'commitment', owner: ownerOf(data) };
  }
  if ('priority' in from) return { type: 'action_item', owner: ownerOf(data) };
  return { type: 'open_question', owner: ownerOf(data) };
}

/** Best-effort owner extraction (assignee name/id), for commitment takes. */
function ownerOf(data: Record<string, unknown>): string {
  const assignee = asRecord(data.assignee);
  return (
    str(assignee?.name) ??
    str(assignee?.displayName) ??
    str(data.assigneeId) ??
    str(asRecord(data.creator)?.name) ??
    'unassigned'
  );
}

/** A short, human summary line for a Linear entity (body is dropped by minimize). */
function summaryFor(type: string | undefined, data: Record<string, unknown>): string {
  const title = str(data.title) ?? str(data.name) ?? str(data.body)?.slice(0, 140);
  const identifier = str(data.identifier);
  const label = identifier ? `${identifier}` : (type ?? 'record');
  return title ? `${label}: ${title}` : label;
}

// ── The connector ────────────────────────────────────────────────────────────────

export const linearConnector: SaaSConnector = {
  provider: PROVIDER,
  signatureHeader: SIGNATURE_HEADER,

  /**
   * AC3: HMAC-SHA256 over the raw body, hex digest in `Linear-Signature` (no prefix),
   * constant-time compare — PLUS a ±60s webhookTimestamp window. Both must pass.
   * Fail-closed on any parse/shape error.
   */
  verifyWebhook(rawBody, headers, secret): boolean {
    const signature = headers[SIGNATURE_HEADER];
    if (!signature) return false;
    // Constant-time HMAC compare first (reuses the framework primitive).
    if (!hmacSha256Verify(rawBody, secret, signature)) return false;
    // Anti-replay: webhookTimestamp must be within ±60s of now. A validly-signed
    // but stale (replayed) delivery is rejected.
    let ts: number | undefined;
    try {
      const parsed = JSON.parse(rawBody.toString('utf8')) as LinearWebhookPayload;
      ts = typeof parsed.webhookTimestamp === 'number' ? parsed.webhookTimestamp : undefined;
    } catch {
      return false;
    }
    if (ts === undefined) return false;
    return Math.abs(Date.now() - ts) <= TIMESTAMP_WINDOW_MS;
  },

  /** AC1: resolve the workspace/org id the source is mapped to. */
  accountFromPayload(payload): string | null {
    const p = asRecord(payload);
    return p ? (str(p.organizationId) ?? null) : null;
  },

  /**
   * AC4: Issue/Comment/Project/status-change → a high-confidence candidate. For a
   * MATERIAL status/field change, ALSO emit a typed redacted rationale take as a
   * second record. Both flow through landRecords (minimize + redact + table-only).
   */
  normalize(payload): NormalizedRecord[] {
    const p = (asRecord(payload) ?? {}) as LinearWebhookPayload;
    const data = asRecord(p.data);
    if (!data) return [];
    const id = recordId(data);
    if (!id) return [];

    const type = str(p.type);
    const profile = profileForType(type);
    const summary = summaryFor(type, data);

    const metadata: Record<string, unknown> = {
      // snake_case, case-sensitive — matched against redact.ts profile allowlists.
      number: str(data.identifier) ?? str(data.number),
      author: ownerOf(data),
      state: str(asRecord(data.state)?.name) ?? str(data.stateType),
      url: str(data.url),
      labels: Array.isArray(data.labelIds) ? data.labelIds : undefined,
      updated_at: str(data.updatedAt),
      created_at: str(data.createdAt),
    };

    const records: NormalizedRecord[] = [
      {
        sourceRecordId: id,
        profile,
        item: { sourceRecordId: id, metadata, summary, body: str(data.description) ?? str(data.body) },
        proposedSlug: `linear-${type?.toLowerCase() ?? 'record'}-${id}`,
      },
    ];

    // AC4: typed rationale take on material change — a SECOND table-only candidate,
    // carrying its take type + owner in (allowlisted) metadata. The take's own
    // text/owner are redacted by landRecords just like any other candidate.
    if (materialChange(p)) {
      const { type: takeType, owner } = classifyTake(p);
      const takeId = `${id}:take:${takeType}`;
      records.push({
        sourceRecordId: takeId,
        profile,
        item: {
          sourceRecordId: takeId,
          // url/author/state survive the profile allowlist; take_type/owner are
          // intentionally non-allowlisted structural tags carried for the reviewer —
          // they are DROPPED by minimize (fail-closed) and re-expressed in the summary,
          // which is the redacted, human-readable rationale line.
          metadata: {
            url: str(data.url),
            author: owner,
            state: str(asRecord(data.state)?.name) ?? str(data.stateType),
            updated_at: str(data.updatedAt),
          },
          summary: `[${takeType}] ${owner}: ${summary}`,
          body: str(data.description) ?? str(data.body),
        },
        proposedSlug: `linear-take-${takeType}-${id}`,
      });
    }

    return records;
  },

  /**
   * AC4: map a (already-minimized) record to a candidate. High confidence for the
   * primary record; the take record is distinguished by its slug. version omitted →
   * defaults to '1' (deterministic — idempotency key is (source, source_record_id, 1)).
   */
  toCandidate(record, sourceId): ConnectorCandidateItem {
    const isTake = record.sourceRecordId.includes(':take:');
    return {
      source_id: sourceId,
      source_record_id: record.sourceRecordId,
      provider: PROVIDER,
      proposed_slug: record.proposedSlug,
      // The body was already dropped by minimize; the summary is the redacted rationale.
      proposed_markdown: record.item.summary,
      confidence: isTake ? 0.85 : 0.9,
    };
  },

  /**
   * AC2: outbound backfill. Pages Linear's GraphQL API with
   * `filter: { updatedAt: { gt: <watermark> } }` + cursor pagination, landing each
   * page through the SAME landRecords redaction path. Advances the watermark in
   * sources.config.connectors.linear.backfill_cursor so a resumed run yields no
   * duplicates (and landRecords' ON CONFLICT makes any overlap a safe no-op).
   */
  async backfill(engine: BrainEngine, source: ConnectorSource): Promise<number> {
    const { landRecords } = await import('./base.ts');
    const token = await getValidAccessToken(engine, source.id, PROVIDER);
    const watermark = readBackfillWatermark(source);

    let cursor: string | null = null;
    let landed = 0;
    let newestUpdatedAt = watermark;

    do {
      const page = await fetchIssuesPage(token, watermark, cursor);
      const records: NormalizedRecord[] = [];
      for (const issue of page.nodes) {
        const norm = this.normalize({
          type: 'Issue',
          action: 'backfill',
          data: issue,
          organizationId: undefined,
        });
        records.push(...norm);
        const u = str(issue.updatedAt);
        if (u && (!newestUpdatedAt || u > newestUpdatedAt)) newestUpdatedAt = u;
      }
      const result = await landRecords(engine, source.id, this, records);
      landed += result.written;
      cursor = page.hasNextPage ? page.endCursor : null;
    } while (cursor);

    // Persist the advanced watermark so the next run resumes after the newest record.
    if (newestUpdatedAt && newestUpdatedAt !== watermark) {
      await writeBackfillWatermark(engine, source, newestUpdatedAt);
    }

    return landed;
  },
};

// ── Backfill watermark persistence (sources.config.connectors.linear.*) ──────────

/** Read the persisted `updatedAt` watermark, or null on first run. */
export function readBackfillWatermark(source: ConnectorSource): string | null {
  const raw = typeof source.config === 'string' ? safeParseConfig(source.config) : source.config;
  const connectors = asRecord(raw?.connectors);
  const linear = asRecord(connectors?.[PROVIDER]);
  return str(linear?.backfill_cursor) ?? null;
}

/** Merge the new watermark into sources.config and persist via UPDATE … ::jsonb. */
export async function writeBackfillWatermark(
  engine: BrainEngine,
  source: ConnectorSource,
  watermark: string,
): Promise<void> {
  const raw =
    (typeof source.config === 'string' ? safeParseConfig(source.config) : source.config) ?? {};
  const cfg: Record<string, unknown> = { ...raw };
  const connectors: Record<string, unknown> = { ...(asRecord(cfg.connectors) ?? {}) };
  const linear: Record<string, unknown> = { ...(asRecord(connectors[PROVIDER]) ?? {}) };
  linear.backfill_cursor = watermark;
  connectors[PROVIDER] = linear;
  cfg.connectors = connectors;
  await engine.executeRaw(`UPDATE sources SET config = $1::jsonb WHERE id = $2`, [
    JSON.stringify(cfg),
    source.id,
  ]);
}

function safeParseConfig(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── Linear GraphQL backfill query ────────────────────────────────────────────────

interface LinearIssuesPage {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Fetch one page of issues updated after the watermark, ordered by updatedAt asc, with
 * cursor pagination. Uses the OAuth bearer token. Pure HTTP via fetch (mockable in tests).
 */
export async function fetchIssuesPage(
  token: string,
  updatedAfter: string | null,
  cursor: string | null,
): Promise<LinearIssuesPage> {
  const query = `
    query Backfill($after: String, $first: Int!, $filter: IssueFilter) {
      issues(after: $after, first: $first, filter: $filter, orderBy: updatedAt) {
        nodes {
          id identifier title description url priority
          createdAt updatedAt
          state { name type }
          assignee { name displayName }
          labelIds
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  const variables = {
    after: cursor,
    first: BACKFILL_PAGE_SIZE,
    filter: updatedAfter ? { updatedAt: { gt: updatedAfter } } : undefined,
  };
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: token,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`linear graphql ${res.status}: ${await safeText(res)}`);
  }
  const json = (await res.json()) as {
    data?: { issues?: { nodes?: Record<string, unknown>[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } };
    errors?: unknown;
  };
  if (json.errors) {
    throw new Error(`linear graphql errors: ${JSON.stringify(json.errors).slice(0, 256)}`);
  }
  const issues = json.data?.issues;
  return {
    nodes: issues?.nodes ?? [],
    hasNextPage: issues?.pageInfo?.hasNextPage === true,
    endCursor: issues?.pageInfo?.endCursor ?? null,
  };
}

// ── Registration (side-effecting at module load) ─────────────────────────────────

registerConnector(linearConnector);
registerLinearOAuth();
